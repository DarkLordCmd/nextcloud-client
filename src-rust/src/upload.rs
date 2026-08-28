use std::convert::Infallible;
use std::io::SeekFrom;
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::{
    Json,
    body::Body,
    extract::{Query, State},
    http::{HeaderMap, header::CONTENT_LENGTH},
    response::sse::{Event, KeepAlive, Sse},
};
use bytes::Bytes;
use futures::{Stream, StreamExt, TryStreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::sync::{Mutex, broadcast};
use tokio_stream::wrappers::BroadcastStream;

use crate::{
    auth::AuthState,
    models::{ApiOk, AppError, ProgressEvent},
    nextcloud::{self, dav_method},
    server::AppState,
};

#[derive(Deserialize)]
pub struct UploadQuery {
    pub path: Option<String>,
    pub name: Option<String>,
}

/// Minimum interval between progress events sent over SSE.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);
/// Chunk size used for NextCloud chunked upload v2 (server-side cap is 10 MiB).
const CHUNK_SIZE: u64 = 8 * 1024 * 1024;
/// Number of chunk PUTs performed in parallel.
const UPLOAD_CONCURRENCY: usize = 4;

/// `POST /api/files/upload?path=/dir&name=file.bin` — stream the raw request
/// body to NextCloud. Small files use a single WebDAV PUT; files larger than
/// one chunk use NextCloud's chunked upload v2 (parallel part uploads +
/// server-side assembly via MOVE).
pub async fn upload_file(
    State(state): State<AppState>,
    Query(params): Query<UploadQuery>,
    headers: HeaderMap,
    body: Body,
) -> Result<Json<ApiOk<Value>>, AppError> {
    let dest_dir = nextcloud::normalize_path(params.path.as_deref().unwrap_or("/"));
    let name = params.name.as_deref().unwrap_or("file");
    if name.trim().is_empty() || name.contains('/') || name.contains('\\') {
        return Err(AppError::BadRequest("Invalid file name.".into()));
    }
    let auth = nextcloud::require_auth(&state).await?;

    let total = headers
        .get(CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);
    let id = format!("upload-{}", state.next_id.fetch_add(1, Ordering::SeqCst));
    let url = nextcloud::dav_url(&auth, &nextcloud::rel_path(&dest_dir, name));

    let _ = state.progress_tx.send(ProgressEvent {
        id: id.clone(),
        kind: "progress".to_string(),
        filename: Some(name.to_string()),
        bytes_done: Some(0),
        bytes_total: Some(total),
        percent: Some(0),
        error: None,
    });

    let result = if total > CHUNK_SIZE {
        chunked_upload(&state, &auth, &url, name, body, total, &id).await
    } else {
        simple_upload(&state, &auth, &url, name, body, total, &id).await
    };

    match result {
        Ok(()) => {
            let _ = state.progress_tx.send(ProgressEvent {
                id,
                kind: "done".to_string(),
                filename: Some(name.to_string()),
                bytes_done: Some(total),
                bytes_total: Some(total),
                percent: Some(100),
                error: None,
            });
            tracing::info!(name = %name, path = %dest_dir, size = total, "upload complete");
            Ok(Json(ApiOk::new(json!({ "files": [name], "path": dest_dir }))))
        }
        Err(err) => {
            tracing::error!(name = %name, path = %dest_dir, error = %err, "upload failed");
            let _ = state.progress_tx.send(ProgressEvent {
                id,
                kind: "error".to_string(),
                filename: Some(name.to_string()),
                bytes_done: None,
                bytes_total: None,
                percent: None,
                error: Some(err.to_string()),
            });
            Err(err)
        }
    }
}

// ---------------------------------------------------------------------------
// Direct (single PUT) upload
// ---------------------------------------------------------------------------

async fn simple_upload(
    state: &AppState,
    auth: &AuthState,
    url: &str,
    name: &str,
    body: Body,
    total: u64,
    id: &str,
) -> Result<(), AppError> {
    let stream = body
        .into_data_stream()
        .map_err(|e| std::io::Error::other(e.to_string()));
    let stream = with_progress(
        stream,
        state.progress_tx.clone(),
        id.to_string(),
        name.to_string(),
        total,
        limiter(state),
    );

    let resp = state
        .http
        .put(url)
        .basic_auth(&auth.username, Some(&auth.password))
        .body(reqwest::Body::wrap_stream(stream))
        .send()
        .await?;
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        return Err(nextcloud::status_error(status, &text));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Chunked upload v2
// ---------------------------------------------------------------------------

async fn chunked_upload(
    state: &AppState,
    auth: &AuthState,
    dest_url: &str,
    name: &str,
    body: Body,
    total: u64,
    id: &str,
) -> Result<(), AppError> {
    let transfer_id = format!(
        "nc-{}-{}",
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or_default(),
        state.next_id.fetch_add(1, Ordering::SeqCst)
    );
    let uploads_dir = format!(
        "{}{}/",
        nextcloud::dav_uploads_base(auth),
        nextcloud::encode_segment(&transfer_id)
    );
    let temp_path = std::env::temp_dir().join(format!("nextcloud-upload-{transfer_id}.tmp"));
    let temp_str = temp_path.to_string_lossy().into_owned();

    // Create the transfer session.
    let resp = nextcloud::dav_request(
        &state.http,
        auth,
        dav_method("MKCOL"),
        &uploads_dir,
        &[],
        None,
    )
    .await?;
    let _ = resp;

    let result = run_chunked(
        state,
        auth,
        dest_url,
        name,
        body,
        total,
        id,
        &uploads_dir,
        &temp_str,
    )
    .await;

    // Best-effort cleanup of the local temp file.
    let _ = tokio::fs::remove_file(&temp_path).await;
    if let Err(e) = &result {
        // Remove the transfer session on the server.
        let _ = nextcloud::dav_request(
            &state.http,
            auth,
            dav_method("DELETE"),
            &uploads_dir,
            &[],
            None,
        )
        .await;
        return Err(e.clone());
    }
    Ok(())
}

async fn run_chunked(
    state: &AppState,
    auth: &AuthState,
    dest_url: &str,
    name: &str,
    body: Body,
    total: u64,
    id: &str,
    uploads_dir: &str,
    temp_str: &str,
) -> Result<(), AppError> {
    let mut emitter =
        ProgressEmitter::new(state.progress_tx.clone(), id.to_string(), name.to_string(), total);
    let limit = limiter(state);

    // Phase 1: receive the client stream into a temp file (0-50% progress).
    let mut file = tokio::fs::File::create(temp_str)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to create temp file: {e}")))?;
    let mut received: u64 = 0;
    let mut stream = body.into_data_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk
            .map_err(|e| AppError::Internal(format!("Failed to read upload body: {e}")))?;
        file.write_all(&chunk)
            .await
            .map_err(|e| AppError::Internal(format!("Failed to write temp file: {e}")))?;
        received += chunk.len() as u64;
        let percent = if total == 0 {
            0
        } else {
            ((received as f64 / total as f64) * 50.0) as u32
        };
        emitter.emit(received, percent);
    }
    file.flush()
        .await
        .map_err(|e| AppError::Internal(format!("Failed to flush temp file: {e}")))?;
    drop(file);

    // Phase 2: upload parts in parallel (50-100% progress).
    let part_count = total.div_ceil(CHUNK_SIZE);
    let parts = (0..part_count).map(|i| {
        let temp_str = temp_str.to_string();
        let uploads_dir = uploads_dir.to_string();
        let client = state.http.clone();
        let auth = auth.clone();
        let limit = limit.clone();
        async move {
            let bytes = read_part(&temp_str, i, CHUNK_SIZE).await?;
            let len = bytes.len() as u64;
            if let Some(bucket) = &limit {
                bucket.lock().await.acquire(len).await;
            }
            let url = format!("{uploads_dir}{i}");
            let resp = nextcloud::dav_request(
                &client,
                &auth,
                dav_method("PUT"),
                &url,
                &[],
                Some(reqwest::Body::from(bytes)),
            )
            .await?;
            let _ = resp;
            Ok::<u64, AppError>(len)
        }
    });

    let mut uploaded: u64 = 0;
    let mut part_stream = futures::stream::iter(parts).buffer_unordered(UPLOAD_CONCURRENCY);
    while let Some(part_len) = part_stream.next().await {
        uploaded += part_len?;
        let percent = if total == 0 {
            0
        } else {
            50 + ((uploaded as f64 / total as f64) * 50.0) as u32
        };
        emitter.emit(uploaded, percent);
    }

    // Phase 3: assemble the chunks on the server via MOVE of the virtual `.file`.
    let assemble_url = format!("{uploads_dir}.file");
    let resp = nextcloud::dav_request(
        &state.http,
        auth,
        dav_method("MOVE"),
        &assemble_url,
        &[("Destination", dest_url), ("Overwrite", "F")],
        None,
    )
    .await?;
    let _ = resp;
    Ok(())
}

/// Read one chunk-sized part from the temp file at `index * chunk_size`.
async fn read_part(path: &str, index: u64, chunk_size: u64) -> Result<Vec<u8>, AppError> {
    let mut f = tokio::fs::File::open(path)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to open temp file: {e}")))?;
    f.seek(SeekFrom::Start(index * chunk_size))
        .await
        .map_err(|e| AppError::Internal(format!("Failed to seek temp file: {e}")))?;
    let mut buf = vec![0u8; chunk_size as usize];
    let mut filled = 0usize;
    while filled < buf.len() {
        let n = f.read(&mut buf[filled..])
            .await
            .map_err(|e| AppError::Internal(format!("Failed to read temp file: {e}")))?;
        if n == 0 {
            break;
        }
        filled += n;
    }
    buf.truncate(filled);
    Ok(buf)
}

// ---------------------------------------------------------------------------
// Progress helpers
// ---------------------------------------------------------------------------

/// Token bucket used to cap upload throughput. Shared across concurrent part
/// uploads so the aggregate rate respects the configured limit.
struct TokenBucket {
    rate: u64,
    tokens: f64,
    last_refill: Instant,
}

impl TokenBucket {
    fn new(rate: u64) -> Self {
        Self {
            rate,
            tokens: rate as f64,
            last_refill: Instant::now(),
        }
    }

    /// Wait until `n` bytes can be sent, then consume them.
    async fn acquire(&mut self, n: u64) {
        if self.rate == 0 {
            return;
        }
        // Keep enough headroom for one full chunk so large parts never wait
        // forever at a low rate.
        let cap = (self.rate as f64 * 4.0).max(n as f64);
        loop {
            let now = Instant::now();
            self.tokens = (self.tokens
                + now.duration_since(self.last_refill).as_secs_f64() * self.rate as f64)
                .min(cap);
            self.last_refill = now;
            if self.tokens >= n as f64 {
                self.tokens -= n as f64;
                return;
            }
            let need = n as f64 - self.tokens;
            // Note: last_refill is intentionally NOT reset here so the elapsed
            // sleep time is credited on the next iteration.
            tokio::time::sleep(Duration::from_secs_f64(need / self.rate as f64)).await;
        }
    }
}

/// Build a shared limiter from the current upload cap, or `None` when unlimited.
fn limiter(state: &AppState) -> Option<Arc<Mutex<TokenBucket>>> {
    let rate = state.upload_limit.load(Ordering::SeqCst);
    if rate == 0 {
        None
    } else {
        Some(Arc::new(Mutex::new(TokenBucket::new(rate))))
    }
}

struct ProgressEmitter {
    tx: broadcast::Sender<ProgressEvent>,
    id: String,
    name: String,
    total: u64,
    last_emit: Instant,
}

impl ProgressEmitter {
    fn new(
        tx: broadcast::Sender<ProgressEvent>,
        id: String,
        name: String,
        total: u64,
    ) -> Self {
        Self {
            tx,
            id,
            name,
            total,
            last_emit: Instant::now(),
        }
    }

    fn emit(&mut self, bytes_done: u64, percent: u32) {
        let now = Instant::now();
        if now.duration_since(self.last_emit) < PROGRESS_INTERVAL && percent < 100 {
            return;
        }
        self.last_emit = now;
        let _ = self.tx.send(ProgressEvent {
            id: self.id.clone(),
            kind: "progress".to_string(),
            filename: Some(self.name.clone()),
            bytes_done: Some(bytes_done),
            bytes_total: Some(self.total),
            percent: Some(percent),
            error: None,
        });
    }
}

/// Wrap a byte stream, counting bytes, emitting throttled progress events and
/// (optionally) limiting throughput with a shared token bucket.
fn with_progress<S>(
    stream: S,
    tx: broadcast::Sender<ProgressEvent>,
    id: String,
    name: String,
    total: u64,
    limit: Option<Arc<Mutex<TokenBucket>>>,
) -> impl Stream<Item = Result<Bytes, std::io::Error>>
where
    S: Stream<Item = Result<Bytes, std::io::Error>> + Send + 'static,
{
    let stream = Box::pin(stream);
    futures::stream::unfold(
        (stream, 0u64, Instant::now()),
        move |(mut stream, mut sent, mut last_emit)| {
            let tx = tx.clone();
            let id = id.clone();
            let name = name.clone();
            let limit = limit.clone();
            async move {
                match stream.as_mut().next().await {
                    Some(Ok(chunk)) => {
                        sent += chunk.len() as u64;
                        if let Some(bucket) = &limit {
                            bucket.lock().await.acquire(chunk.len() as u64).await;
                        }
                        let now = Instant::now();
                        let percent = if total == 0 {
                            0
                        } else {
                            ((sent as f64 / total as f64) * 100.0) as u32
                        };
                        if now.duration_since(last_emit) >= PROGRESS_INTERVAL || percent == 100 {
                            last_emit = now;
                            let _ = tx.send(ProgressEvent {
                                id: id.clone(),
                                kind: "progress".to_string(),
                                filename: Some(name.clone()),
                                bytes_done: Some(sent),
                                bytes_total: Some(total),
                                percent: Some(percent),
                                error: None,
                            });
                        }
                        Some((Ok(chunk), (stream, sent, last_emit)))
                    }
                    Some(Err(e)) => Some((Err(e), (stream, sent, last_emit))),
                    None => None,
                }
            }
        },
    )
}

/// `GET /api/files/progress` — SSE stream of progress events.
pub async fn progress_sse(
    State(state): State<AppState>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let rx = state.progress_tx.subscribe();
    let stream = BroadcastStream::new(rx).filter_map(|result| async move {
        match result {
            Ok(event) => {
                let kind = event.kind.clone();
                let data = serde_json::to_string(&event).unwrap_or_else(|_| "{}".to_string());
                Some(Ok(Event::default().event(kind).data(data)))
            }
            Err(_) => None,
        }
    });
    Sse::new(stream).keep_alive(
        KeepAlive::new()
            .interval(Duration::from_secs(15))
            .text("keep-alive"),
    )
}