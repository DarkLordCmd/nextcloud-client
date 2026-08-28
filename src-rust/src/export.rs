use std::io::Write;
use std::sync::atomic::{AtomicU64, Ordering};

use axum::{
    extract::{Query, State},
    http::{header::CONTENT_DISPOSITION, StatusCode},
    response::Response,
};
use serde::Deserialize;
use zip::ZipWriter;
use zip::write::SimpleFileOptions;

use crate::{
    models::AppError,
    nextcloud::{self, dav_request, dav_url, require_auth},
    server::AppState,
};

#[derive(Deserialize)]
pub struct ExportQuery {
    pub path: String,
}

static ZIP_SEQ: AtomicU64 = AtomicU64::new(0);

/// Recursively collect every file (leaf) under `path` into `out` as absolute
/// paths, walking subfolders with Depth-1 PROPFIND.
fn collect_files<'a>(
    state: &'a AppState,
    path: &'a str,
    out: &'a mut Vec<String>,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), AppError>> + Send + 'a>> {
    Box::pin(async move {
        let items = nextcloud::propfind(state, path).await?;
        for it in items {
            if it.is_directory {
                collect_files(state, &it.path, out).await?;
            } else {
                out.push(it.path);
            }
        }
        Ok(())
    })
}

/// `GET /api/files/export?path=/X` — stream a file, or a ZIP of a folder.
pub async fn export_file(
    State(state): State<AppState>,
    Query(params): Query<ExportQuery>,
) -> Result<Response, AppError> {
    let path = nextcloud::normalize_path(&params.path);
    if path == "/" {
        return Err(AppError::BadRequest("Cannot export the root folder.".into()));
    }
    let auth = require_auth(&state).await?;

    // Single file: stream it straight through.
    if !path_is_directory(&state, &auth, &path).await? {
        let url = dav_url(&auth, &path);
        let resp = state
            .http
            .get(&url)
            .basic_auth(&auth.username, Some(&auth.password))
            .send()
            .await?;
        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(nextcloud::status_error(status, &text));
        }
        let filename = path.rsplit('/').next().unwrap_or("download").to_string();
        let body = axum::body::Body::from_stream(resp.bytes_stream());
        return Response::builder()
            .status(status)
            .header(
                CONTENT_DISPOSITION,
                format!("attachment; filename=\"{}\"", filename.replace('"', "_")),
            )
            .header("Content-Type", "application/octet-stream")
            .body(body)
            .map_err(|e| AppError::Internal(e.to_string()));
    }

    // Folder: gather all files and build a ZIP in a temp file.
    let mut files: Vec<String> = Vec::new();
    collect_files(&state, &path, &mut files).await?;

    let folder_name = path.trim_end_matches('/').rsplit('/').next().unwrap_or("folder");
    let seq = ZIP_SEQ.fetch_add(1, Ordering::SeqCst);
    let zip_path = std::env::temp_dir().join(format!(
        "nextcloud-export-{}-{}-{seq}.zip",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));

    // Download every file into memory (async), then write the ZIP off the
    // async runtime. Memory use is bounded by the exported files.
    let mut payloads: Vec<(String, Vec<u8>)> = Vec::with_capacity(files.len());
    for abs in &files {
        let rel = abs.trim_start_matches('/').to_string();
        let url = dav_url(&auth, abs);
        let resp = state
            .http
            .get(&url)
            .basic_auth(&auth.username, Some(&auth.password))
            .send()
            .await?;
        let status = resp.status();
        if !status.is_success() {
            let text = resp.text().await.unwrap_or_default();
            return Err(nextcloud::status_error(status, &text));
        }
        let bytes = resp.bytes().await?.to_vec();
        payloads.push((rel, bytes));
    }

    let zip_path_clone = zip_path.clone();
    tokio::task::spawn_blocking(move || -> Result<(), AppError> {
        let file = std::fs::File::create(&zip_path_clone)
            .map_err(|e| AppError::Internal(format!("Failed to create temp zip: {e}")))?;
        let mut writer = ZipWriter::new(file);
        let opts = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
        for (rel, bytes) in payloads {
            writer
                .start_file(rel, opts)
                .map_err(|e| AppError::Internal(e.to_string()))?;
            writer
                .write_all(&bytes)
                .map_err(|e| AppError::Internal(e.to_string()))?;
        }
        writer
            .finish()
            .map_err(|e| AppError::Internal(e.to_string()))?;
        Ok(())
    })
    .await
    .map_err(|e| AppError::Internal(format!("zip task failed: {e}")))??;

    let file = tokio::fs::File::open(&zip_path)
        .await
        .map_err(|e| AppError::Internal(format!("Failed to open zip: {e}")))?;
    let stream = tokio_util::io::ReaderStream::new(file);
    let body = axum::body::Body::from_stream(stream);

    // Best-effort cleanup after the response has been streamed out.
    let cleanup_path = zip_path.clone();
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(120)).await;
        let _ = tokio::fs::remove_file(&cleanup_path).await;
    });

    Response::builder()
        .status(StatusCode::OK)
        .header(
            CONTENT_DISPOSITION,
            format!("attachment; filename=\"{}.zip\"", folder_name.replace('"', "_")),
        )
        .header("Content-Type", "application/zip")
        .body(body)
        .map_err(|e| AppError::Internal(e.to_string()))
}

/// True when `path` is a directory. Uses a Depth-1 PROPFIND on the path itself
/// and checks whether its own `<resourcetype>` contains `<collection>`.
async fn path_is_directory(
    state: &AppState,
    auth: &crate::auth::AuthState,
    path: &str,
) -> Result<bool, AppError> {
    let url = dav_url(auth, path);
    let body = r#"<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:prop><d:resourcetype/></d:prop>
</d:propfind>"#;
    let resp = dav_request(
        &state.http,
        auth,
        nextcloud::dav_method("PROPFIND"),
        &url,
        &[("Depth", "0")],
        Some(reqwest::Body::from(body)),
    )
    .await?;
    let xml = resp.text().await?;
    Ok(xml.contains("<d:collection") || xml.contains("<collection"))
}