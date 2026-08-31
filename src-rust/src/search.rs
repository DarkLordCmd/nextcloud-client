use std::collections::HashSet;

use axum::{Json, extract::{Query, State}};
use futures::stream::{self, StreamExt};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::{
    models::{ApiOk, AppError, FileItem},
    nextcloud::propfind,
    server::AppState,
};

/// Upper bound on PROPFIND requests issued during a search.
const MAX_DIRS: usize = 5000;
/// Upper bound on the number of results returned to the client.
const MAX_RESULTS: usize = 500;
/// How many folders are listed in parallel.
const CONCURRENCY: usize = 8;

#[derive(Deserialize)]
pub struct SearchQuery {
    pub q: Option<String>,
}

/// `GET /api/files/search?q=...` — find files and folders whose name contains
/// the query, across the whole storage. Walks the folder tree with bounded
/// parallel PROPFINDs (each folder lists only its direct children), so it
/// works on any NextCloud without relying on server-side search or
/// `Depth: infinity`. Inaccessible folders are skipped silently.
pub async fn search_files(
    State(state): State<AppState>,
    Query(params): Query<SearchQuery>,
) -> Result<Json<ApiOk<Value>>, AppError> {
    let query = params.q.unwrap_or_default().trim().to_string();
    if query.is_empty() {
        return Ok(Json(ApiOk::new(json!({ "items": [], "truncated": false }))));
    }
    let needle = query.to_lowercase();

    let mut results: Vec<FileItem> = Vec::new();
    let mut truncated = false;
    let mut remaining_dirs = MAX_DIRS;
    let mut seen: HashSet<String> = HashSet::new();
    seen.insert("/".to_string());
    let mut wave = vec!["/".to_string()];

    'search: while !wave.is_empty() && remaining_dirs > 0 {
        let fetched = stream::iter(wave.iter().cloned())
            .map(|dir| {
                let state = state.clone();
                async move { propfind(&state, &dir).await.ok() }
            })
            .buffer_unordered(CONCURRENCY)
            .collect::<Vec<_>>()
            .await;

        let mut next_wave = Vec::new();
        for items in fetched {
            remaining_dirs -= 1;
            if remaining_dirs == 0 {
                truncated = true;
            }
            let Some(items) = items else { continue };
            for item in items {
                let is_dir = item.is_directory;
                let path = item.path.clone();
                if item.name.to_lowercase().contains(&needle) {
                    if results.len() >= MAX_RESULTS {
                        truncated = true;
                        break 'search;
                    }
                    results.push(item);
                }
                if is_dir && !seen.contains(&path) {
                    seen.insert(path.clone());
                    next_wave.push(path);
                }
            }
        }
        if truncated {
            break 'search;
        }
        wave = next_wave;
    }

    tracing::info!(
        query = %query,
        count = results.len(),
        truncated,
        "search completed"
    );
    Ok(Json(ApiOk::new(json!({
        "items": results,
        "truncated": truncated,
    }))))
}