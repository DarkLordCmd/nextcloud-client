use axum::{Json, extract::State};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::{
    models::{ApiOk, AppError},
    nextcloud,
    server::AppState,
};

/// Saved connection credentials. Stored in-memory only.
#[derive(Debug, Clone)]
pub struct AuthState {
    pub server: String,
    pub username: String,
    pub password: String,
    pub remember: bool,
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

/// Read the current credentials or return `NotAuthenticated`.
pub async fn require_auth(state: &AppState) -> Result<AuthState, AppError> {
    let guard = state.auth.read().await;
    guard.clone().ok_or(AppError::NotAuthenticated)
}

#[derive(Deserialize)]
pub struct LoginRequest {
    pub server: String,
    pub username: String,
    pub password: String,
    #[serde(default)]
    pub remember: bool,
}

#[derive(Serialize)]
pub struct LoginResponse {
    pub server: String,
    pub username: String,
}

/// `POST /api/auth/login` — validate the connection against NextCloud,
/// then persist the credentials in memory.
pub async fn login(
    State(state): State<AppState>,
    Json(req): Json<LoginRequest>,
) -> Result<Json<ApiOk<LoginResponse>>, AppError> {
    if req.username.trim().is_empty() {
        return Err(AppError::BadRequest("Username is required.".into()));
    }
    let auth = AuthState {
        server: normalize_server(&req.server)?,
        username: req.username.trim().to_string(),
        password: req.password,
        remember: req.remember,
    };

    nextcloud::verify_auth(&state.http, &auth).await?;

    *state.auth.write().await = Some(auth.clone());
    tracing::info!(server = %auth.server, username = %auth.username, "login success");
    Ok(Json(ApiOk::new(LoginResponse {
        server: auth.server,
        username: auth.username,
    })))
}

/// `GET /api/auth/status` — report whether credentials are present.
pub async fn status(State(state): State<AppState>) -> Result<Json<ApiOk<Value>>, AppError> {
    let logged_in = state.auth.read().await.as_ref().map(|a| {
        json!({
            "logged_in": true,
            "server": a.server,
            "username": a.username,
        })
    });
    Ok(Json(ApiOk::new(
        logged_in.unwrap_or(json!({ "logged_in": false })),
    )))
}

/// `POST /api/auth/logout` — clear the in-memory credentials.
pub async fn logout(State(state): State<AppState>) -> Result<Json<ApiOk<Value>>, AppError> {
    *state.auth.write().await = None;
    tracing::info!("logout");
    Ok(Json(ApiOk::new(json!({ "logged_in": false }))))
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
