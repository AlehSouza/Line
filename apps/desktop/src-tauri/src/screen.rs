//! Compartilhar tela com seletor próprio (só Windows).
//!
//! O WebView2 não deixa escolher a fonte do `getDisplayMedia` por código (o evento
//! `ScreenCaptureStarting` só cancela ou deixa seguir), então a captura é feita aqui:
//!
//! 1. `screen_sources` lista janelas e telas com miniaturas (xcap) para a interface montar o seletor.
//! 2. `screen_start` captura a fonte escolhida pelo Windows Graphics Capture (windows-capture)
//!    e escreve cada quadro numa memória compartilhada com a página (SharedBuffer do WebView2),
//!    sem copiar pela ponte JSON. A página transforma isso numa trilha de vídeo do WebRTC.
//! 3. O áudio vem do WASAPI "process loopback": só o som do aplicativo escolhido, ou o som
//!    do sistema inteiro sem o próprio Line (para ninguém ouvir a própria voz de volta).
//!
//! Formato da memória: 64 bytes de cabeçalho (um u32 por espaço: 1 = quadro novo esperando a
//! página, 0 = livre) e depois `SLOTS` espaços de `slot_size` bytes com pixels BGRA sem sobra.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use serde::Serialize;
use tauri::WebviewWindow;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2Environment12, ICoreWebView2SharedBuffer, ICoreWebView2_17,
    COREWEBVIEW2_SHARED_BUFFER_ACCESS_READ_WRITE,
};
use windows::core::{Interface, HSTRING};
use windows_capture::capture::{Context, CaptureControl, GraphicsCaptureApiHandler};
use windows_capture::frame::Frame;
use windows_capture::graphics_capture_api::{GraphicsCaptureApi, InternalCaptureControl};
use windows_capture::settings::{
    ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
    MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
};

const SLOTS: usize = 3;
const HEADER: usize = 64;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    /// "window:<hwnd>" ou "screen:<hmonitor>".
    id: String,
    name: String,
    is_screen: bool,
    /// Miniatura em JPEG (data URL); vazia se a janela não deixou tirar.
    thumbnail: String,
}

fn thumb(img: xcap::image::RgbaImage) -> String {
    let (w, h) = img.dimensions();
    if w == 0 || h == 0 {
        return String::new();
    }
    let scale = (400.0 / w as f32).min(225.0 / h as f32).min(1.0);
    let small = xcap::image::imageops::thumbnail(
        &img,
        ((w as f32 * scale) as u32).max(1),
        ((h as f32 * scale) as u32).max(1),
    );
    let rgb = xcap::image::DynamicImage::ImageRgba8(small).to_rgb8();
    let mut jpeg = Vec::new();
    let enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 72);
    if image::ImageEncoder::write_image(
        enc,
        rgb.as_raw(),
        rgb.width(),
        rgb.height(),
        image::ExtendedColorType::Rgb8,
    )
    .is_err()
    {
        return String::new();
    }
    format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(jpeg))
}

/// Janelas abertas e telas, com miniaturas.
#[tauri::command]
pub async fn screen_sources() -> Vec<Source> {
    tauri::async_runtime::spawn_blocking(list_sources).await.unwrap_or_default()
}

