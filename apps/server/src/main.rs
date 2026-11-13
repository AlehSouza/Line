//! `line-server`: sobe o servidor Line sozinho (sem o app).
//! Configuração por ambiente: PORT, HOST, DATA_DIR, DB_FILE, JWT_SECRET.
use line_server::{Config, start};

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .init();

    let server = match start(Config::from_env()).await {
        Ok(s) => s,
        Err(e) => {
            eprintln!("Não consegui iniciar o servidor: {e}");
            std::process::exit(1);
        }
    };
    // Os testes de contrato leem esta linha para saber a porta (PORT=0 escolhe uma livre).
    println!("LINE_LISTENING {}", server.addr.port());

    let _ = tokio::signal::ctrl_c().await;
    server.shutdown().await;
}
