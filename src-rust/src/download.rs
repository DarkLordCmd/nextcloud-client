use axum::{
    extract::{Query, State},
    http::{StatusCode, header::CONTENT_DISPOSITION},
    response::Response,
};
use serde::Deserialize;

use crate::{
    models::AppError,
    nextcloud::{self, require_auth},
    server::AppState,
};

#[derive(Deserialize)]
pub struct DownloadQuery {
    pub path: String,
}

/// `GET /api/files/download?path=/doc.pdf` — stream a file to the client.
pub async fn download_file(
    State(state): State<AppState>,
    Query(params): Query<DownloadQuery>,
) -> Result<Response, AppError> {
    let path = nextcloud::normalize_path(&params.path);
    if path == "/" {
        return Err(AppError::BadRequest("Cannot download the root folder.".into()));
    }
    let auth = require_auth(&state).await?;
    let url = nextcloud::dav_url(&auth, &path);

    let resp = state
        .http
        .get(&url)
        .basic_auth(&auth.username, Some(&auth.password))
        .send()
        .await?;
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        let err = match status.as_u16() {
            401 => AppError::NextCloud {
                status: 401,
                message: "Invalid credentials or insufficient permissions".into(),
            },
            404 => AppError::NextCloud {
                status: 404,
                message: "File not found".into(),
            },
            _ => nextcloud::status_error(status, &text),
        };
        return Err(err);
    }

    let filename = path
        .rsplit('/')
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or("download")
        .to_string();
    let disposition = format!(
        "attachment; filename=\"{}\"",
        filename.replace('"', "_")
    );
    let body = axum::body::Body::from_stream(resp.bytes_stream());

    let builder = Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_DISPOSITION, disposition);
    builder
        .body(body)
        .map_err(|e| AppError::Internal(e.to_string()))
}
