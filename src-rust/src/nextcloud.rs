use std::io::BufRead;

use axum::{Json, extract::{Query, State}};
use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, percent_decode_str, percent_encode};
use reqwest::{Method, StatusCode};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{
    auth::AuthState,
    models::{ApiOk, AppError, FileItem},
    server::AppState,
};

pub use crate::auth::require_auth;

/// Characters that should NOT be percent-encoded inside a DAV path segment.
const DAV_SET: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'.')
    .remove(b'_')
    .remove(b'~');

const PROPFIND_BODY: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">
  <d:prop>
    <d:displayname/>
    <d:getcontentlength/>
    <d:getcontenttype/>
    <d:getlastmodified/>
    <d:getetag/>
    <d:resourcetype/>
  </d:prop>
</d:propfind>"#;

// ---------------------------------------------------------------------------
// URL / path helpers
// ---------------------------------------------------------------------------

/// Percent-encode a single path segment (keeps unreserved characters).
pub fn encode_segment(segment: &str) -> String {
    percent_encode(segment.as_bytes(), DAV_SET).to_string()
}

/// Percent-encode each segment of a relative path, keeping the slashes.
pub fn encode_path(path: &str) -> String {
    path.split('/')
        .map(encode_segment)
        .collect::<Vec<_>>()
        .join("/")
}

