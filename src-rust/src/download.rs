use axum::{
    extract::{Query, State},
    http::{
        HeaderMap,
        header::{
            ACCEPT_RANGES, CONTENT_DISPOSITION, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE, RANGE,
        },
    },
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
    /// When `1`, the response uses `Content-Disposition: inline`, forwards the
    /// client `Range` header upstream and passes through content headers so
    /// media players / the PDF viewer can seek and render without a full download.
    #[serde(default)]
    pub inline: Option<String>,
}

/// `GET /api/files/download?path=/doc.pdf&inline=1` — stream a file to the client.
pub async fn download_file(
    State(state): State<AppState>,
    Query(params): Query<DownloadQuery>,
    headers: HeaderMap,
) -> Result<Response, AppError> {
    let path = nextcloud::normalize_path(&params.path);
    if path == "/" {
        return Err(AppError::BadRequest("Cannot download the root folder.".into()));
    }
    let auth = require_auth(&state).await?;
    let url = nextcloud::dav_url(&auth, &path);

    let mut req = state
        .http
        .get(&url)
        .basic_auth(&auth.username, Some(&auth.password));
    if let Some(range) = headers.get(RANGE) {
        req = req.header(RANGE, range);
    }
    let resp = req.send().await?;
    let status = resp.status();
    // 416 (Range Not Satisfiable) is forwarded as-is so media elements can recover.
    if !(status.is_success() || status.as_u16() == 416) {
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
    let disposition = if params.inline.as_deref() == Some("1") {
        format!("inline; filename=\"{}\"", filename.replace('"', "_"))
    } else {
        format!("attachment; filename=\"{}\"", filename.replace('"', "_"))
    };

    let mut builder = Response::builder().status(status);
    builder = builder.header(CONTENT_DISPOSITION, disposition);
    if let Some(v) = resp.headers().get(CONTENT_TYPE) {
        builder = builder.header(CONTENT_TYPE, v);
    }
    if let Some(v) = resp.headers().get(CONTENT_LENGTH) {
        builder = builder.header(CONTENT_LENGTH, v);
    }
    if let Some(v) = resp.headers().get(CONTENT_RANGE) {
        builder = builder.header(CONTENT_RANGE, v);
    }
    if let Some(v) = resp.headers().get(ACCEPT_RANGES) {
        builder = builder.header(ACCEPT_RANGES, v);
    }

    let body = axum::body::Body::from_stream(resp.bytes_stream());
    builder
        .body(body)
        .map_err(|e| AppError::Internal(e.to_string()))
}
