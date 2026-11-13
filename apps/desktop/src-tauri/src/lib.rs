//! Casco desktop do Line em Rust (Tauri 2).
//!
//! Troca o Electron: em vez de levar um Chromium inteiro, usa o WebView2 que já vem no Windows.
//! A interface continua sendo o export estático do Next (pasta `out/`), e o servidor Line
//! roda embutido no mesmo processo, sem Node.
use line_server::{Config, RunningServer};
use std::sync::Mutex;
use tauri::webview::{NewWindowResponse, PermissionKind, PermissionResponse};
use tauri::{
    Manager, RunEvent, UserAttentionType, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    WindowEvent,
};
use tauri_plugin_opener::OpenerExt;

const MAIN: &str = "main";

/// Servidor embutido (se subiu). Fica no estado do app para desligar ao sair.
struct Embedded(Mutex<Option<RunningServer>>);

#[tauri::command]
fn window_minimize(window: WebviewWindow) {
    let _ = window.minimize();
}

#[tauri::command]
fn window_toggle_maximize(window: WebviewWindow) -> bool {
    let max = window.is_maximized().unwrap_or(false);
    let _ = if max { window.unmaximize() } else { window.maximize() };
    !max
}

#[tauri::command]
fn window_is_maximized(window: WebviewWindow) -> bool {
    window.is_maximized().unwrap_or(false)
}

#[tauri::command]
fn window_close(window: WebviewWindow) {
    let _ = window.close();
}

/// Procura versão nova no servidor de atualizações. Devolve a versão, ou nada se já está em dia.
#[tauri::command]
async fn update_check(app: tauri::AppHandle) -> Option<String> {
    use tauri_plugin_updater::UpdaterExt;
    match app.updater().ok()?.check().await {
        Ok(update) => update.map(|u| u.version),
        Err(err) => {
            tracing::warn!("falha ao procurar atualização: {err}");
            None
        }
    }
}

/// Baixa, confere a assinatura, instala e reinicia o app.
#[tauri::command]
async fn update_install(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;
    let update = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Nenhuma atualização disponível.".to_string())?;
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    app.restart();
}

#[tauri::command]
fn request_attention(window: WebviewWindow) {
    if !window.is_focused().unwrap_or(true) {
        let _ = window.request_user_attention(Some(UserAttentionType::Informational));
    }
}

#[tauri::command]
fn set_badge(window: WebviewWindow, count: i64) {
    #[cfg(windows)]
    {
        // O Windows não tem número no ícone; mostramos uma bolinha vermelha por cima.
        let _ = window.set_overlay_icon(if count > 0 { Some(badge_dot()) } else { None });
    }
    #[cfg(not(windows))]
    {
        let _ = window.set_badge_count(if count > 0 { Some(count) } else { None });
    }
}

#[cfg(windows)]
fn badge_dot() -> tauri::image::Image<'static> {
    const SIZE: u32 = 16;
    let mut rgba = Vec::with_capacity((SIZE * SIZE * 4) as usize);
    let c = (SIZE as f32 - 1.0) / 2.0;
    for y in 0..SIZE {
        for x in 0..SIZE {
            let d = ((x as f32 - c).powi(2) + (y as f32 - c).powi(2)).sqrt();
            let alpha = ((c + 0.5 - d).clamp(0.0, 1.0) * 255.0) as u8;
            rgba.extend_from_slice(&[0xe5, 0x48, 0x4d, alpha]);
        }
    }
    tauri::image::Image::new_owned(rgba, SIZE, SIZE)
}

