//! Servidor do Line em Rust: API REST (axum) + gateway em tempo real (Socket.IO) + SQLite.
//!
//! Usado de dois jeitos: como binário (`line-server`) e embutido no app desktop (Tauri),
//! que sobe o servidor junto com a janela.
pub mod auth;
pub mod captcha;
pub mod gifs;
pub mod db;
pub mod errors;
pub mod gateway;
pub mod ids;
pub mod model;
pub mod presence;
pub mod routes;
pub mod store;
pub mod validate;
pub mod voice;

use socketioxide::SocketIo;
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use tokio::sync::oneshot;

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Estado compartilhado por todas as rotas e conexões.
pub struct App {
    pub store: store::Store,
    pub tokens: auth::Tokens,
    pub io: SocketIo,
    pub voice: Mutex<voice::VoiceRegistry>,
    /// Onde ficam os arquivos enviados no chat.
    pub uploads_dir: PathBuf,
    /// Interface web servida na raiz (para usar o Line pelo navegador).
    pub web: Option<WebSource>,
    pub turn: Option<TurnConfig>,
    /// Captcha do cadastro (TURNSTILE_SITE_KEY + TURNSTILE_SECRET). Sem as duas, o cadastro não pede captcha.
    pub turnstile: Option<captcha::Turnstile>,
    pub signups: captcha::SignupLimiter,
    /// Busca de GIFs (GIPHY_API_KEY). Sem a chave, o seletor de GIFs fica indisponível.
    pub giphy: Option<gifs::Giphy>,
}

/// Servidor TURN (coturn com `use-auth-secret`): gera credenciais temporárias por usuário.
#[derive(Clone, Debug)]
pub struct TurnConfig {
    /// Ex.: ["turn:line.exemplo.com:3478", "turn:line.exemplo.com:3478?transport=tcp"]
    pub urls: Vec<String>,
    pub secret: String,
}

impl TurnConfig {
    /// TURN_URLS (separadas por vírgula) e TURN_SECRET.
    pub fn from_env() -> Option<Self> {
        let urls: Vec<String> = std::env::var("TURN_URLS")
            .ok()?
            .split(',')
            .map(|u| u.trim().to_string())
            .filter(|u| !u.is_empty())
            .collect();
        let secret = std::env::var("TURN_SECRET").ok().filter(|s| !s.is_empty())?;
        (!urls.is_empty()).then_some(Self { urls, secret })
    }
}

/// Lê um arquivo da interface: caminho relativo ("index.html") → (bytes, tipo MIME).
pub type WebAssets = Arc<dyn Fn(&str) -> Option<(Vec<u8>, String)> + Send + Sync>;

/// De onde vem a interface web: uma pasta (`WEB_DIR`, no servidor de VPS) ou
/// os arquivos embutidos no app desktop.
#[derive(Clone)]
pub enum WebSource {
    Dir(PathBuf),
    Assets(WebAssets),
}

impl std::fmt::Debug for WebSource {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            WebSource::Dir(d) => write!(f, "Dir({})", d.display()),
            WebSource::Assets(_) => write!(f, "Assets"),
        }
    }
}

#[derive(Clone, Debug)]
pub struct Config {
    pub port: u16,
    pub host: String,
    pub data_dir: PathBuf,
    /// ":memory:" nos testes
    pub db_file: String,
    pub jwt_secret: Option<String>,
    pub web: Option<WebSource>,
    pub turn: Option<TurnConfig>,
}

