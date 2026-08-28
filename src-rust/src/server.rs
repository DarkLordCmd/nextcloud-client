use std::sync::Arc;
use std::time::Duration;

use axum::{
    Json,
    extract::{Request, State},
    http::{HeaderValue, Method, StatusCode, header::AUTHORIZATION},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, patch, post, put},
    Router,
};
use serde_json::json;
use tokio::sync::{RwLock, broadcast};
use tower_http::{cors::CorsLayer, trace::TraceLayer};

use crate::{
    auth::{self, AuthState},
    download, models::ProgressEvent, nextcloud, settings, upload,
};

/// Shared application state passed to every handler via `State`.
#[derive(Clone)]
pub struct AppState {
    /// All saved accounts. In-memory copy; Electron persists the list on disk.
    pub accounts: Arc<RwLock<Vec<AuthState>>>,
    /// Index of the active account in `accounts`; `usize::MAX` when none.
    pub active: Arc<std::sync::atomic::AtomicUsize>,
    /// Shared HTTP client used for all WebDAV / OCS requests.
    pub http: reqwest::Client,
    /// Broadcast channel that fans progress events out to SSE subscribers.
    pub progress_tx: broadcast::Sender<ProgressEvent>,
    /// Monotonic counter used to generate unique operation ids.
    pub next_id: Arc<std::sync::atomic::AtomicU64>,
    /// Upload speed cap in bytes/sec. `0` means unlimited.
    pub upload_limit: Arc<std::sync::atomic::AtomicU64>,
    /// Random per-session secret. Every `/api/*` request must carry it so that
    /// only our own UI (which receives it via the Electron preload bridge) can
    /// talk to the local backend.
    pub token: String,
}

impl AppState {
    pub fn new(token: String) -> Self {
        Self {
            accounts: Arc::new(RwLock::new(Vec::new())),
            active: Arc::new(std::sync::atomic::AtomicUsize::new(usize::MAX)),
            http: build_http_client(),
            progress_tx: broadcast::channel(256).0,
            next_id: Arc::new(std::sync::atomic::AtomicU64::new(1)),
            upload_limit: Arc::new(std::sync::atomic::AtomicU64::new(0)),
            token,
        }
    }
}

/// Shared HTTP client tuned for throughput: HTTP/2 (multiplexing + adaptive
/// flow-control windows) and a healthy per-host connection pool. Falls back to
/// the plain default client if the custom builder fails.
fn build_http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .http2_adaptive_window(true)
        .http2_initial_stream_window_size(1024 * 1024)
        .http2_initial_connection_window_size(1024 * 1024)
        .pool_max_idle_per_host(8)
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

/// Reject any `/api/*` request that does not carry the session token (either
/// as `Authorization: Bearer <token>` or `?token=`). Preflights and `/health`
/// are exempt so the browser CORS handshake and the readiness probe still work.
async fn require_token(
    State(state): State<AppState>,
    req: Request,
    next: Next,
) -> Result<Response, Response> {
    if req.method() == Method::OPTIONS || req.uri().path() == "/health" {
        return Ok(next.run(req).await);
    }
    let header_ok = req
        .headers()
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|t| t == state.token.as_str())
        .unwrap_or(false);
    let query_ok = req
        .uri()
        .query()
        .map(|q| {
            q.split('&').any(|kv| {
                kv.strip_prefix("token=")
                    .map(|t| t == state.token.as_str())
                    .unwrap_or(false)
            })
        })
        .unwrap_or(false);
    if header_ok || query_ok {
        Ok(next.run(req).await)
    } else {
        Err(StatusCode::UNAUTHORIZED.into_response())
    }
}

/// Build the full HTTP router with auth token, CORS, logging and no body size limit.
pub fn build_router(state: AppState) -> Router {
    // CORS is restricted to our own origins: the Vite dev server and the
    // packaged app (which reports a `null` origin from file://).
    let cors = CorsLayer::new()
        .allow_origin(vec![
            HeaderValue::from_static("http://localhost:5173"),
            HeaderValue::from_static("null"),
        ])
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PATCH,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([AUTHORIZATION, axum::http::header::CONTENT_TYPE])
        .max_age(Duration::from_secs(3600));

    Router::new()
        .route("/health", get(health))
        .route("/api/auth/login", post(auth::login))
        .route("/api/auth/status", get(auth::status))
        .route("/api/auth/logout", post(auth::logout))
        .route("/api/auth/switch", post(auth::switch_account))
        .route("/api/auth/account", axum::routing::delete(auth::delete_account))
        .route("/api/auth/import", post(auth::import_accounts))
        .route(
            "/api/files",
            get(nextcloud::list_files).delete(nextcloud::delete_file),
        )
        .route("/api/files/download", get(download::download_file))
        .route("/api/files/upload", post(upload::upload_file))
        .route("/api/files/mkdir", post(nextcloud::mkdir))
        .route("/api/files/rename", patch(nextcloud::rename))
        .route("/api/files/progress", get(upload::progress_sse))
        .route("/api/settings/upload-limit", put(settings::set_upload_limit))
        .layer(axum::extract::DefaultBodyLimit::disable())
        .layer(middleware::from_fn_with_state(state.clone(), require_token))
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

async fn health(State(state): State<AppState>) -> impl IntoResponse {
    let active_idx = state.active.load(std::sync::atomic::Ordering::SeqCst);
    let logged_in = active_idx != usize::MAX && !state.accounts.read().await.is_empty();
    Json(json!({
        "success": true,
        "data": {
            "status": "ok",
            "logged_in": logged_in,
        }
    }))
}

/// Find the first free port starting from `start` (inclusive).
pub async fn find_free_port(start: u16) -> u16 {
    let mut port = start;
    loop {
        match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
            Ok(listener) => {
                drop(listener);
                return port;
            }
            Err(_) => port += 1,
        }
    }
}
