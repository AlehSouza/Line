//! Casco desktop do Line em Rust (Tauri 2).
//!
//! Troca o Electron: em vez de levar um Chromium inteiro, usa o WebView2 que já vem no Windows.
//! A interface continua sendo o export estático do Next (pasta `out/`), e o servidor Line
//! roda embutido no mesmo processo, sem Node.
use tauri::webview::{NewWindowResponse, PermissionKind, PermissionResponse};
use tauri::{
    Manager, UserAttentionType, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    WindowEvent,
};
use tauri_plugin_opener::OpenerExt;

#[cfg(windows)]
mod loopback;
#[cfg(windows)]
mod screen;
#[cfg(target_os = "macos")]
mod screen_mac;
#[cfg(target_os = "macos")]
use screen_mac as screen;

const MAIN: &str = "main";

/// Servidor embutido (se subiu). Fica no estado do app para desligar ao sair.

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
    // Com a bandeja, o X só esconde: o app continua rodando em segundo plano.
    #[cfg(any(windows, target_os = "macos"))]
    let _ = window.hide();
    #[cfg(not(any(windows, target_os = "macos")))]
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

const SPLASH: &str = "splash";

/// Opções do WebView2 (as mesmas em todas as janelas, senão o segundo ambiente falha).
/// As três primeiras são as padrão do Tauri. O resto impede o Chromium de frear a página quando
/// o Line fica atrás de um jogo em tela cheia: sem isso os timers, a cópia dos quadros da tela
/// e o encoder do WebRTC rodam em prioridade baixa e a transmissão perde fps e qualidade.
const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion \
    --disable-background-timer-throttling --disable-renderer-backgrounding \
    --disable-backgrounding-occluded-windows --disable-ipc-flooding-protection";

fn create_splash(app: &tauri::AppHandle) -> tauri::Result<WebviewWindow> {
    WebviewWindowBuilder::new(app, SPLASH, WebviewUrl::App("splash.html".into()))
        .title("Line")
        .decorations(false)
        .resizable(false)
        .shadow(true)
        .inner_size(300.0, 340.0)
        .center()
        .skip_taskbar(false)
        .background_color(tauri::webview::Color(0x1a, 0x1a, 0x1f, 0xff))
        .additional_browser_args(BROWSER_ARGS)
        .build()
}

fn splash_status(splash: &WebviewWindow, text: &str, pct: Option<f64>) {
    let pct = pct.map_or("null".to_string(), |p| format!("{p:.0}"));
    let text = serde_json::to_string(text).unwrap_or_default();
    let _ = splash.eval(format!("window.lineSplash && window.lineSplash({text}, {pct})"));
}

/// Procura, baixa e instala a atualização mostrando o andamento na janelinha.
/// No Windows o instalador fecha o app e abre a versão nova sozinho; aqui só voltamos se
/// não houver atualização ou se algo falhar (aí o app abre normalmente).
async fn startup_update(app: &tauri::AppHandle, splash: &WebviewWindow) -> bool {
    use std::time::Duration;
    use tauri_plugin_updater::UpdaterExt;
    let updater = match app.updater_builder().timeout(Duration::from_secs(20)).build() {
        Ok(u) => u,
        Err(err) => {
            tracing::warn!("atualizador indisponível: {err}");
            return false;
        }
    };
    let check = tokio::time::timeout(Duration::from_secs(8), updater.check()).await;
    let update = match check {
        Ok(Ok(Some(update))) => update,
        Ok(Ok(None)) => return false,
        Ok(Err(err)) => {
            tracing::warn!("falha ao procurar atualização: {err}");
            return false;
        }
        Err(_) => {
            tracing::warn!("procura de atualização demorou demais");
            return false;
        }
    };
    splash_status(splash, &format!("Baixando a versão {}...", update.version), Some(0.0));
    let mut got = 0usize;
    let mut last = -1.0f64;
    let s2 = splash.clone();
    let result = update
        .download_and_install(
            |chunk, total| {
                got += chunk;
                if let Some(total) = total.filter(|t| *t > 0) {
                    let pct = (got as f64 / total as f64 * 100.0).floor();
                    if pct > last {
                        last = pct;
                        splash_status(&s2, "Baixando atualização...", Some(pct));
                    }
                }
            },
            || splash_status(&s2, "Instalando...", None),
        )
        .await;
    match result {
        // macOS: a versão nova já está no lugar, só reabrir.
        Ok(()) => app.restart(),
        Err(err) => {
            tracing::warn!("falha ao instalar atualização: {err}");
            splash_status(splash, "Não deu para atualizar agora. Abrindo o Line...", Some(-1.0));
            tokio::time::sleep(Duration::from_millis(1500)).await;
        }
    }
    true
}

