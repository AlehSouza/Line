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
mod games;
/// Fora do Windows não há detecção de jogos (o painel some sozinho).
#[cfg(not(windows))]
mod games {
    #[tauri::command]
    pub async fn game_running() -> Option<()> {
        None
    }
}
#[cfg(windows)]
mod ducking;
#[cfg(windows)]
mod loopback;
#[cfg(windows)]
mod toast;
#[cfg(target_os = "linux")]
mod rtc;
#[cfg(windows)]
mod screen;
#[cfg(target_os = "macos")]
mod screen_mac;
#[cfg(target_os = "macos")]
use screen_mac as screen;
#[cfg(target_os = "linux")]
mod screen_linux;
#[cfg(target_os = "linux")]
use screen_linux as screen;

const MAIN: &str = "main";

/// Tamanho, posição e maximizado da janela principal, lembrados para quando o app reinicia na atualização.
/// Tela cheia fica de fora: ela é só da transmissão em tela cheia, que não volta sozinha.
fn window_flags() -> tauri_plugin_window_state::StateFlags {
    use tauri_plugin_window_state::StateFlags;
    StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED
}

/// Este processo abriu logo depois de uma atualização (o app reiniciou sozinho). Só aí a janela e a
/// tela voltam como estavam; abrir do zero vai para o Início, maximizado.
static JUST_UPDATED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn just_updated() -> bool {
    JUST_UPDATED.load(std::sync::atomic::Ordering::SeqCst)
}

/// Salva o estado da janela um pouco depois de parar de mover/redimensionar. A atualização fecha o
/// processo direto (sem o evento de saída), então o arquivo precisa estar sempre em dia.
fn save_window_state_soon(app: &tauri::AppHandle) {
    use std::sync::atomic::{AtomicU64, Ordering};
    static GEN: AtomicU64 = AtomicU64::new(0);
    let ticket = GEN.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(600)).await;
        if GEN.load(Ordering::SeqCst) == ticket {
            // Na thread principal: fora dela o plugin segura o lock do estado enquanto espera a
            // thread principal responder (is_maximized/outer_position), e ela, num Moved/Resized,
            // espera o mesmo lock. O app travava ("Não está respondendo") logo depois de atualizar.
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || {
                use tauri_plugin_window_state::AppHandleExt;
                let _ = handle.save_window_state(window_flags());
            });
        }
    });
}

/// Argumento que o sistema passa quando abre o Line ao ligar o computador.
const AUTOSTART_ARG: &str = "--autostart";

/// Preferências de "Iniciar com o computador" que o Rust precisa antes de abrir a janela.
#[derive(serde::Serialize, serde::Deserialize, Clone, Copy)]
#[serde(rename_all = "camelCase")]
struct StartupPrefs {
    #[serde(default = "yes")]
    minimized: bool,
}

fn yes() -> bool {
    true
}

fn startup_prefs_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("startup.json"))
}

fn load_startup_prefs(app: &tauri::AppHandle) -> StartupPrefs {
    startup_prefs_path(app)
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(StartupPrefs { minimized: true })
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct StartupState {
    enabled: bool,
    minimized: bool,
}

/// Estado de "Iniciar com o computador". Nada (null) quando não dá: versão da Store, onde
/// o Windows controla isso sozinho em Configurações > Aplicativos > Inicialização.
#[tauri::command]
fn startup_get(app: tauri::AppHandle) -> Option<StartupState> {
    use tauri_plugin_autostart::ManagerExt;
    if from_store() {
        return None;
    }
    let enabled = app.autolaunch().is_enabled().unwrap_or(false);
    Some(StartupState { enabled, minimized: load_startup_prefs(&app).minimized })
}

#[tauri::command]
fn startup_set(app: tauri::AppHandle, enabled: bool, minimized: bool) -> Result<(), String> {
    use tauri_plugin_autostart::ManagerExt;
    if from_store() {
        return Err("Na versão da Microsoft Store, ative em Configurações do Windows > Aplicativos > Inicialização.".into());
    }
    if let Some(path) = startup_prefs_path(&app) {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(path, serde_json::to_vec(&StartupPrefs { minimized }).unwrap_or_default());
    }
    let auto = app.autolaunch();
    let now = auto.is_enabled().unwrap_or(false);
    let res = match (enabled, now) {
        (true, _) => auto.enable(),
        (false, true) => auto.disable(),
        (false, false) => Ok(()),
    };
    res.map_err(|e| format!("Não deu para mudar a inicialização: {e}"))
}

/// Marca "acabei de instalar uma atualização". O instalador reabre o Line com os mesmos
/// argumentos da abertura anterior: se ela veio do sistema (`--autostart`), sem esta marca o app
/// novo voltaria escondido na bandeja em vez de mostrar a janela.
fn updated_marker_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("just-updated"))
}

