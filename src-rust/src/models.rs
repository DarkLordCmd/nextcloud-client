use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::Serialize;
use serde_json::json;

/// A single file or folder entry returned by the files API.
#[derive(Debug, Clone, Serialize)]
pub struct FileItem {
    pub name: String,
    pub path: String,
    pub size: u64,
    pub modified: String,
    pub mime_type: Option<String>,
    pub is_directory: bool,
    pub etag: Option<String>,
}

/// An event emitted over the SSE progress stream.
#[derive(Debug, Clone, Serialize)]
pub struct ProgressEvent {
    pub id: String,
    pub kind: String,
    pub filename: Option<String>,
    pub bytes_done: Option<u64>,
    pub bytes_total: Option<u64>,
    pub percent: Option<u32>,
    pub error: Option<String>,
}

/// Success envelope: `{ "success": true, "data": ... }`.
#[derive(Debug, Serialize)]
pub struct ApiOk<T: Serialize> {
    pub success: bool,
    pub data: T,
}

impl<T: Serialize> ApiOk<T> {
    pub fn new(data: T) -> Self {
        Self { success: true, data }
    }
}

/// Application-wide error type. All handlers return `Result<_, AppError>`.
#[derive(Debug, Clone, thiserror::Error)]
pub enum AppError {
    #[error("Not authenticated. Please log in first.")]
    NotAuthenticated,
    #[error("{0}")]
    BadRequest(String),
    #[error("NextCloud returned HTTP {status}: {message}")]
    NextCloud { status: u16, message: String },
    #[error("Failed to parse server response: {0}")]
    Xml(String),
    #[error("Network error: {0}")]
    Network(String),
    #[error("Internal error: {0}")]
    Internal(String),
}

impl AppError {
    pub fn status(&self) -> StatusCode {
        match self {
            AppError::NotAuthenticated => StatusCode::UNAUTHORIZED,
            AppError::BadRequest(_) => StatusCode::BAD_REQUEST,
            AppError::NextCloud { status, .. } => {
                StatusCode::from_u16(*status).unwrap_or(StatusCode::BAD_GATEWAY)
            }
            AppError::Xml(_) | AppError::Network(_) => StatusCode::BAD_GATEWAY,
            AppError::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let body = Json(json!({ "success": false, "error": self.to_string() }));
        (self.status(), body).into_response()
    }
}

impl From<reqwest::Error> for AppError {
    fn from(e: reqwest::Error) -> Self {
        if e.is_timeout() || e.is_connect() {
            AppError::Network(format!("Could not reach the server: {e}"))
        } else {
            AppError::Network(e.to_string())
        }
    }
}

impl From<quick_xml::Error> for AppError {
    fn from(e: quick_xml::Error) -> Self {
        AppError::Xml(e.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(e: serde_json::Error) -> Self {
        AppError::BadRequest(format!("Invalid JSON: {e}"))
    }
}

/// Convert a WebDAV `getlastmodified` value (RFC 1123) into an RFC 3339 string.
pub fn http_date_to_rfc3339(value: &str) -> String {
    match httpdate::parse_http_date(value.trim()) {
        Ok(st) => system_time_to_rfc3339(st),
        Err(_) => value.trim().to_string(),
    }
}

fn system_time_to_rfc3339(st: std::time::SystemTime) -> String {
    let secs = st
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or_else(|e| -(e.duration().as_secs() as i64));
    let days = secs.div_euclid(86_400);
    let secs_of_day = secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    let hour = secs_of_day / 3600;
    let minute = (secs_of_day % 3600) / 60;
    let second = secs_of_day % 60;
    format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z"
    )
}

/// Howard Hinnant's civil-from-days algorithm.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = (if z >= 0 { z } else { z - 146_096 }) / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    let year = if month <= 2 { y + 1 } else { y };
    (year, month, day)
}