fn list_sources() -> Vec<Source> {
    let mut out = Vec::new();
    let me = std::process::id();
    if let Ok(windows) = xcap::Window::all() {
        for w in windows {
            let title = w.title().unwrap_or_default();
            // Sem título, minimizada, minúscula ou o próprio Line: não dá para transmitir direito.
            if title.trim().is_empty()
                || w.is_minimized().unwrap_or(true)
                || w.pid().ok() == Some(me)
                || w.width().unwrap_or(0) < 64
                || w.height().unwrap_or(0) < 64
            {
                continue;
            }
            let Ok(id) = w.id() else { continue };
            out.push(Source {
                id: format!("window:{id}"),
                name: title,
                is_screen: false,
                thumbnail: w.capture_image().map(thumb).unwrap_or_default(),
            });
        }
    }
    if let Ok(monitors) = xcap::Monitor::all() {
        for (i, m) in monitors.into_iter().enumerate() {
            let Ok(id) = m.id() else { continue };
            let primary = m.is_primary().unwrap_or(false);
            let name = m.friendly_name().ok().filter(|n| !n.trim().is_empty());
            out.push(Source {
                id: format!("screen:{id}"),
                name: match (name, primary) {
                    (Some(n), true) => format!("Tela {} (principal) · {n}", i + 1),
                    (Some(n), false) => format!("Tela {} · {n}", i + 1),
                    (None, true) => format!("Tela {} (principal)", i + 1),
                    (None, false) => format!("Tela {}", i + 1),
                },
                is_screen: true,
                thumbnail: m.capture_image().map(thumb).unwrap_or_default(),
            });
        }
    }
    out
}

// ---------- sessão de captura ----------

/// Ponteiro da memória compartilhada (fica válido até a sessão fechar o SharedBuffer).
#[derive(Clone, Copy)]
struct Shared {
    ptr: usize,
    slot_size: usize,
}

struct Flags {
    window: WebviewWindow,
    session: u64,
    shared: Shared,
    frame_gap: Duration,
    started: Instant,
}

struct Capture {
    flags: Flags,
    last: Option<Instant>,
}

/// `PostWebMessageAsJson` na thread principal (o WebView2 só aceita chamadas de lá).
fn post(window: &WebviewWindow, json: String) {
    let _ = window.with_webview(move |pw| unsafe {
        if let Ok(core) = pw.controller().CoreWebView2() {
            let _ = core.PostWebMessageAsJson(&HSTRING::from(json));
        }
    });
}

impl GraphicsCaptureApiHandler for Capture {
    type Flags = Flags;
    type Error = String;

    fn new(ctx: Context<Flags>) -> Result<Self, String> {
        Ok(Self { flags: ctx.flags, last: None })
    }

    fn on_frame_arrived(&mut self, frame: &mut Frame, _: InternalCaptureControl) -> Result<(), String> {
        let now = Instant::now();
        // Respeita o fps escolhido (o Windows manda quadros na taxa do monitor).
        if let Some(last) = self.last {
            if now.duration_since(last) + Duration::from_millis(2) < self.flags.frame_gap {
                return Ok(());
            }
        }
        let Shared { ptr, slot_size } = self.flags.shared;
        let header = ptr as *mut u32;
        // Espaço livre (a página já copiou o quadro anterior dele). Nenhum livre: pula o quadro.
        let Some(slot) = (0..SLOTS).find(|&i| unsafe { header.add(i).read_volatile() } == 0) else {
            return Ok(());
        };
        let mut buf = frame.buffer().map_err(|e| e.to_string())?;
        let (w, h, pitch) = (buf.width() as usize, buf.height() as usize, buf.row_pitch() as usize);
        let row = w * 4;
        if w == 0 || h == 0 || row * h > slot_size {
            return Ok(());
        }
        let raw = buf.as_raw_buffer();
        unsafe {
            let dst = (ptr + HEADER + slot * slot_size) as *mut u8;
            for y in 0..h {
                std::ptr::copy_nonoverlapping(raw.as_ptr().add(y * pitch), dst.add(y * row), row);
            }
            header.add(slot).write_volatile(1);
        }
        self.last = Some(now);
        let ts = now.duration_since(self.flags.started).as_micros() as u64;
        post(
            &self.flags.window,
            format!(
                r#"{{"lineScreen":"frame","session":{},"slot":{slot},"w":{w},"h":{h},"ts":{ts}}}"#,
                self.flags.session
            ),
        );
        Ok(())
    }