impl Config {
    /// Lê PORT, HOST, DATA_DIR, DB_FILE e JWT_SECRET do ambiente.
    pub fn from_env() -> Self {
        let data_dir = std::env::var("DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("./data"));
        Self {
            port: std::env::var("PORT")
                .ok()
                .and_then(|p| p.parse().ok())
                .unwrap_or(4000),
            host: std::env::var("HOST").unwrap_or_else(|_| "0.0.0.0".into()),
            db_file: std::env::var("DB_FILE")
                .unwrap_or_else(|_| data_dir.join("line.db").to_string_lossy().into_owned()),
            data_dir,
            jwt_secret: std::env::var("JWT_SECRET").ok(),
            web: std::env::var("WEB_DIR").ok().map(|d| WebSource::Dir(d.into())),
            turn: TurnConfig::from_env(),
        }
    }

    pub fn with_data_dir(data_dir: impl Into<PathBuf>) -> Self {
        let data_dir = data_dir.into();
        Self {
            db_file: data_dir.join("line.db").to_string_lossy().into_owned(),
            data_dir,
            ..Self::from_env()
        }
    }
}

/// Servidor rodando. Solte com `shutdown()`.
pub struct RunningServer {
    pub addr: SocketAddr,
    shutdown: Option<oneshot::Sender<()>>,
    io: SocketIo,
    task: tokio::task::JoinHandle<()>,
}

impl RunningServer {
    pub async fn shutdown(mut self) {
        self.io.close().await;
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
        let _ = self.task.await;
    }
}

/// Sobe o servidor. Usado pelo binário e pelo servidor embutido no app desktop.
pub async fn start(config: Config) -> std::io::Result<RunningServer> {
    let in_memory = config.db_file == ":memory:";
    if !in_memory {
        std::fs::create_dir_all(&config.data_dir)?;
    }
    let conn = db::open_database(&config.db_file).map_err(std::io::Error::other)?;
    let secret =
        auth::resolve_jwt_secret(&config.data_dir, config.jwt_secret.as_deref(), !in_memory);

    let listener = tokio::net::TcpListener::bind((config.host.as_str(), config.port)).await?;
    let addr = listener.local_addr()?;

    let (app, io, router) = build(conn, &secret, config.data_dir.join("uploads"), config.web.clone(), config.turn.clone());
    app.sweep_uploads();
    drop(app);

    let (tx, rx) = oneshot::channel::<()>();
    let task = tokio::spawn(async move {
        let serve = axum::serve(listener, router).with_graceful_shutdown(async {
            let _ = rx.await;
        });
        if let Err(e) = serve.await {
            tracing::error!("servidor parou com erro: {e}");
        }
    });
    tracing::info!(
        "Servidor Line rodando em http://localhost:{} (dados em {})",
        addr.port(),
        config.data_dir.display()
    );
    Ok(RunningServer {
        addr,
        shutdown: Some(tx),
        io,
        task,
    })
}

/// Monta o estado, o Socket.IO e as rotas.
pub fn build(
    conn: rusqlite::Connection,
    secret: &[u8],
    uploads_dir: PathBuf,
    web: Option<WebSource>,
    turn: Option<TurnConfig>,
) -> (Arc<App>, SocketIo, axum::Router) {
    // O estado precisa do handle do Socket.IO e o Socket.IO precisa do estado:
    // criamos o handle primeiro e passamos o estado depois por uma célula.
    let cell: Arc<std::sync::OnceLock<Arc<App>>> = Arc::new(std::sync::OnceLock::new());
    let (layer, io) = SocketIo::builder()
        .with_state(AppRef(cell.clone()))
        .build_layer();
    let app = Arc::new(App {
        store: store::Store::new(conn),
        tokens: auth::Tokens::new(secret),
        io: io.clone(),
        voice: Mutex::new(voice::VoiceRegistry::default()),
        uploads_dir,
        web,
        turn,
        turnstile: captcha::Turnstile::from_env(),
        signups: captcha::SignupLimiter::new(),
        giphy: gifs::Giphy::from_env(),
    });
    let _ = cell.set(app.clone());
    gateway::register(&io);
    let router = routes::router(app.clone(), layer);
    (app, io, router)
}

/// Referência ao estado que o Socket.IO entrega aos handlers.
#[derive(Clone)]
pub struct AppRef(Arc<std::sync::OnceLock<Arc<App>>>);

impl AppRef {
    pub fn get(&self) -> &Arc<App> {
        self.0.get().expect("estado do app")
    }
}

impl std::ops::Deref for AppRef {
    type Target = App;
    fn deref(&self) -> &App {
        self.get()
    }
}

impl App {
    /// Apaga do disco os arquivos que não pertencem mais a nenhum anexo
    /// (mensagem, canal ou servidor apagados) e anexos nunca usados há mais de um dia.
    pub fn sweep_uploads(&self) {
        let keep: std::collections::HashSet<String> = {
            let q = self.store.q();
            q.prune_unused_attachments();
            q.all_attachment_ids().into_iter().collect()
        };
        let Ok(entries) = std::fs::read_dir(&self.uploads_dir) else {
            return;
        };
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if !keep.contains(&name) {
                let _ = std::fs::remove_file(e.path());
            }
        }
    }

    pub fn remove_upload_files(&self, ids: &[String]) {
        for id in ids {
            let _ = std::fs::remove_file(self.uploads_dir.join(id));
        }
    }
}
