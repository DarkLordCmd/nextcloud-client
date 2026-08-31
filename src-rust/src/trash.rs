use std::io::BufRead;

use axum::{
    Json,
    extract::{Query, State},
};
use reqwest::Method;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{
    auth::{AuthState, require_auth},
    models::{ApiOk, AppError},
    nextcloud::{self, dav_method},
    server::AppState,
};

/// Base trashbin WebDAV URL, e.g.
/// `https://host/remote.php/dav/trashbin/alice/trash/`.
fn trash_base(auth: &AuthState) -> String {
    format!(
        "{}/remote.php/dav/trashbin/{}/trash/",
        auth.server.trim_end_matches('/'),
        nextcloud::encode_segment(&auth.username)
    )
}

/// PROPFIND body requesting the standard props plus the trashbin-specific
/// `nc:` namespace props (original location + deletion time).
const TRASH_PROPFIND_BODY: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<d:propfind xmlns:d="DAV:" xmlns:nc="http://nextcloud.org/ns" xmlns:oc="http://owncloud.org/ns">
  <d:prop>
    <d:displayname/>
    <d:getcontentlength/>
    <d:getcontenttype/>
    <d:getlastmodified/>
    <d:getetag/>
    <d:resourcetype/>
    <nc:trashbin-original-location/>
    <nc:trashbin-deletion-time/>
  </d:prop>
</d:propfind>"#;

#[derive(Debug, Clone, serde::Serialize)]
pub struct TrashItem {
    /// Path of the item inside the trash (e.g. `report.docx.d1788030029`).
    pub path: String,
    pub name: String,
    pub size: u64,
    pub mime_type: Option<String>,
    pub is_directory: bool,
    /// Unix timestamp of deletion (seconds).
    pub deleted_at: u64,
    /// Original location relative to the user root (e.g. `docs/report.docx`).
    pub original_location: String,
}

/// `GET /api/files/quota` — used / total storage via the OCS cloud API.
pub async fn quota(State(state): State<AppState>) -> Result<Json<ApiOk<Value>>, AppError> {
    let auth = require_auth(&state).await?;
    let url = format!(
        "{}/ocs/v2.php/cloud/user?format=json",
        auth.server.trim_end_matches('/')
    );
    let resp = nextcloud::dav_request(
        &state.http,
        &auth,
        Method::GET,
        &url,
        &[("OCS-APIRequest", "true")],
        None,
    )
    .await?;
    let text = resp.text().await?;
    let parsed: Value = serde_json::from_str(&text)?;
    let quota_obj = parsed
        .pointer("/ocs/data/quota")
        .cloned()
        .unwrap_or(Value::Null);
    let used = quota_obj
        .get("used")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let quota_val = quota_obj
        .get("quota")
        .and_then(|v| v.as_i64())
        .unwrap_or(-1);
    let free = quota_obj
        .get("free")
        .and_then(|v| v.as_i64())
        .unwrap_or(-1);
    let relative = quota_obj
        .get("relative")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    // Nextcloud reports a negative quota for unlimited storage.
    let unlimited = quota_val < 0;
    Ok(Json(ApiOk::new(json!({
        "used": used,
        "quota": if unlimited { 0 } else { quota_val as u64 },
        "free": free,
        "relative": relative,
        "unlimited": unlimited,
    }))))
}

/// `GET /api/files/trash` — list the contents of the trashbin.
pub async fn list_trash(
    State(state): State<AppState>,
) -> Result<Json<ApiOk<Value>>, AppError> {
    let auth = require_auth(&state).await?;
    let base = trash_base(&auth);
    let resp = nextcloud::dav_request(
        &state.http,
        &auth,
        dav_method("PROPFIND"),
        &base,
        &[("Depth", "1")],
        Some(reqwest::Body::from(TRASH_PROPFIND_BODY)),
    )
    .await?;
    let xml = resp.text().await?;
    let mut items = parse_trash_xml(&xml)?;
    items.sort_by(|a, b| b.deleted_at.cmp(&a.deleted_at));
    Ok(Json(ApiOk::new(json!({ "items": items }))))
}

#[derive(Deserialize)]
pub struct TrashQuery {
    pub path: Option<String>,
}

/// `DELETE /api/files/trash?path=...` — permanently delete one trash item.
/// Without `path`, empties the whole trashbin.
pub async fn delete_trash(
    State(state): State<AppState>,
    Query(params): Query<TrashQuery>,
) -> Result<Json<ApiOk<Value>>, AppError> {
    let auth = require_auth(&state).await?;
    let base = trash_base(&auth);

    let paths: Vec<String> = match params.path.as_deref().map(str::trim) {
        None | Some("") => {
            // Empty the whole trashbin: list everything, then delete it all.
            let resp = nextcloud::dav_request(
                &state.http,
                &auth,
                dav_method("PROPFIND"),
                &base,
                &[("Depth", "1")],
                Some(reqwest::Body::from(TRASH_PROPFIND_BODY)),
            )
            .await?;
            let xml = resp.text().await?;
            parse_trash_xml(&xml)?.into_iter().map(|i| i.path).collect()
        }
        Some(p) => {
            if p.contains("..") || p.contains('/') {
                return Err(AppError::BadRequest("Invalid trash path.".into()));
            }
            vec![p.to_string()]
        }
    };

    for p in &paths {
        let url = format!("{}{}", base, nextcloud::encode_path(p));
        nextcloud::dav_request(&state.http, &auth, Method::DELETE, &url, &[], None).await?;
    }
    Ok(Json(ApiOk::new(json!({ "ok": true, "deleted": paths.len() }))))
}