/// Servidor embutido: o próprio app hospeda um servidor Line na porta 4000,
/// com os dados na pasta do usuário. Assim o .exe funciona sozinho, e seus amigos
/// podem se conectar no seu IP. Se a porta já estiver em uso (outro servidor rodando),
/// o app só usa o que já existe. Desligue com LINE_EMBEDDED_SERVER=0.
fn start_embedded_server(app: &tauri::App) -> Option<RunningServer> {
    if std::env::var("LINE_EMBEDDED_SERVER").as_deref() == Ok("0") {
        return None;
    }
    let data_dir = app.path().app_data_dir().ok()?.join("server");
    if let Ok(config_dir) = app.path().config_dir() {
        migrate_from_electron(&config_dir.join("Line").join("server"), &data_dir);
    }
    let config = Config {
        port: std::env::var("LINE_SERVER_PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(4000),
        host: "0.0.0.0".into(),
        // A interface também fica em http://IP:4000/, para quem quiser entrar pelo navegador.
        web: Some(line_server::WebSource::Assets(web_assets(app))),
        ..Config::with_data_dir(data_dir)
    };
    match tauri::async_runtime::block_on(line_server::start(config)) {
        Ok(server) => Some(server),
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => None,
        Err(e) => {
            tracing::error!("Falha ao iniciar o servidor embutido: {e}");
            None
        }
    }
}

fn web_assets(app: &tauri::App) -> line_server::WebAssets {
    let handle = app.handle().clone();
    std::sync::Arc::new(move |path: &str| {
        handle
            .asset_resolver()
            .get(path.to_string())
            .map(|a| (a.bytes, a.mime_type))
    })
}

/// A versão Electron guardava o servidor embutido em `%APPDATA%\Line\server`.
/// Na primeira vez que o app Tauri abre, copia o banco e o segredo dos tokens de lá,
/// para ninguém perder contas, servidores e mensagens. O original fica intacto.
fn migrate_from_electron(old: &std::path::Path, new: &std::path::Path) {
    if new.join("line.db").exists() || !old.join("line.db").exists() {
        return;
    }
    if std::fs::create_dir_all(new).is_err() {
        return;
    }
    for name in ["line.db", "line.db-wal", "line.db-shm", "jwt-secret"] {
        let from = old.join(name);
        if from.exists()
            && let Err(e) = std::fs::copy(&from, new.join(name))
        {
            tracing::warn!("não consegui copiar {}: {e}", from.display());
        }
    }
    tracing::info!("dados do Line (Electron) copiados de {}", old.display());
}

/// URLs que pertencem ao app (o resto abre no navegador padrão).
fn is_app_url(url: &tauri::Url) -> bool {
    match url.scheme() {
        "http" | "https" => matches!(
            url.host_str(),
            Some("tauri.localhost" | "localhost" | "127.0.0.1")
        ),
        _ => true,
    }
}

fn create_window(app: &tauri::App) -> tauri::Result<WebviewWindow> {
    let opener = app.handle().clone();
    let opener2 = app.handle().clone();
    let window = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::App("index.html".into()))
        .title("Line")
        // Sem a barra do Windows: a interface desenha a própria (com arrastar, minimizar etc).
        .decorations(false)
        .shadow(true)
        .inner_size(1280.0, 800.0)
        .min_inner_size(940.0, 560.0)
        .background_color(tauri::webview::Color(0x0a, 0x0a, 0x0c, 0xff))
        .visible(false)
        .initialization_script(include_str!("bridge.js"))
        // Microfone, câmera e notificações sem perguntar de novo: o app inteiro é nosso.
        .on_permission_request(|_, kind| match kind {
            PermissionKind::Microphone
            | PermissionKind::Camera
            | PermissionKind::Notifications
            | PermissionKind::ClipboardRead => PermissionResponse::Allow,
            _ => PermissionResponse::Default,
        })
        // Links externos abrem no navegador padrão.
        .on_new_window(move |url, _| {
            if matches!(url.scheme(), "http" | "https" | "mailto") {
                let _ = opener.opener().open_url(url.as_str(), None::<&str>);
            }
            NewWindowResponse::Deny
        })
        .on_navigation(move |url| {
            if is_app_url(url) {
                return true;
            }
            let _ = opener2.opener().open_url(url.as_str(), None::<&str>);
            false
        })
        .build()?;

    #[cfg(target_os = "linux")]
    enable_linux_media(&window);

    let w = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::Focused(true) = event {
            let _ = w.request_user_attention(None);
        }
    });

    #[cfg(debug_assertions)]
    if std::env::var("LINE_DEVTOOLS").as_deref() != Ok("0") {
        window.open_devtools();
    }
    Ok(window)
}

pub fn run() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .try_init();

    let app = tauri::Builder::default()
        // Uma janela só: abrir o Line de novo traz a janela que já existe para frente.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window(MAIN) {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            request_attention,
            set_badge,
            window_minimize,
            window_toggle_maximize,
            window_is_maximized,
            window_close,
            update_check,
            update_install
        ])
        .setup(|app| {
            let server = start_embedded_server(app);
            app.manage(Embedded(Mutex::new(server)));
            let window = create_window(app)?;
            // Mostra só depois de carregar, sem piscar branco.
            window.show()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("erro ao iniciar o Line");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            let server = handle
                .state::<Embedded>()
                .0
                .lock()
                .ok()
                .and_then(|mut s| s.take());
            if let Some(server) = server {
                tauri::async_runtime::block_on(server.shutdown());
            }
        }
    });
}

/// No Linux o WebKitGTK vem com WebRTC e captura de mídia desligados:
/// sem isso não existe `RTCPeerConnection` e as chamadas não funcionam.
#[cfg(target_os = "linux")]
fn enable_linux_media(window: &WebviewWindow) {
    use webkit2gtk::{PermissionRequestExt, SettingsExt, WebViewExt};
    let _ = window.with_webview(|wv| {
        let view = wv.inner();
        if let Some(settings) = WebViewExt::settings(&view) {
            settings.set_enable_webrtc(true);
            settings.set_enable_media_stream(true);
            settings.set_enable_mediasource(true);
            settings.set_enable_media_capabilities(true);
            settings.set_media_playback_requires_user_gesture(false);
        }
        // Microfone, câmera, tela e notificações: o app inteiro é nosso, então libera.
        view.connect_permission_request(|_, req| {
            req.allow();
            true
        });
    });
}