    fn on_closed(&mut self) -> Result<(), String> {
        // A janela transmitida foi fechada.
        post(
            &self.flags.window,
            format!(r#"{{"lineScreen":"ended","session":{}}}"#, self.flags.session),
        );
        Ok(())
    }
}

struct Session {
    capture: Option<CaptureControl<Capture, String>>,
    audio_stop: Arc<AtomicBool>,
    audio: Option<std::thread::JoinHandle<()>>,
}

static SESSION: Mutex<Option<Session>> = Mutex::new(None);
static NEXT: AtomicU64 = AtomicU64::new(1);

thread_local! {
    /// O SharedBuffer só pode ser tocado na thread principal; fica guardado aqui até parar.
    static BUFFER: std::cell::RefCell<Option<ICoreWebView2SharedBuffer>> = const { std::cell::RefCell::new(None) };
}

enum Item {
    Window(windows_capture::window::Window),
    Monitor(windows_capture::monitor::Monitor),
}

fn parse(id: &str) -> Result<Item, String> {
    let (kind, raw) = id.split_once(':').ok_or("fonte inválida")?;
    let raw: usize = raw.parse().map_err(|_| "fonte inválida")?;
    let p = raw as *mut std::ffi::c_void;
    Ok(match kind {
        "window" => Item::Window(windows_capture::window::Window::from_raw_hwnd(p)),
        "screen" => Item::Monitor(windows_capture::monitor::Monitor::from_raw_hmonitor(p)),
        _ => return Err("fonte inválida".into()),
    })
}

/// Maior tela em bytes BGRA: cabe qualquer janela que não passe do monitor.
fn largest_frame() -> usize {
    xcap::Monitor::all()
        .ok()
        .into_iter()
        .flatten()
        .map(|m| {
            // Já vem em pixels reais (sem a escala do Windows).
            m.width().unwrap_or(1920) as usize * m.height().unwrap_or(1080) as usize * 4
        })
        .max()
        .unwrap_or(1920 * 1080 * 4)
        .max(1920 * 1080 * 4)
}

#[derive(Serialize)]
pub struct Started {
    session: u64,
}

/// Começa a transmitir a fonte escolhida. A memória compartilhada chega na página pelo
/// evento `sharedbufferreceived` e os quadros pelo evento `message` do `chrome.webview`.
#[tauri::command]
pub async fn screen_start(window: WebviewWindow, id: String, fps: u32, audio: bool) -> Result<Started, String> {
    stop_session(&window);
    let item = parse(&id)?;
    let session = NEXT.fetch_add(1, Ordering::Relaxed);
    // Margem de 1/8 para janelas que passam um pouco do tamanho da tela.
    let slot_size = largest_frame() * 9 / 8;
    let size = (HEADER + SLOTS * slot_size) as u64;

    let (tx, rx) = mpsc::channel::<Result<usize, String>>();
    window
        .with_webview(move |pw| {
            let res = (|| unsafe {
                let env: ICoreWebView2Environment12 = pw.environment().cast().map_err(|e| e.to_string())?;
                let buffer = env.CreateSharedBuffer(size).map_err(|e| e.to_string())?;
                let mut ptr = std::ptr::null_mut();
                buffer.Buffer(&mut ptr).map_err(|e| e.to_string())?;
                std::ptr::write_bytes(ptr, 0, HEADER);
                let core: ICoreWebView2_17 = pw
                    .controller()
                    .CoreWebView2()
                    .and_then(|c| c.cast())
                    .map_err(|e| e.to_string())?;
                let extra = format!(
                    r#"{{"lineScreen":"buffer","session":{session},"slots":{SLOTS},"header":{HEADER},"slotSize":{slot_size}}}"#
                );
                core.PostSharedBufferToScript(&buffer, COREWEBVIEW2_SHARED_BUFFER_ACCESS_READ_WRITE, &HSTRING::from(extra))
                    .map_err(|e| e.to_string())?;
                BUFFER.with(|b| *b.borrow_mut() = Some(buffer));
                Ok(ptr as usize)
            })();
            let _ = tx.send(res);
        })
        .map_err(|e| e.to_string())?;
    let ptr = tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(Duration::from_secs(5)))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|_| "o WebView2 não respondeu".to_string())??;

    let fps = fps.clamp(5, 60);
    let flags = Flags {
        window: window.clone(),
        session,
        shared: Shared { ptr, slot_size },
        frame_gap: Duration::from_micros(1_000_000 / fps as u64),
        started: Instant::now(),
    };
    let border = if GraphicsCaptureApi::is_border_settings_supported().unwrap_or(false) {
        DrawBorderSettings::WithoutBorder
    } else {
        DrawBorderSettings::Default
    };
    let interval = if GraphicsCaptureApi::is_minimum_update_interval_supported().unwrap_or(false) {
        MinimumUpdateIntervalSettings::Custom(Duration::from_micros(1_000_000 / fps as u64))
    } else {
        MinimumUpdateIntervalSettings::Default
    };
    let cursor = if GraphicsCaptureApi::is_cursor_settings_supported().unwrap_or(false) {
        CursorCaptureSettings::WithCursor
    } else {
        CursorCaptureSettings::Default
    };

    // Áudio: do app da janela (e filhos), ou do sistema todo menos o Line.
    let (target_pid, include) = match &item {
        Item::Window(w) => (w.process_id().unwrap_or(0), true),
        Item::Monitor(_) => (std::process::id(), false),
    };

    let started = match item {
        Item::Window(w) => Capture::start_free_threaded(Settings::new(
            w, cursor, border, SecondaryWindowSettings::Default, interval,
            DirtyRegionSettings::Default, ColorFormat::Bgra8, flags,
        )),
        Item::Monitor(m) => Capture::start_free_threaded(Settings::new(
            m, cursor, border, SecondaryWindowSettings::Default, interval,
            DirtyRegionSettings::Default, ColorFormat::Bgra8, flags,
        )),
    };
    let capture = match started {
        Ok(c) => c,
        Err(err) => {
            release_buffer(&window);
            return Err(format!("não foi possível capturar: {err}"));
        }
    };

    let audio_stop = Arc::new(AtomicBool::new(false));
    let audio = (audio && target_pid != 0).then(|| {
        let stop = audio_stop.clone();
        let w = window.clone();
        std::thread::spawn(move || {
            if let Err(err) = crate::loopback::run(target_pid, include, &stop, |chunk, ts| {
                let data = base64::engine::general_purpose::STANDARD.encode(chunk);
                post(
                    &w,
                    format!(r#"{{"lineScreen":"audio","session":{session},"rate":48000,"ch":2,"ts":{ts},"data":"{data}"}}"#),
                );
            }) {
                tracing::warn!("áudio da transmissão indisponível: {err}");
            }
        })
    });

    *SESSION.lock().unwrap() = Some(Session { capture: Some(capture), audio_stop, audio });
    Ok(Started { session })
}

fn release_buffer(window: &WebviewWindow) {
    let _ = window.with_webview(|_| {
        BUFFER.with(|b| {
            if let Some(buffer) = b.borrow_mut().take() {
                unsafe {
                    let _ = buffer.Close();
                }
            }
        });
    });
}

fn stop_session(window: &WebviewWindow) {
    let Some(mut s) = SESSION.lock().unwrap().take() else { return };
    s.audio_stop.store(true, Ordering::Relaxed);
    if let Some(c) = s.capture.take() {
        let _ = c.stop();
    }
    if let Some(a) = s.audio.take() {
        let _ = a.join();
    }
    // Só fecha a memória depois que a captura parou de escrever nela.
    release_buffer(window);
}

#[tauri::command]
pub async fn screen_stop(window: WebviewWindow) {
    let _ = tauri::async_runtime::spawn_blocking(move || stop_session(&window)).await;
}
