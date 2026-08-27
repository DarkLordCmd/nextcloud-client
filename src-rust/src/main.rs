pub mod auth;
pub mod download;
pub mod models;
pub mod nextcloud;
pub mod server;
pub mod upload;

use std::net::SocketAddr;

use tokio::net::TcpListener;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "nextcloud_client=debug,info".into()),
        )
        .init();

    let state = server::AppState::new();
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

    // Signal readiness to the Electron host so it knows which port to use.
    println!("READY:{port}");
    tracing::info!(port, "backend listening");

    if let Err(e) = axum::serve(listener, app).await {
        tracing::error!(%e, "server error");
        std::process::exit(1);
    }
}
