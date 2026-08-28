use std::sync::atomic::Ordering;

use axum::{Json, extract::State};
use serde::{Deserialize, Serialize};

use crate::{
    models::{ApiOk, AppError},
    nextcloud,
    server::AppState,
};

/// Saved connection credentials. Stored in memory and persisted to disk by Electron.
#[derive(Debug, Clone)]
pub struct AuthState {
    pub server: String,
    pub username: String,
    pub password: String,
}

impl AuthState {
    /// Root WebDAV URL for this user, e.g. `https://host/remote.php/dav/files/alice/`.
    pub fn dav_base(&self) -> String {
        let username = nextcloud::encode_segment(&self.username);
        format!(
            "{}/remote.php/dav/files/{}/",
            self.server.trim_end_matches('/'),
            username
        )
    }
}

/// Active account, or `NotAuthenticated` when there is none.
pub async fn require_auth(state: &AppState) -> Result<AuthState, AppError> {
    let idx = state.active.load(Ordering::SeqCst);
    let guard = state.accounts.read().await;
    guard.get(idx).cloned().ok_or(AppError::NotAuthenticated)
}

#[derive(Deserialize)]
pub struct LoginRequest {
    pub server: String,
    pub username: String,
    pub password: String,
}

#[derive(Serialize)]
pub struct AccountMeta {
    pub server: String,
    pub username: String,
}

#[derive(Serialize)]
pub struct AccountState {
    pub logged_in: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    pub accounts: Vec<AccountMeta>,
    pub active: Option<AccountMeta>,
}

/// Build the current account-state response (list + active, no passwords).
async fn account_state(state: &AppState) -> AccountState {
    let guard = state.accounts.read().await;
    let idx = state.active.load(Ordering::SeqCst);
    let active = guard.get(idx).map(|a| AccountMeta {
        server: a.server.clone(),
        username: a.username.clone(),
    });
    AccountState {
        logged_in: active.is_some(),
        server: active.as_ref().map(|a| a.server.clone()),
        username: active.as_ref().map(|a| a.username.clone()),
        accounts: guard
            .iter()
            .map(|a| AccountMeta {
                server: a.server.clone(),
                username: a.username.clone(),
            })
            .collect(),
        active,
    }
}

/// `POST /api/auth/login` — validate, upsert, activate.
pub async fn login(
    State(state): State<AppState>,
    Json(req): Json<LoginRequest>,
) -> Result<Json<ApiOk<AccountState>>, AppError> {
    if req.username.trim().is_empty() {
        return Err(AppError::BadRequest("Username is required.".into()));
    }
    let auth = AuthState {
        server: normalize_server(&req.server)?,
        username: req.username.trim().to_string(),
        password: req.password,
    };

    nextcloud::verify_auth(&state.http, &auth).await?;

    let mut guard = state.accounts.write().await;
    let mut idx = guard
        .iter()
        .position(|a| a.server == auth.server && a.username == auth.username);
    if let Some(i) = idx {
        guard[i] = auth.clone();
    } else {
        guard.push(auth.clone());
        idx = Some(guard.len() - 1);
    }
    state.active.store(idx.unwrap(), Ordering::SeqCst);
    drop(guard);

    tracing::info!(server = %auth.server, username = %auth.username, "login success");
    Ok(Json(ApiOk::new(account_state(&state).await)))
}

/// `GET /api/auth/status` — account list + active (no passwords).
pub async fn status(State(state): State<AppState>) -> Result<Json<ApiOk<AccountState>>, AppError> {
    Ok(Json(ApiOk::new(account_state(&state).await)))
}

/// `POST /api/auth/switch { server, username }` — activate an existing account.
#[derive(Deserialize)]
pub struct SwitchRequest {
    pub server: String,
    pub username: String,
}

pub async fn switch_account(
    State(state): State<AppState>,
    Json(req): Json<SwitchRequest>,
) -> Result<Json<ApiOk<AccountState>>, AppError> {
    let guard = state.accounts.read().await;
    let idx = guard
        .iter()
        .position(|a| a.server == req.server && a.username == req.username)
        .ok_or_else(|| AppError::BadRequest("Account not found.".into()))?;
    drop(guard);
    state.active.store(idx, Ordering::SeqCst);
    tracing::info!(server = %req.server, username = %req.username, "switch account");
    Ok(Json(ApiOk::new(account_state(&state).await)))
}

/// `DELETE /api/auth/account { server, username }` — remove an account.
#[derive(Deserialize)]
pub struct DeleteAccountRequest {
    pub server: String,
    pub username: String,
}

pub async fn delete_account(
    State(state): State<AppState>,
    Json(req): Json<DeleteAccountRequest>,
) -> Result<Json<ApiOk<AccountState>>, AppError> {
    let mut guard = state.accounts.write().await;
    let idx = guard
        .iter()
        .position(|a| a.server == req.server && a.username == req.username)
        .ok_or_else(|| AppError::BadRequest("Account not found.".into()))?;
    guard.remove(idx);
    let active = state.active.load(Ordering::SeqCst);
    if active == idx {
        state.active.store(if guard.is_empty() { usize::MAX } else { 0 }, Ordering::SeqCst);
    } else if active > idx {
        state.active.store(active - 1, Ordering::SeqCst);
    }
    drop(guard);
    tracing::info!(server = %req.server, username = %req.username, "account deleted");
    Ok(Json(ApiOk::new(account_state(&state).await)))
}

/// `POST /api/auth/import` — replace the account list (called at startup by Electron).
#[derive(Deserialize)]
pub struct ImportRequest {
    pub accounts: Vec<LoginRequest>,
}

pub async fn import_accounts(
    State(state): State<AppState>,
    Json(req): Json<ImportRequest>,
) -> Result<Json<ApiOk<AccountState>>, AppError> {
    let count = req.accounts.len();
    let accounts = req
        .accounts
        .into_iter()
        .map(|a| AuthState {
            server: normalize_server(&a.server).unwrap_or_else(|_| a.server),
            username: a.username.trim().to_string(),
            password: a.password,
        })
        .collect::<Vec<_>>();
    *state.accounts.write().await = accounts;
    state.active.store(
        if count == 0 {
            usize::MAX
        } else {
            0
        },
        Ordering::SeqCst,
    );
    tracing::info!(count, "accounts imported");
    Ok(Json(ApiOk::new(account_state(&state).await)))
}

/// `POST /api/auth/logout` — remove the active account (Telegram-style Log out).
pub async fn logout(State(state): State<AppState>) -> Result<Json<ApiOk<AccountState>>, AppError> {
    let idx = state.active.load(Ordering::SeqCst);
    let mut guard = state.accounts.write().await;
    if idx < guard.len() {
        guard.remove(idx);
    }
    state.active.store(if guard.is_empty() { usize::MAX } else { 0 }, Ordering::SeqCst);
    drop(guard);
    tracing::info!("logout");
    Ok(Json(ApiOk::new(account_state(&state).await)))
}

fn normalize_server(input: &str) -> Result<String, AppError> {
    let trimmed = input.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err(AppError::BadRequest("Server URL is required.".into()));
    }
    let mut url = trimmed.to_string();
    if !url.contains("://") {
        url = format!("https://{url}");
    }
    let parsed = reqwest::Url::parse(&url)
        .map_err(|_| AppError::BadRequest("Invalid server URL.".into()))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err(AppError::BadRequest(
            "Server URL must start with http:// or https://".into(),
        ));
    }
    Ok(url.trim_end_matches('/').to_string())
}