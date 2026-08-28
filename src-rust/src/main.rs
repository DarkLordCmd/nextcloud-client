pub mod auth;
pub mod download;
pub mod export;
pub mod models;
pub mod nextcloud;
pub mod server;
pub mod settings;
pub mod upload;

use std::net::SocketAddr;
use std::time::{SystemTime, UNIX_EPOCH};

use tokio::net::TcpListener;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "nextcloud_client=debug,info".into()),
        )
        .init();

    let token = std::env::var("NEXTCLOUD_TOKEN")
        .ok()
        .filter(|t| !t.is_empty())
        .unwrap_or_else(generate_token);

    let state = server::AppState::new(token.clone());
    let port = server::find_free_port(7842).await;
    let app = server::build_router(state);

    let addr = SocketAddr::from(([127, 0, 0, 1], port));
    let listener = match TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            tracing::error!(%e, "failed to bind server socket");
            std::process::exit(1);
        }
    };

    // Signal readiness and the session token to the Electron host.
    println!("READY:{port}:{token}");
    tracing::info!(port, "backend listening");

    if let Err(e) = axum::serve(listener, app).await {
        tracing::error!(%e, "server error");
        std::process::exit(1);
    }
}

/// Generate a random 256-bit session token (hex-encoded). Falls back to a
/// timestamp-based value if the OS randomness source is unavailable.
fn generate_token() -> String {
    let mut buf = [0u8; 32];
    if getrandom::getrandom(&mut buf).is_ok() {
        buf.iter().map(|b| format!("{b:02x}")).collect()
    } else {
        format!(
            "nc-{:x}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or_default()
        )
    }
}
