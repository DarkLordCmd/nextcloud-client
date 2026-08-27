use std::convert::Infallible;
use std::time::Duration;

use axum::{
    Json,
    extract::{Multipart, Query, State},
    response::sse::{Event, KeepAlive, Sse},
};
use futures::{Stream, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};
use tokio_stream::wrappers::BroadcastStream;

use crate::{
    models::{ApiOk, AppError},
    nextcloud,
    server::AppState,
};

#[derive(Deserialize)]
pub struct UploadQuery {
    pub path: Option<String>,
}

/// `POST /api/files/upload?path=/dir` — accept multipart files and upload
/// them to NextCloud via WebDAV PUT, streaming progress over SSE.
pub async fn upload_file(
    State(state): State<AppState>,
    Query(params): Query<UploadQuery>,
    mut multipart: Multipart,
) -> Result<Json<ApiOk<Value>>, AppError> {
    let dest_dir = nextcloud::normalize_path(params.path.as_deref().unwrap_or("/"));
    let auth = nextcloud::require_auth(&state).await?;

    let mut uploaded: Vec<String> = Vec::new();
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| AppError::BadRequest(format!("Failed to read multipart field: {e}")))?
    {
        let file_name = field
            .file_name()
            .map(|s| s.to_string())
            .unwrap_or_default();
        if file_name.is_empty() {
            continue;
        }
        let bytes = field
            .bytes()
            .await
            .map_err(|e| AppError::BadRequest(format!("Failed to read upload body: {e}")))?;
        let id = format!("upload-{}", state.next_id.fetch_add(1, std::sync::atomic::Ordering::SeqCst));
        nextcloud::upload_bytes(&state, &auth, &dest_dir, &file_name, bytes, &id).await?;
        uploaded.push(file_name);
    }

    tracing::info!(files = ?uploaded, path = %dest_dir, "upload complete");
    Ok(Json(ApiOk::new(json!({ "files": uploaded, "path": dest_dir }))))
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