fn mark_updating(app: &tauri::AppHandle) {
    if let Some(path) = updated_marker_path(app) {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(path, b"1");
    }
}

/// Abriu logo depois de uma atualização? Apaga a marca (vale uma vez só) e diz se ela era recente.
fn take_updated_marker(app: &tauri::AppHandle) -> bool {
    let Some(path) = updated_marker_path(app) else { return false };
    let fresh = std::fs::metadata(&path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.elapsed().ok())
        .is_some_and(|age| age < std::time::Duration::from_secs(15 * 60));
    let _ = std::fs::remove_file(&path);
    fresh
}

/// Aberto pelo sistema ao ligar o computador, com "abrir minimizado" ligado?
/// Depois de uma atualização a janela sempre aparece, mesmo que a abertura anterior tenha sido essa.
fn start_hidden(app: &tauri::AppHandle) -> bool {
    let updated = take_updated_marker(app);
    JUST_UPDATED.store(updated, std::sync::atomic::Ordering::SeqCst);
    !updated && std::env::args().any(|a| a == AUTOSTART_ARG) && load_startup_prefs(app).minimized
}

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

/// Tela cheia de verdade (cobre a barra de tarefas): usada no modo "só a transmissão" da chamada.
#[tauri::command]
fn window_set_fullscreen(window: WebviewWindow, on: bool) {
    let _ = window.set_fullscreen(on);
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

/// Instalado pela Microsoft Store (pacote MSIX)? Aí quem atualiza é a Store: a pasta do app
/// (WindowsApps) é só leitura e as regras da Store proíbem o app de se atualizar sozinho.
fn from_store() -> bool {
    cfg!(windows)
        && std::env::current_exe()
            .map(|p| p.to_string_lossy().to_ascii_lowercase().contains("\\windowsapps\\"))
            .unwrap_or(false)
}

/// Na versão da Store, "atualizar" abre a página do Line na Store.
fn open_store_updates(app: &tauri::AppHandle) {
    let _ = app.opener().open_url("ms-windows-store://pdp/?ProductId=9NJ9ZQ9T92QR", None::<&str>);
}

/// Procura versão nova no servidor de atualizações. Devolve a versão, ou nada se já está em dia.
#[tauri::command]
async fn update_check(app: tauri::AppHandle) -> Option<String> {
    use tauri_plugin_updater::UpdaterExt;
    if from_store() || cfg!(debug_assertions) {
        return None;
    }
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
    if from_store() {
        open_store_updates(&app);
        return Ok(());
    }
    let update = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "Nenhuma atualização disponível.".to_string())?;
    mark_updating(&app);
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| {
            let _ = take_updated_marker(&app);
            e.to_string()
        })?;
    app.restart();
}

const SPLASH: &str = "splash";

/// Opções do WebView2 (as mesmas em todas as janelas, senão o segundo ambiente falha).
/// As três primeiras são as padrão do Tauri. O resto impede o Chromium de frear a página quando
/// o Line fica atrás de um jogo em tela cheia: sem isso os timers, a cópia dos quadros da tela
/// e o encoder do WebRTC rodam em prioridade baixa e a transmissão perde fps e qualidade.
const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion,IntensiveWakeUpThrottling,UseEcoQoSForBackgroundProcess \
    --disable-background-timer-throttling --disable-renderer-backgrounding \
    --disable-backgrounding-occluded-windows --disable-ipc-flooding-protection";

/// Sem aceleração de hardware: o Chromium do WebView2 desenha tudo na CPU.
const NO_GPU_ARGS: &str = " --disable-gpu --disable-gpu-compositing";

fn browser_args(app: &tauri::AppHandle) -> String {
    if hardware_accel(app) {
        BROWSER_ARGS.to_string()
    } else {
        format!("{BROWSER_ARGS}{NO_GPU_ARGS}")
    }
}

fn gpu_prefs_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("gpu.json"))
}

#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct GpuPrefs {
    #[serde(default = "yes")]
    enabled: bool,
}

