use axum::{Json, extract::State};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{models::{ApiOk, AppError}, server::AppState};

#[derive(Deserialize)]
pub struct UploadLimitRequest {
    /// Upload speed cap in bytes per second. `0` disables the limit.
    pub bytes_per_sec: u64,
}

/// `PUT /api/settings/upload-limit` — set the upload speed cap applied by the
/// backend while forwarding file data to NextCloud.
pub async fn set_upload_limit(
    State(state): State<AppState>,
    Json(req): Json<UploadLimitRequest>,
) -> Result<Json<ApiOk<Value>>, AppError> {
    state
        .upload_limit
        .store(req.bytes_per_sec, std::sync::atomic::Ordering::SeqCst);
    tracing::info!(bytes_per_sec = req.bytes_per_sec, "upload speed limit updated");
    Ok(Json(ApiOk::new(json!({ "bytes_per_sec": req.bytes_per_sec }))))
}