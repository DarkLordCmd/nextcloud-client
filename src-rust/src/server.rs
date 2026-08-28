use std::sync::Arc;

use axum::{
    Json,
    extract::State,
    response::IntoResponse,
    routing::{get, patch, post},
    Router,
};
use serde_json::json;
use tokio::sync::{RwLock, broadcast};
use tower_http::{cors::CorsLayer, trace::TraceLayer};

use crate::{
    auth::{self, AuthState},
    download, models::ProgressEvent, nextcloud, upload,
};

/// Shared application state passed to every handler via `State`.
#[derive(Clone)]
pub struct AppState {
    /// In-memory credentials. `None` means the user is not logged in.
    pub auth: Arc<RwLock<Option<AuthState>>>,
    /// Shared HTTP client used for all WebDAV / OCS requests.
    pub http: reqwest::Client,
    /// Broadcast channel that fans progress events out to SSE subscribers.
    pub progress_tx: broadcast::Sender<ProgressEvent>,
    /// Monotonic counter used to generate unique operation ids.
    pub next_id: Arc<std::sync::atomic::AtomicU64>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            auth: Arc::new(RwLock::new(None)),
            http: build_http_client(),
            progress_tx: broadcast::channel(256).0,
            next_id: Arc::new(std::sync::atomic::AtomicU64::new(1)),
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

/// Build the full HTTP router with CORS, logging and no body size limit.
pub fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/health", get(health))
        .route("/api/auth/login", post(auth::login))
        .route("/api/auth/status", get(auth::status))
        .route("/api/auth/logout", post(auth::logout))
        .route(
            "/api/files",
            get(nextcloud::list_files).delete(nextcloud::delete_file),
        )
        .route("/api/files/download", get(download::download_file))
        .route("/api/files/upload", post(upload::upload_file))
        .route("/api/files/mkdir", post(nextcloud::mkdir))
        .route("/api/files/rename", patch(nextcloud::rename))
        .route("/api/files/progress", get(upload::progress_sse))
        .layer(TraceLayer::new_for_http())
        .layer(CorsLayer::permissive())
        .layer(axum::extract::DefaultBodyLimit::disable())
        .with_state(state)
}

async fn health(State(state): State<AppState>) -> impl IntoResponse {
    Json(json!({
        "success": true,
        "data": {
            "status": "ok",
            "logged_in": state.auth.read().await.is_some(),
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