/// Aceleração de hardware (ligada por padrão). Lida ao abrir as janelas; mudar pede reiniciar.
fn hardware_accel(app: &tauri::AppHandle) -> bool {
    gpu_prefs_path(app)
        .and_then(|p| std::fs::read(p).ok())
        .and_then(|b| serde_json::from_slice::<GpuPrefs>(&b).ok())
        .map_or(true, |p| p.enabled)
}

/// Estado da aceleração de hardware. Nada (null) no macOS, onde o sistema decide sozinho.
#[tauri::command]
fn gpu_get(app: tauri::AppHandle) -> Option<bool> {
    if cfg!(target_os = "macos") {
        return None;
    }
    Some(hardware_accel(&app))
}

/// Grava a escolha; vale na próxima abertura (restart = true reabre o Line agora).
#[tauri::command]
fn gpu_set(app: tauri::AppHandle, enabled: bool, restart: bool) -> Result<(), String> {
    let path = gpu_prefs_path(&app).ok_or("Não deu para salvar a preferência.")?;
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    std::fs::write(path, serde_json::to_vec(&GpuPrefs { enabled }).unwrap_or_default())
        .map_err(|e| format!("Não deu para salvar a preferência: {e}"))?;
    if restart {
        app.restart();
    }
    Ok(())
}

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
        .additional_browser_args(&browser_args(app))
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
    // Versão de desenvolvimento (0.1.0): sem isso ela se "atualiza" para a instalada e fecha.
    if from_store() || cfg!(debug_assertions) {
        return false;
    }
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
    mark_updating(app);
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
            let _ = take_updated_marker(app);
            tracing::warn!("falha ao instalar atualização: {err}");
            splash_status(splash, "Não deu para atualizar agora. Abrindo o Line...", Some(-1.0));
            tokio::time::sleep(Duration::from_millis(1500)).await;
        }
    }
    true
}

/// "Entrar com Google": o Google não deixa logar dentro do WebView, então abre o navegador do
/// sistema em {servidor}/api/auth/google/start?port=N e espera o servidor mandar o navegador de
/// volta para http://127.0.0.1:N/?code=... (ou ?googleError=...). Devolve o código, que a
/// interface troca pelo token em /api/auth/google/finish.
#[tauri::command]
async fn google_login(app: tauri::AppHandle, server_url: String) -> Result<String, String> {
    use std::io::{Read, Write};
    use std::time::Duration;
    let listener = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let url = format!("{}/api/auth/google/start?port={port}", server_url.trim_end_matches('/'));
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        let deadline = std::time::Instant::now() + Duration::from_secs(5 * 60);
        loop {
            if std::time::Instant::now() > deadline {
                return Err("O login com Google demorou demais. Tente de novo.".to_string());
            }
            let mut stream = match listener.accept() {
                Ok((s, _)) => s,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(200));
                    continue;
                }
                Err(e) => return Err(e.to_string()),
            };
            let _ = stream.set_nonblocking(false);
            let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
            let mut buf = [0u8; 4096];
            let n = stream.read(&mut buf).unwrap_or(0);
            let req = String::from_utf8_lossy(&buf[..n]);
            // "GET /?code=... HTTP/1.1"
            let path = req.split_whitespace().nth(1).unwrap_or("");
            let query = path.split_once('?').map(|(_, q)| q).unwrap_or("");
            let mut code = None;
            let mut error = None;
            for pair in query.split('&') {
                let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
                let v = percent_decode(v);
                match k {
                    "code" => code = Some(v),
                    "googleError" => error = Some(v),
                    _ => {}
                }
            }
            if code.is_none() && error.is_none() {
                // favicon e afins: ignora e continua esperando.
                let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
                continue;
            }
            let hint = if cfg!(target_os = "macos") { "Fechar esta aba: <kbd>⌘</kbd> + <kbd>W</kbd>" } else { "Fechar esta aba: <kbd>Ctrl</kbd> + <kbd>W</kbd>" };
            let (state, pill, title, msg, hint) = if code.is_some() {
                ("ok", "Conta conectada", "Tudo <em>pronto!</em>",
                 "Você já entrou no Line. Pode fechar esta aba e voltar para o aplicativo.",
                 hint)
            } else {
                ("erro", "Não foi dessa vez", "Ops, não deu <em>para entrar</em>",
                 "Algo deu errado no login. Volte para o Line e tente de novo.",
                 hint)
            };
            let html = include_str!("oauth_done.html")
                .replace("{STATE}", state)
                .replace("{PILL}", pill)
                .replace("{TITLE}", title)
                .replace("{MSG}", msg)
                .replace("{HINT}", hint);
            let _ = stream.write_all(
                format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{html}", html.len()).as_bytes(),
            );
            return match (code, error) {
                (Some(c), _) => Ok(c),
                (_, Some(e)) => Err(e),
                _ => unreachable!(),
            };
        }
    })
    .await
    .map_err(|e| e.to_string())?
    .inspect(|_| {
        // Traz a janela do Line de volta para a frente.
        if let Some(w) = app.get_webview_window(MAIN) {
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
        }
    })
}

fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < bytes.len() => {
                match std::str::from_utf8(&bytes[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()).ok_or(()) {
                    Ok(b) => {
                        out.push(b);
                        i += 2;
                    }
                    Err(_) => out.push(b'%'),
                }
            }
            b => out.push(b),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Botão "Procurar atualizações" das Configurações: mesma janelinha da abertura.
#[tauri::command]
async fn update_run(app: tauri::AppHandle) -> Result<(), String> {
    run_update_window(app).await
}

async fn run_update_window(app: tauri::AppHandle) -> Result<(), String> {
    if from_store() {
        open_store_updates(&app);
        return Ok(());
    }
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

/// Notificação nativa (Windows): nome e ícone do Line, foto de quem mandou e resposta rápida.
/// Devolve false quando não dá (outros sistemas ou erro), e a interface usa a do navegador.
#[tauri::command]
#[allow(unused_variables)]
fn notify_show(
    app: tauri::AppHandle,
    title: String,
    body: String,
    tag: String,
    data: String,
    avatar: Option<String>,
    avatar_key: Option<String>,
    reply: bool,
) -> bool {
    #[cfg(windows)]
    {
        use base64::Engine;
        let avatar = avatar.and_then(|b64| {
            let bytes = base64::engine::general_purpose::STANDARD.decode(b64.rsplit(',').next()?).ok()?;
            let key: String = avatar_key.unwrap_or_default().chars().filter(|c| c.is_ascii_alphanumeric()).take(80).collect();
            let dir = std::env::temp_dir().join("line-notificacoes");
            std::fs::create_dir_all(&dir).ok()?;
            let path = dir.join(format!("{}.png", if key.is_empty() { "avatar" } else { &key }));
            std::fs::write(&path, bytes).ok()?;
            Some(path)
        });
        let handle = app.clone();
        let t = toast::Toast { title, body, tag, data, avatar, reply };
        return toast::show(t, move |action, data, reply| {
            if action == "open" {
                show_main(&handle);
            }
            if let Some(w) = handle.get_webview_window(MAIN) {
                let payload = serde_json::json!({ "action": action, "data": data, "reply": reply });
                let _ = w.eval(format!("window.lineToast && window.lineToast({payload})"));
            }
        })
        .map_err(|e| tracing::warn!("notificação nativa: {e}"))
        .is_ok();
    }
    false
}

/// Começou escondido na bandeja (abriu do zero): maximiza quando aparecer.
static MAXIMIZE_ON_SHOW: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window(MAIN) {
        let _ = w.unminimize();
        if MAXIMIZE_ON_SHOW.swap(false, std::sync::atomic::Ordering::SeqCst) {
            let _ = w.maximize();
        }
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
    open_main_with(app, false);
}

/// `hidden`: começa escondida na bandeja (no Linux, sem bandeja, minimizada).
fn open_main_with(app: &tauri::AppHandle, hidden: bool) {
    match create_window(app) {
        Ok(window) if hidden => {
            // Maximizar agora mostraria a janela: fica para quando ela abrir pela bandeja.
            MAXIMIZE_ON_SHOW.store(true, std::sync::atomic::Ordering::SeqCst);
            #[cfg(not(any(windows, target_os = "macos")))]
            {
                let _ = window.show();
                let _ = window.minimize();
            }
            #[cfg(any(windows, target_os = "macos"))]
            let _ = window;
        }
        // Mostra só depois de carregar, sem piscar branco.
        // Na thread principal pelo mesmo motivo do save_window_state_soon (restore_state segura o lock).
        Ok(window) => {
            let _ = app.run_on_main_thread(move || {
                if just_updated() {
                    use tauri_plugin_window_state::WindowExt;
                    let _ = window.restore_state(window_flags());
                } else {
                    let _ = window.maximize();
                }
                let _ = window.show();
                let _ = window.set_focus();
            });
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
fn set_badge(window: WebviewWindow, count: i64, rgba: Option<Vec<u8>>) {
    #[cfg(windows)]
    {
        // O Windows não tem número no ícone: a interface desenha a pílula com o número ("9+")
        // num quadrado de 32x32 e ela vai por cima do ícone. Sem desenho, só a bolinha vermelha.
        let icon = match rgba {
            Some(px) if count > 0 && px.len() == 32 * 32 * 4 => Some(tauri::image::Image::new_owned(px, 32, 32)),
            _ if count > 0 => Some(badge_dot()),
            _ => None,
        };
        let _ = window.set_overlay_icon(icon);
    }
    #[cfg(not(windows))]
    {
        let _ = rgba;
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

/// Seletor de tela do Line (com captura em Rust). No Linux só no X11: no Wayland o portal do
/// sistema funciona e o `getDisplayMedia` do WebKitGTK mostra o seletor dele.
fn native_screen_picker() -> bool {
    #[cfg(target_os = "linux")]
    return screen_linux::is_x11();
    #[cfg(not(target_os = "linux"))]
    true
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
    #[allow(unused_mut)]
    let mut builder = WebviewWindowBuilder::new(app, MAIN, WebviewUrl::App("index.html".into()))
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
        .additional_browser_args(&browser_args(app))
        .initialization_script(
            include_str!("bridge.js")
                .replace("__LINE_VERSION__", &app.package_info().version.to_string())
                .replace("__LINE_NATIVE_SCREEN__", if native_screen_picker() { "true" } else { "false" }),
        )
        // A interface volta para o canal/conversa de antes só depois de atualizar (ou no F5).
        .initialization_script(format!("window.__LINE_RESUMED__ = {};", just_updated()))
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
        });

    // Linux: o WebKitGTK das distros não tem RTCPeerConnection; o adaptador põe o motor em Rust
    // no lugar (rtc.rs + rtc_shim.js). LINE_RTC=native usa o do WebKit, para quem compilou com WebRTC.
    #[cfg(target_os = "linux")]
    {
        // Sons do próprio app (tauri://) não tocam no player do WebKitGTK; o script passa por blob:.
        builder = builder.initialization_script(include_str!("linux_media.js"));
        if std::env::var("LINE_RTC").as_deref() != Ok("native") {
            builder = builder.initialization_script(include_str!("rtc_shim.js"));
        }
    }

    let window = builder.build()?;

    // Windows: sem a barra de status do WebView2 (mostraria "tauri.localhost/..." ao passar em links).
    // E sem a prevenção de rastreamento do WebView2 (ligada por padrão no modo "Balanceado"): ela
    // bloqueia os cookies do TikTok dentro do player embutido no chat, a API do player responde 403
    // e aparece "Player authentication failed". O app só abre o próprio Line, não é um navegador.
    #[cfg(windows)]
    let _ = window.with_webview(|pw| unsafe {
        use webview2_com::Microsoft::Web::WebView2::Win32::{
            ICoreWebView2Profile3, ICoreWebView2_13, COREWEBVIEW2_TRACKING_PREVENTION_LEVEL_NONE,
        };
        use windows::core::Interface;
        if let Ok(core) = pw.controller().CoreWebView2() {
            if let Ok(settings) = core.Settings() {
                let _ = settings.SetIsStatusBarEnabled(false);
            }
            if let Ok(profile) = core
                .cast::<ICoreWebView2_13>()
                .and_then(|c| c.Profile())
                .and_then(|p| p.cast::<ICoreWebView2Profile3>())
            {
                let _ = profile.SetPreferredTrackingPreventionLevel(COREWEBVIEW2_TRACKING_PREVENTION_LEVEL_NONE);
            }
        }
    });

    #[cfg(target_os = "linux")]
    enable_linux_media(&window);

    let w = window.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::Focused(true) => {
            let _ = w.request_user_attention(None);
        }
        WindowEvent::Moved(_) | WindowEvent::Resized(_) => save_window_state_soon(w.app_handle()),
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
            // O webrtc-rs avisa de coisas normais do começo da chamada (SRTP antes do DTLS etc.).
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| {
                "info,webrtc=error,rtc=error,rtc_ice=error,rtc_dtls=error,rtc_srtp=error,rtc_sctp=error,rtc_interceptor=error,rtc_mdns=error"
                    .into()
            }),
        )
        .try_init();

    let app = tauri::Builder::default()
        // Uma janela só: abrir o Line de novo traz a janela que já existe para frente.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main(app);
        }))
        .plugin(tauri_plugin_opener::init())
        // Iniciar com o computador (Registro no Windows, LaunchAgent no macOS, .desktop no Linux).
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![AUTOSTART_ARG]),
        ))
        .plugin(tauri_plugin_updater::Builder::new().build())
        // A janela principal volta com o tamanho/posição de antes (restaurado em open_main_with,
        // antes de aparecer, para não abrir pequena e depois pular).
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(window_flags())
                .skip_initial_state(MAIN)
                // Só a principal: a janelinha de atualização e as outras não entram no arquivo.
                .with_filter(|label| label == MAIN)
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            request_attention,
            set_badge,
            notify_show,
            window_minimize,
            window_toggle_maximize,
            window_is_maximized,
            window_set_fullscreen,
            window_close,
            update_check,
            update_install,
            update_run,
            google_login,
            startup_get,
            startup_set,
            gpu_get,
            gpu_set,
            #[cfg(target_os = "linux")]
            rtc::rtc_attach,
            #[cfg(target_os = "linux")]
            rtc::rtc_create,
            #[cfg(target_os = "linux")]
            rtc::rtc_close,
            #[cfg(target_os = "linux")]
            rtc::rtc_add_track,
            #[cfg(target_os = "linux")]
            rtc::rtc_remove_track,
            #[cfg(target_os = "linux")]
            rtc::rtc_bind,
            #[cfg(target_os = "linux")]
            rtc::rtc_create_offer,
            #[cfg(target_os = "linux")]
            rtc::rtc_create_answer,
            #[cfg(target_os = "linux")]
            rtc::rtc_set_local,
            #[cfg(target_os = "linux")]
            rtc::rtc_set_remote,
            #[cfg(target_os = "linux")]
            rtc::rtc_add_ice,
            #[cfg(target_os = "linux")]
            rtc::rtc_restart_ice,
            #[cfg(target_os = "linux")]
            rtc::rtc_request_keyframe,
            #[cfg(target_os = "linux")]
            rtc::rtc_add_source,
            #[cfg(target_os = "linux")]
            rtc::rtc_remove_source,
            #[cfg(target_os = "linux")]
            rtc::rtc_push,
            screen::screen_sources,
            screen::screen_start,
            screen::screen_stop,
            games::game_running
        ])
        .setup(|app| {
            #[cfg(windows)]
            toast::register(include_bytes!("../icons/128x128@2x.png"));
            // A chamada não abaixa o som dos outros apps (atenuação de comunicações do Windows).
            #[cfg(windows)]
            ducking::start();
            #[cfg(target_os = "linux")]
            app.manage(rtc::Rtc::new());
            let handle = app.handle().clone();
            // Linux (WebKitGTK): sem aceleração, o WebKit compõe a página na CPU.
            #[cfg(target_os = "linux")]
            if !hardware_accel(&handle) {
                // SAFETY: ainda não há outras threads lendo o ambiente (nenhuma janela aberta).
                unsafe { std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1") };
            }
            #[cfg(any(windows, target_os = "macos"))]
            create_tray(&handle)?;
            // Aberto ao ligar o computador com "minimizado": fica quieto na bandeja, sem a
            // janelinha de atualização (dá para conferir depois pelo menu da bandeja).
            if start_hidden(&handle) {
                open_main_with(&handle, true);
                return Ok(());
            }
            // Windows e macOS: antes de abrir o app, uma janelinha procura atualização,
            // baixa e instala. Sem atualização (ou sem internet), segue direto para o app.
            if cfg!(any(windows, target_os = "macos")) && !cfg!(debug_assertions) && !from_store() {
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

/// No Linux o WebKitGTK vem com captura de mídia desligada: sem isso não há microfone, câmera nem
/// tela. O WebRTC em si fica com o adaptador (rtc.rs); ligar o do WebKit só vale com LINE_RTC=native,
/// num WebKitGTK compilado com ele (as distros não compilam).
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
            // LINE_DEBUG=1: o console da página sai no terminal (para diagnosticar chamadas).
            settings.set_enable_write_console_messages_to_stdout(std::env::var_os("LINE_DEBUG").is_some());
        }
        // Microfone, câmera, tela e notificações: o app inteiro é nosso, então libera.
        view.connect_permission_request(|_, req| {
            req.allow();
            true
        });
    });
}
