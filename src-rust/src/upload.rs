use std::convert::Infallible;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use axum::{
    Json,
    body::Body,
    extract::{Query, State},
    http::{HeaderMap, header::CONTENT_LENGTH},
    response::sse::{Event, KeepAlive, Sse},
};
use bytes::Bytes;
use futures::{Stream, StreamExt, TryStreamExt, task::Poll};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::broadcast;
use tokio_stream::wrappers::BroadcastStream;

use crate::{
    models::{ApiOk, AppError, ProgressEvent},
    nextcloud,
    server::AppState,
};

#[derive(Deserialize)]
pub struct UploadQuery {
    pub path: Option<String>,
    pub name: Option<String>,
}

/// Minimum interval between progress events sent over SSE.
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

/// `POST /api/files/upload?path=/dir&name=file.bin` — stream the raw request
/// body to NextCloud via WebDAV PUT, forwarding progress over SSE.
///
/// The body is never buffered into memory: it is re-chunked straight from the
/// client request into the upstream PUT request while progress is reported.
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
    let id = format!(
        "upload-{}",
        state.next_id.fetch_add(1, Ordering::SeqCst)
    );
    let url = nextcloud::dav_url(&auth, &nextcloud::rel_path(&dest_dir, name));
    let tx = state.progress_tx.clone();

    let _ = tx.send(ProgressEvent {
        id: id.clone(),
        kind: "progress".to_string(),
        filename: Some(name.to_string()),
        bytes_done: Some(0),
        bytes_total: Some(total),
        percent: Some(0),
        error: None,
    });

    let upstream = body
        .into_data_stream()
        .map_err(|e| std::io::Error::other(e.to_string()));
    let stream = with_progress(upstream, tx, id.clone(), name.to_string(), total);

    let resp = state
        .http
        .put(&url)
        .basic_auth(&auth.username, Some(&auth.password))
        .body(reqwest::Body::wrap_stream(stream))
        .send()
        .await?;
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        let err = nextcloud::status_error(status, &text);
        let _ = state.progress_tx.send(ProgressEvent {
            id: id.clone(),
            kind: "error".to_string(),
            filename: Some(name.to_string()),
            bytes_done: None,
            bytes_total: None,
            percent: None,
            error: Some(err.to_string()),
        });
        return Err(err);
    }

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

/// Wrap a byte stream, counting bytes and emitting throttled progress events.
fn with_progress<S>(
    stream: S,
    tx: broadcast::Sender<ProgressEvent>,
    id: String,
    name: String,
    total: u64,
) -> impl Stream<Item = Result<Bytes, std::io::Error>>
where
    S: Stream<Item = Result<Bytes, std::io::Error>> + Send + 'static,
{
    let mut inner = Box::pin(stream);
    let mut sent: u64 = 0;
    let mut last_emit = Instant::now();
    futures::stream::poll_fn(move |cx| match inner.as_mut().poll_next(cx) {
        Poll::Ready(Some(Ok(chunk))) => {
            sent += chunk.len() as u64;
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
            Poll::Ready(Some(Ok(chunk)))
        }
        Poll::Ready(Some(Err(e))) => Poll::Ready(Some(Err(e))),
        Poll::Ready(None) => Poll::Ready(None),
        Poll::Pending => Poll::Pending,
    })
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