#[derive(Deserialize)]
pub struct RestoreRequest {
    /// Trash path of the item to restore.
    pub path: String,
    /// Original location relative to the user root.
    pub original: String,
}

/// `POST /api/files/trash/restore` — move a trash item back to its original
/// location.
pub async fn restore_trash(
    State(state): State<AppState>,
    Json(req): Json<RestoreRequest>,
) -> Result<Json<ApiOk<Value>>, AppError> {
    if req.path.is_empty() || req.path.contains("..") || req.path.contains('/') {
        return Err(AppError::BadRequest("Invalid trash path.".into()));
    }
    let auth = require_auth(&state).await?;
    let src = format!("{}{}", trash_base(&auth), nextcloud::encode_path(&req.path));
    let original = format!("/{}", req.original.trim_start_matches('/'));
    let dest = nextcloud::dav_url(&auth, &original);
    let resp = nextcloud::dav_request(
        &state.http,
        &auth,
        dav_method("MOVE"),
        &src,
        &[("Destination", &dest), ("Overwrite", "F")],
        None,
    )
    .await?;
    let _ = resp;
    Ok(Json(ApiOk::new(json!({ "ok": true }))))
}

// ---------------------------------------------------------------------------
// PROPFIND XML parsing (trashbin variants of the helpers in nextcloud.rs)
// ---------------------------------------------------------------------------

fn parse_trash_xml(xml: &str) -> Result<Vec<TrashItem>, AppError> {
    let mut reader = quick_xml::Reader::from_str(xml);
    reader.config_mut().trim_text(true);
    let mut buf = Vec::new();
    let mut items = Vec::new();
    loop {
        buf.clear();
        match reader.read_event_into(&mut buf) {
            Ok(quick_xml::events::Event::Start(e)) if e.local_name().as_ref() == b"response" => {
                if let Some(item) = parse_trash_response(&mut reader, &mut buf)? {
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

fn parse_trash_response<R: BufRead>(
    reader: &mut quick_xml::Reader<R>,
    buf: &mut Vec<u8>,
) -> Result<Option<TrashItem>, AppError> {
    let mut href = String::new();
    let mut displayname = String::new();
    let mut size: Option<u64> = None;
    let mut mime: Option<String> = None;
    let mut deleted_at: u64 = 0;
    let mut original_location = String::new();
    let mut is_dir = false;

    loop {
        buf.clear();
        match reader.read_event_into(buf) {
            Ok(quick_xml::events::Event::Start(e)) => {
                let name = e.local_name().as_ref().to_vec();
                match name.as_slice() {
                    b"href" => href = read_text(reader, buf)?,
                    b"prop" => {
                        // Properties are nested inside <propstat><prop>; read
                        // them until the matching </prop>.
                        loop {
                            buf.clear();
                            match reader.read_event_into(buf) {
                                Ok(quick_xml::events::Event::Start(e)) => {
                                    let pn = e.local_name().as_ref().to_vec();
                                    match pn.as_slice() {
                                        b"displayname" => displayname = read_text(reader, buf)?,
                                        b"getcontentlength" => {
                                            size = read_text(reader, buf)?.trim().parse::<u64>().ok();
                                        }
                                        b"getcontenttype" => {
                                            let text = read_text(reader, buf)?;
                                            if !text.trim().is_empty() {
                                                mime = Some(text.trim().to_string());
                                            }
                                        }
                                        b"trashbin-original-location" => {
                                            original_location = read_text(reader, buf)?.trim().to_string();
                                        }
                                        b"trashbin-deletion-time" => {
                                            deleted_at = read_text(reader, buf)?.trim().parse::<u64>().unwrap_or(0);
                                        }
                                        b"resourcetype" => {
                                            if has_collection(reader, buf)? {
                                                is_dir = true;
                                            }
                                        }
                                        _ => skip_element(reader, buf)?,
                                    }
                                }
                                Ok(quick_xml::events::Event::Empty(e)) => {
                                    if e.local_name().as_ref() == b"collection" {
                                        is_dir = true;
                                    }
                                }
                                Ok(quick_xml::events::Event::End(e))
                                    if e.local_name().as_ref() == b"prop" =>
                                {
                                    break;
                                }
                                Ok(quick_xml::events::Event::Eof) => {
                                    return Err(AppError::Xml(
                                        "Unexpected EOF inside <prop>".into(),
                                    ));
                                }
                                Err(e) => return Err(AppError::Xml(e.to_string())),
                                _ => {}
                            }
                        }
                    }
                    // Do NOT skip unknown containers (e.g. <propstat>): the
                    // nested <prop> must be reached by continuing the loop.
                    _ => {}
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

    let href_decoded = percent_encoding::percent_decode_str(href.trim())
        .decode_utf8_lossy()
        .to_string();
    // The trash item path is everything after the last "/trash/" segment.
    // Works for both relative and absolute hrefs the server may return.
    let path = match href_decoded.rfind("/trash/") {
        Some(idx) => href_decoded[idx + "/trash/".len()..].trim_end_matches('/').to_string(),
        None => href_decoded
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            .unwrap_or_default()
            .to_string(),
    };
    // The requested trash root itself has an empty path.
    if path.is_empty() {
        return Ok(None);
    }
    let name = if !displayname.trim().is_empty() {
        displayname.trim().to_string()
    } else {
        path.clone()
    };

    Ok(Some(TrashItem {
        path,
        name,
        size: size.unwrap_or(0),
        mime_type: mime,
        is_directory: is_dir,
        deleted_at,
        original_location,
    }))
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