/// Normalize a user-facing path: trim trailing slashes, `""` becomes `"/"`.
pub fn normalize_path(path: &str) -> String {
    let trimmed = path.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        "/".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Join a directory and a name into a relative DAV path.
pub fn rel_path(dir: &str, name: &str) -> String {
    let base = dir.trim_start_matches('/');
    if base.is_empty() {
        name.to_string()
    } else {
        format!("{base}/{name}")
    }
}

/// Build the absolute DAV URL for a user-facing path.
pub fn dav_url(auth: &AuthState, path: &str) -> String {
    let base = auth.dav_base();
    let rel = path.trim_start_matches('/');
    if rel.is_empty() {
        base
    } else {
        format!("{base}{}", encode_path(rel))
    }
}

// ---------------------------------------------------------------------------
// Low-level WebDAV request
// ---------------------------------------------------------------------------

fn method(name: &'static str) -> Method {
    Method::from_bytes(name.as_bytes()).unwrap_or(Method::POST)
}

pub(crate) fn dav_method(name: &'static str) -> Method {
    method(name)
}

/// Base URL for chunked upload v2 transfer sessions, e.g.
/// `https://host/remote.php/dav/uploads/alice/`.
pub fn dav_uploads_base(auth: &AuthState) -> String {
    let username = encode_segment(&auth.username);
    format!(
        "{}/remote.php/dav/uploads/{}/",
        auth.server.trim_end_matches('/'),
        username
    )
}

pub fn status_error(status: StatusCode, body: &str) -> AppError {
    let message = match status.as_u16() {
        401 => "Invalid credentials or insufficient permissions".to_string(),
        403 => "Access denied by the server".to_string(),
        404 => "File or folder not found".to_string(),
        405 => "Operation not supported by the server".to_string(),
        409 => "Conflict: a file or folder with this name already exists".to_string(),
        412 => "Precondition failed".to_string(),
        423 => "The resource is locked".to_string(),
        507 => "The server is out of storage space".to_string(),
        _ => {
            let trimmed = body.trim();
            if trimmed.is_empty() {
                format!("HTTP status {}", status.as_u16())
            } else {
                trimmed.chars().take(300).collect()
            }
        }
    };
    AppError::NextCloud {
        status: status.as_u16(),
        message,
    }
}

/// Send a WebDAV request with Basic auth, returning a success response.
pub async fn dav_request(
    client: &reqwest::Client,
    auth: &AuthState,
    method: Method,
    url: &str,
    headers: &[(&str, &str)],
    body: Option<reqwest::Body>,
) -> Result<reqwest::Response, AppError> {
    let mut req = client
        .request(method, url)
        .basic_auth(&auth.username, Some(&auth.password));
    for (key, value) in headers {
        req = req.header(*key, *value);
    }
    if let Some(body) = body {
        req = req.body(body);
    }
    let resp = req.send().await.map_err(|e| {
        AppError::Network(format!("Could not reach the NextCloud server: {e}"))
    })?;
    let status = resp.status();
    if status.is_success() || status.as_u16() == 207 {
        return Ok(resp);
    }
    let text = resp.text().await.unwrap_or_default();
    Err(status_error(status, &text))
}

/// Verify connectivity by issuing a PROPFIND against the user's root.
pub async fn verify_auth(client: &reqwest::Client, auth: &AuthState) -> Result<(), AppError> {
    let url = auth.dav_base();
    let resp = dav_request(
        client,
        auth,
        method("PROPFIND"),
        &url,
        &[("Depth", "1")],
        Some(reqwest::Body::from(PROPFIND_BODY)),
    )
    .await?;
    let _ = resp;
    Ok(())
}

// ---------------------------------------------------------------------------
// PROPFIND + XML parsing
// ---------------------------------------------------------------------------

/// List a directory, returning parsed `FileItem`s.
pub async fn propfind(state: &AppState, path: &str) -> Result<Vec<FileItem>, AppError> {
    let auth = require_auth(state).await?;
    let url = dav_url(&auth, path);
    let resp = dav_request(
        &state.http,
        &auth,
        method("PROPFIND"),
        &url,
        &[("Depth", "1")],
        Some(reqwest::Body::from(PROPFIND_BODY)),
    )
    .await?;
    let xml = resp.text().await?;
    parse_propfind_xml(&xml, &url, path)
}

/// Parse a `multistatus` PROPFIND response into a list of `FileItem`s.
fn parse_propfind_xml(
    xml: &str,
    expected_dir_url: &str,
    dir_path: &str,
) -> Result<Vec<FileItem>, AppError> {
    let mut reader = quick_xml::Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut buf = Vec::new();
    let mut items = Vec::new();

    loop {
        buf.clear();
        match reader.read_event_into(&mut buf) {
            Ok(quick_xml::events::Event::Start(e)) if e.local_name().as_ref() == b"response" => {
                if let Some(item) = parse_response(&mut reader, &mut buf, expected_dir_url, dir_path)?
                {
                    items.push(item);
                }
            }
            Ok(quick_xml::events::Event::Eof) => break,
            Err(e) => return Err(AppError::Xml(e.to_string())),
            _ => {}
        }
    }
    Ok(items)
}

/// Parse a single `<d:response>` block. Returns `None` for the requested
/// directory itself.
fn parse_response<R: BufRead>(
    reader: &mut quick_xml::Reader<R>,
    buf: &mut Vec<u8>,
    expected_dir_url: &str,
    dir_path: &str,
) -> Result<Option<FileItem>, AppError> {
    let mut href = String::new();
    let mut displayname = String::new();
    let mut size: Option<u64> = None;
    let mut mime: Option<String> = None;
    let mut modified: Option<String> = None;
    let mut etag: Option<String> = None;
    let mut is_dir = false;

    loop {
        buf.clear();
        match reader.read_event_into(buf) {
            Ok(quick_xml::events::Event::Start(e)) => {
                let name = e.local_name().as_ref().to_vec();
                match name.as_slice() {
                    b"href" => href = read_text(reader, buf)?,
                    b"prop" => {
                        parse_prop(
                            reader,
                            buf,
                            &mut displayname,
                            &mut size,
                            &mut mime,
                            &mut modified,
                            &mut etag,
                            &mut is_dir,
                        )?;
                    }
                    _ => {}
                }
            }
            Ok(quick_xml::events::Event::Empty(e)) => {
                if e.local_name().as_ref() == b"collection" {
                    is_dir = true;
                }
            }
            Ok(quick_xml::events::Event::End(e))
                if e.local_name().as_ref() == b"response" =>
            {
                break;
            }
            Ok(quick_xml::events::Event::Eof) => {
                return Err(AppError::Xml("Unexpected EOF inside <response>".into()));
            }
            Err(e) => return Err(AppError::Xml(e.to_string())),
            _ => {}
        }
    }

    let href_decoded = percent_decode_str(href.trim())
        .decode_utf8_lossy()
        .to_string();
    let href_norm = href_decoded.trim_end_matches('/');
    let expected = percent_decode_str(expected_dir_url.trim_end_matches('/'))
        .decode_utf8_lossy()
        .to_string();

    // The first entry in a PROPFIND response is always the requested directory.
    if href_norm == expected {
        return Ok(None);
    }

    let name = if !displayname.trim().is_empty() {
        displayname.trim().to_string()
    } else {
        href_norm
            .rsplit('/')
            .next()
            .map(|s| s.to_string())
            .unwrap_or_default()
    };
    if name.is_empty() {
        return Ok(None);
    }

    let path = if dir_path == "/" {
        format!("/{name}")
    } else {
        format!("{}/{}", dir_path.trim_end_matches('/'), name)
    };

    Ok(Some(FileItem {
        name: name.clone(),
        path,
        size: size.unwrap_or(0),
        modified: modified
            .as_deref()
            .map(crate::models::http_date_to_rfc3339)
            .unwrap_or_default(),
        mime_type: mime,
        is_directory: is_dir,
        etag,
    }))
}

/// Parse the properties inside a `<d:prop>` block.
#[allow(clippy::too_many_arguments)]
fn parse_prop<R: BufRead>(
    reader: &mut quick_xml::Reader<R>,
    buf: &mut Vec<u8>,
    displayname: &mut String,
    size: &mut Option<u64>,
    mime: &mut Option<String>,
    modified: &mut Option<String>,
    etag: &mut Option<String>,
    is_dir: &mut bool,
) -> Result<(), AppError> {
    loop {
        buf.clear();
        match reader.read_event_into(buf) {
            Ok(quick_xml::events::Event::Start(e)) => {
                let name = e.local_name().as_ref().to_vec();
                match name.as_slice() {
                    b"displayname" => *displayname = read_text(reader, buf)?,
                    b"getcontentlength" => {
                        let text = read_text(reader, buf)?;
                        *size = text.trim().parse::<u64>().ok();
                    }
                    b"getcontenttype" => {
                        let text = read_text(reader, buf)?;
                        if !text.trim().is_empty() {
                            *mime = Some(text.trim().to_string());
                        }
                    }
                    b"getlastmodified" => {
                        let text = read_text(reader, buf)?;
                        if !text.trim().is_empty() {
                            *modified = Some(text.trim().to_string());
                        }
                    }
                    b"getetag" => {
                        let text = read_text(reader, buf)?;
                        if !text.trim().is_empty() {
                            *etag = Some(text.trim().trim_matches('"').to_string());
                        }
                    }
                    b"resourcetype" => {
                        if has_collection(reader, buf)? {
                            *is_dir = true;
                        }
                    }
                    _ => skip_element(reader, buf)?,
                }
            }
            Ok(quick_xml::events::Event::Empty(e)) => {
                if e.local_name().as_ref() == b"collection" {
                    *is_dir = true;
                }
            }
            Ok(quick_xml::events::Event::End(e))
                if e.local_name().as_ref() == b"prop" =>
            {
                break;
            }
            Ok(quick_xml::events::Event::Eof) => {
                return Err(AppError::Xml("Unexpected EOF inside <prop>".into()));
            }
            Err(e) => return Err(AppError::Xml(e.to_string())),
            _ => {}
        }
    }
    Ok(())
}

/// Read the text content of the current element (up to and including its end tag).
fn read_text<R: BufRead>(
    reader: &mut quick_xml::Reader<R>,
    buf: &mut Vec<u8>,
) -> Result<String, AppError> {
    let mut out = String::new();
    loop {
        buf.clear();
        match reader.read_event_into(buf) {
            Ok(quick_xml::events::Event::Text(t)) => {
                out.push_str(&t.unescape().unwrap_or_default());
            }
            Ok(quick_xml::events::Event::CData(c)) => {
                out.push_str(std::str::from_utf8(c.as_ref()).unwrap_or_default());
            }
            Ok(quick_xml::events::Event::End(_)) => break,
            Ok(quick_xml::events::Event::Eof) => {
                return Err(AppError::Xml("Unexpected EOF while reading text".into()));
            }
            Err(e) => return Err(AppError::Xml(e.to_string())),
            _ => {}
        }
    }
    Ok(out)
}

/// Check whether a `<d:resourcetype>` contains `<d:collection/>`.
fn has_collection<R: BufRead>(
    reader: &mut quick_xml::Reader<R>,
    buf: &mut Vec<u8>,
) -> Result<bool, AppError> {
    loop {
        buf.clear();
        match reader.read_event_into(buf) {
            Ok(quick_xml::events::Event::Empty(e)) if e.local_name().as_ref() == b"collection" => {
                return Ok(true);
            }
            Ok(quick_xml::events::Event::Start(e))
                if e.local_name().as_ref() == b"collection" =>
            {
                skip_element(reader, buf)?;
                return Ok(true);
            }
            Ok(quick_xml::events::Event::End(e))
                if e.local_name().as_ref() == b"resourcetype" =>
            {
                return Ok(false);
            }
            Ok(quick_xml::events::Event::Eof) => {
                return Err(AppError::Xml("Unexpected EOF inside <resourcetype>".into()));
            }
            Err(e) => return Err(AppError::Xml(e.to_string())),
            _ => {}
        }
    }
}

/// Skip an element and its whole subtree.
fn skip_element<R: BufRead>(
    reader: &mut quick_xml::Reader<R>,
    buf: &mut Vec<u8>,
) -> Result<(), AppError> {
    let mut depth = 1usize;
    while depth > 0 {
        buf.clear();
        match reader.read_event_into(buf) {
            Ok(quick_xml::events::Event::Start(_)) => depth += 1,
            Ok(quick_xml::events::Event::Empty(_)) => {}
            Ok(quick_xml::events::Event::End(_)) => depth -= 1,
            Ok(quick_xml::events::Event::Eof) => {
                return Err(AppError::Xml("Unexpected EOF while skipping element".into()));
            }
            Err(e) => return Err(AppError::Xml(e.to_string())),
            _ => {}
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// File operation handlers
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct ListQuery {
    pub path: Option<String>,
}

/// `GET /api/files?path=/` — list the contents of a directory.
pub async fn list_files(
    State(state): State<AppState>,
    Query(params): Query<ListQuery>,
) -> Result<Json<ApiOk<Value>>, AppError> {
    let path = normalize_path(params.path.as_deref().unwrap_or("/"));
    let items = propfind(&state, &path).await?;
    tracing::info!(path = %path, count = items.len(), "listing directory");
    Ok(Json(ApiOk::new(json!({ "path": path, "files": items }))))
}

#[derive(Deserialize)]
pub struct MkdirQuery {
    pub path: String,
}

/// `POST /api/files/mkdir?path=/new` — create a folder via MKCOL.
pub async fn mkdir(
    State(state): State<AppState>,
    Query(params): Query<MkdirQuery>,
) -> Result<Json<ApiOk<Value>>, AppError> {
    let path = normalize_path(&params.path);
    let auth = require_auth(&state).await?;
    let url = dav_url(&auth, &path);
    let resp = dav_request(&state.http, &auth, method("MKCOL"), &url, &[], None).await?;
    let _ = resp;
    tracing::info!(path = %path, "folder created");
    Ok(Json(ApiOk::new(json!({ "path": path }))))
}

#[derive(Deserialize)]
pub struct DeleteQuery {
    pub path: String,
}

/// `DELETE /api/files?path=/doc.txt` — delete a file or folder.
pub async fn delete_file(
    State(state): State<AppState>,
    Query(params): Query<DeleteQuery>,
) -> Result<Json<ApiOk<Value>>, AppError> {
    let path = normalize_path(&params.path);
    let auth = require_auth(&state).await?;
    let url = dav_url(&auth, &path);
    let resp = dav_request(&state.http, &auth, method("DELETE"), &url, &[], None).await?;
    let _ = resp;
    tracing::info!(path = %path, "deleted");
    Ok(Json(ApiOk::new(json!({ "path": path }))))
}

#[derive(Deserialize)]
pub struct RenameRequest {
    pub path: String,
    pub new_name: String,
}

/// `PATCH /api/files/rename` — rename a file or folder via MOVE.
pub async fn rename(
    State(state): State<AppState>,
    Json(req): Json<RenameRequest>,
) -> Result<Json<ApiOk<Value>>, AppError> {
    if req.new_name.is_empty() || req.new_name.contains('/') || req.new_name.contains('\\') {
        return Err(AppError::BadRequest("Invalid name.".into()));
    }
    let path = normalize_path(&req.path);
    let parent = path
        .rsplit_once('/')
        .map(|(p, _)| if p.is_empty() { "/" } else { p })
        .unwrap_or("/");
    let dest_rel = rel_path(parent, &req.new_name);

    let auth = require_auth(&state).await?;
    let src_url = dav_url(&auth, &path);
    let dest_url = dav_url(&auth, &dest_rel);
    let resp = dav_request(
        &state.http,
        &auth,
        method("MOVE"),
        &src_url,
        &[("Destination", dest_url.as_str()), ("Overwrite", "F")],
        None,
    )
    .await?;
    let _ = resp;
    tracing::info!(from = %path, to = %dest_rel, "renamed");
    Ok(Json(ApiOk::new(json!({ "old_path": path, "new_path": dest_rel }))))
}