/// Botão "Procurar atualizações" das Configurações: mesma janelinha da abertura.
#[tauri::command]
async fn update_run(app: tauri::AppHandle) -> Result<(), String> {
    run_update_window(app).await
}

async fn run_update_window(app: tauri::AppHandle) -> Result<(), String> {
    if app.get_webview_window(SPLASH).is_some() {
        return Ok(());
    }
    let splash = create_splash(&app).map_err(|e| e.to_string())?;
    if !startup_update(&app, &splash).await {
        splash_status(&splash, "Você já está na versão mais nova.", Some(-1.0));
        tokio::time::sleep(std::time::Duration::from_millis(1800)).await;
    }
    let _ = splash.close();
    Ok(())
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window(MAIN) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Ícone na bandeja: clique reabre a janela; o menu confere atualizações ou sai do app.
#[cfg(any(windows, target_os = "macos"))]
fn create_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let title = MenuItemBuilder::with_id("title", "Line").enabled(false).build(app)?;
    let updates = MenuItemBuilder::with_id("updates", "Conferir atualizações").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "Sair do Line").build(app)?;
    let menu = MenuBuilder::new(app)
        .item(&title)
        .separator()
        .item(&updates)
        .separator()
        .item(&quit)
        .build()?;

    let mut tray = TrayIconBuilder::with_id("line")
        .tooltip("Line")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "updates" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = run_update_window(app).await;
                });
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
}

fn open_main(app: &tauri::AppHandle) {
    match create_window(app) {
        // Mostra só depois de carregar, sem piscar branco.
        Ok(window) => {
            let _ = window.show();
            let _ = window.set_focus();
        }
        Err(err) => tracing::error!("não abriu a janela principal: {err}"),
    }
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

fn create_window(app: &tauri::AppHandle) -> tauri::Result<WebviewWindow> {
    let opener = app.clone();
    let opener2 = app.clone();
    let window = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::App("index.html".into()))
        .title("Line")
        // Sem a barra do Windows: a interface desenha a própria (com arrastar, minimizar etc).
        .decorations(false)
        .shadow(true)
        .inner_size(1280.0, 800.0)
        .min_inner_size(940.0, 560.0)
        .background_color(tauri::webview::Color(0x0a, 0x0a, 0x0c, 0xff))
        .visible(false)
        // Arrastar arquivos para o chat usa o drop do HTML (o do Tauri esconderia os arquivos da página).
        .disable_drag_drop_handler()
        .additional_browser_args(BROWSER_ARGS)
        .initialization_script(
            include_str!("bridge.js").replace("__LINE_VERSION__", &app.package_info().version.to_string()),
        )
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
    window.on_window_event(move |event| match event {
        WindowEvent::Focused(true) => {
            let _ = w.request_user_attention(None);
        }
        // Fechar (X, Alt+F4) só esconde; sair de verdade é pelo menu da bandeja.
        #[cfg(any(windows, target_os = "macos"))]
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            let _ = w.hide();
        }
        _ => {}
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
            show_main(app);
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
            update_install,
            update_run,
            #[cfg(any(windows, target_os = "macos"))]
            screen::screen_sources,
            #[cfg(any(windows, target_os = "macos"))]
            screen::screen_start,
            #[cfg(any(windows, target_os = "macos"))]
            screen::screen_stop
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            #[cfg(any(windows, target_os = "macos"))]
            create_tray(&handle)?;
            // Windows e macOS: antes de abrir o app, uma janelinha procura atualização,
            // baixa e instala. Sem atualização (ou sem internet), segue direto para o app.
            if cfg!(any(windows, target_os = "macos")) && !cfg!(debug_assertions) {
                let splash = create_splash(&handle)?;
                tauri::async_runtime::spawn(async move {
                    startup_update(&handle, &splash).await;
                    open_main(&handle);
                    let _ = splash.close();
                });
            } else {
                open_main(&handle);
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("erro ao iniciar o Line");

    app.run(|_, _| {});
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
