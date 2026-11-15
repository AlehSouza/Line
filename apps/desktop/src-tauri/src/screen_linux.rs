//! Compartilhar tela com seletor próprio no Linux (sessão X11).
//!
//! O `getDisplayMedia` do WebKitGTK passa pelo portal do sistema (xdg-desktop-portal + PipeWire),
//! que só existe no Wayland: no X11 a tela não compartilha. Então, no X11, o Line faz como no macOS:
//! 1. `screen_sources` lista janelas (EWMH) e telas (RandR) com miniaturas.
//! 2. `screen_start` captura a fonte pelo próprio X (GetImage, com o cursor por cima via XFixes),
//!    reduz até a resolução escolhida, converte para NV12 e manda cada quadro por um WebSocket
//!    só do 127.0.0.1 (senha aleatória na URL). A página monta uma trilha de vídeo a partir disso.
//!
//! O protocolo é o mesmo do macOS (`screen_mac.rs`): byte 0 = tipo (1 vídeo, 3 fim);
//! vídeo: u32 largura, u32 altura, u64 tempo (µs), plano Y e depois plano UV, sem sobra.
//! No Wayland o portal funciona, então a interface usa o seletor do sistema (ver `is_x11`).

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use tokio::sync::mpsc;
use x11rb::connection::Connection;
use x11rb::protocol::randr::ConnectionExt as _;
use x11rb::protocol::shm::ConnectionExt as _;
use x11rb::protocol::xfixes::ConnectionExt as _;
use x11rb::protocol::xproto::{Atom, AtomEnum, ConnectionExt as _, ImageFormat, MapState, Window};
use x11rb::rust_connection::RustConnection;
use fast_image_resize::images::{Image, ImageRef};
use fast_image_resize::{FilterType, PixelType, ResizeAlg, ResizeOptions, Resizer};
use yuvutils_rs::{
    BufferStoreMut, YuvBiPlanarImageMut, YuvConversionMode, YuvRange, YuvStandardMatrix, bgra_to_yuv_nv12,
};

/// Sessão X11 de verdade (no Wayland, mesmo com XWayland, a captura é pelo portal).
pub fn is_x11() -> bool {
    let wayland = std::env::var("XDG_SESSION_TYPE").is_ok_and(|s| s.eq_ignore_ascii_case("wayland"))
        || std::env::var_os("WAYLAND_DISPLAY").is_some();
    !wayland && std::env::var_os("DISPLAY").is_some()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    /// "window:<id X>" ou "screen:<índice do monitor>".
    id: String,
    name: String,
    is_screen: bool,
    /// Miniatura em JPEG (data URL); vazia se não deu para tirar.
    thumbnail: String,
}

struct Atoms {
    client_list: Atom,
    net_wm_name: Atom,
    utf8: Atom,
    pid: Atom,
    state: Atom,
    hidden: Atom,
    wtype: Atom,
    normal: Atom,
    dialog: Atom,
}

fn atom(conn: &RustConnection, name: &[u8]) -> Result<Atom, String> {
    Ok(conn.intern_atom(false, name).map_err(err)?.reply().map_err(err)?.atom)
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

impl Atoms {
    fn new(conn: &RustConnection) -> Result<Self, String> {
        Ok(Self {
            client_list: atom(conn, b"_NET_CLIENT_LIST")?,
            net_wm_name: atom(conn, b"_NET_WM_NAME")?,
            utf8: atom(conn, b"UTF8_STRING")?,
            pid: atom(conn, b"_NET_WM_PID")?,
            state: atom(conn, b"_NET_WM_STATE")?,
            hidden: atom(conn, b"_NET_WM_STATE_HIDDEN")?,
            wtype: atom(conn, b"_NET_WM_WINDOW_TYPE")?,
            normal: atom(conn, b"_NET_WM_WINDOW_TYPE_NORMAL")?,
            dialog: atom(conn, b"_NET_WM_WINDOW_TYPE_DIALOG")?,
        })
    }
}

fn prop32(conn: &RustConnection, win: Window, prop: Atom, typ: impl Into<Atom>) -> Vec<u32> {
    conn.get_property(false, win, prop, typ, 0, 1024)
        .ok()
        .and_then(|c| c.reply().ok())
        .and_then(|r| r.value32().map(|v| v.collect()))
        .unwrap_or_default()
}

fn title(conn: &RustConnection, atoms: &Atoms, win: Window) -> String {
    let get = |prop: Atom, typ: Atom| {
        conn.get_property(false, win, prop, typ, 0, 1024)
            .ok()
            .and_then(|c| c.reply().ok())
            .map(|r| String::from_utf8_lossy(&r.value).into_owned())
            .unwrap_or_default()
    };
    let name = get(atoms.net_wm_name, atoms.utf8);
    if name.trim().is_empty() { get(AtomEnum::WM_NAME.into(), AtomEnum::STRING.into()) } else { name }
}

/// Retângulo da janela na tela (x, y, largura, altura).
fn window_rect(conn: &RustConnection, root: Window, win: Window) -> Option<(i16, i16, u16, u16)> {
    let g = conn.get_geometry(win).ok()?.reply().ok()?;
    let t = conn.translate_coordinates(win, root, 0, 0).ok()?.reply().ok()?;
    Some((t.dst_x, t.dst_y, g.width, g.height))
}

/// Uma imagem BGRX (4 bytes por pixel) capturada do X.
struct Frame {
    w: usize,
    h: usize,
    data: Vec<u8>,
}

/// Memória compartilhada com o servidor X (MIT-SHM): o X escreve a imagem direto nela, sem passar
/// os ~8 MB de cada quadro 1080p pelo socket. É o que deixa a captura rápida o bastante para 30/60 fps.
struct Shm {
    seg: u32,
    addr: *mut u8,
    size: usize,
}

// O ponteiro é da memória compartilhada, que só a thread de captura usa.
unsafe impl Send for Shm {}

impl Shm {
    fn new(conn: &RustConnection, size: usize) -> Option<Self> {
        conn.shm_query_version().ok()?.reply().ok()?;
        let seg = conn.generate_id().ok()?;
        // SAFETY: memória nova do próprio processo; marcada para sumir quando os dois lados soltarem.
        unsafe {
            let id = libc::shmget(libc::IPC_PRIVATE, size, libc::IPC_CREAT | 0o600);
            if id < 0 {
                return None;
            }
            let addr = libc::shmat(id, std::ptr::null(), 0);
            let attached = addr as isize != -1
                && conn.shm_attach(seg, id as u32, false).ok().and_then(|c| c.check().ok()).is_some();
            libc::shmctl(id, libc::IPC_RMID, std::ptr::null_mut());
            if !attached {
                if addr as isize != -1 {
                    libc::shmdt(addr);
                }
                return None;
            }
            Some(Self { seg, addr: addr as *mut u8, size })
        }
    }
}

impl Drop for Shm {
    fn drop(&mut self) {
        // SAFETY: endereço devolvido pelo shmat em `new`.
        unsafe {
            libc::shmdt(self.addr as *const libc::c_void);
        }
    }
}

fn get_image(conn: &RustConnection, shm: Option<&Shm>, drawable: Window, x: i16, y: i16, w: u16, h: u16) -> Option<Frame> {
    let (fw, fh) = (w as usize, h as usize);
    let need = fw * fh * 4;
    if let Some(shm) = shm.filter(|s| need <= s.size) {
        let format = ImageFormat::Z_PIXMAP.into();
        conn.shm_get_image(drawable, x, y, w, h, !0, format, shm.seg, 0).ok()?.reply().ok()?;
        // SAFETY: o X acabou de escrever `need` bytes nesse começo da memória (a resposta já chegou).
        let data = unsafe { std::slice::from_raw_parts(shm.addr, need) }.to_vec();
        return Some(Frame { w: fw, h: fh, data });
    }
    let r = conn.get_image(ImageFormat::Z_PIXMAP, drawable, x, y, w, h, !0).ok()?.reply().ok()?;
    // 24/32 bits de profundidade vêm com 4 bytes por pixel (BGRX no x86).
    (r.data.len() >= need).then_some(Frame { w: fw, h: fh, data: r.data })
}

/// O que capturar: uma janela (pela própria janela, que com compositor vem inteira mesmo coberta)
/// ou um pedaço da raiz (um monitor).
#[derive(Clone, Copy)]
enum Target {
    Window(Window),
    Area { x: i16, y: i16, w: u16, h: u16 },
}

fn capture(conn: &RustConnection, shm: Option<&Shm>, root: Window, target: Target) -> Option<(Frame, i16, i16)> {
    match target {
        Target::Area { x, y, w, h } => Some((get_image(conn, shm, root, x, y, w, h)?, x, y)),
        Target::Window(win) => {
            let (x, y, w, h) = window_rect(conn, root, win)?;
            if w < 2 || h < 2 {
                return None;
            }
            // Sem compositor, uma janela parcialmente fora da tela dá BadMatch: aí pega o pedaço da raiz.
            get_image(conn, shm, win, 0, 0, w, h)
                .map(|f| (f, x, y))
                .or_else(|| {
                    let s = &conn.setup().roots[0];
                    let (x0, y0) = (x.max(0), y.max(0));
                    let w2 = (s.width_in_pixels as i32 - x0 as i32).min(w as i32 - (x0 - x) as i32);
                    let h2 = (s.height_in_pixels as i32 - y0 as i32).min(h as i32 - (y0 - y) as i32);
                    (w2 > 1 && h2 > 1).then_some(())?;
                    Some((get_image(conn, shm, root, x0, y0, w2 as u16, h2 as u16)?, x0, y0))
                })
        }
    }
}

/// Desenha o cursor (XFixes) por cima do quadro, que começa em (ox, oy) na tela.
fn draw_cursor(conn: &RustConnection, f: &mut Frame, ox: i16, oy: i16) {
    let Some(c) = conn.xfixes_get_cursor_image().ok().and_then(|c| c.reply().ok()) else { return };
    let (cx, cy) = (c.x as i32 - c.xhot as i32 - ox as i32, c.y as i32 - c.yhot as i32 - oy as i32);
    for j in 0..c.height as i32 {
        let y = cy + j;
        if y < 0 || y >= f.h as i32 {
            continue;
        }
        for i in 0..c.width as i32 {
            let x = cx + i;
            if x < 0 || x >= f.w as i32 {
                continue;
            }
            let p = c.cursor_image[(j * c.width as i32 + i) as usize];
            let a = p >> 24;
            if a == 0 {
                continue;
            }
            // ARGB pré-multiplicado.
            let o = (y as usize * f.w + x as usize) * 4;
            let inv = 255 - a;
            for (k, shift) in [(0usize, 0u32), (1, 8), (2, 16)] {
                let s = (p >> shift) & 0xff;
                f.data[o + k] = (s + (f.data[o + k] as u32 * inv) / 255).min(255) as u8;
            }
        }
    }
}

/// BGRX -> NV12 no tamanho de saída (par), com SIMD (AVX2/SSE/NEON): a redução pelo
/// fast_image_resize e a conversão de cor (BT.601, faixa de vídeo) pelo yuvutils.
fn to_nv12(f: &Frame, ow: usize, oh: usize, resizer: &mut Resizer) -> Option<Vec<u8>> {
    let src = &f.data[..f.w * f.h * 4];
    let scaled;
    let bgra = if (ow, oh) == (f.w, f.h) {
        src
    } else {
        let from = ImageRef::new(f.w as u32, f.h as u32, src, PixelType::U8x4).ok()?;
        let mut to = Image::new(ow as u32, oh as u32, PixelType::U8x4);
        // Média por área (Box): mantém o texto legível ao reduzir. O quarto canal do X não é alfa.
        let opts = ResizeOptions::new().resize_alg(ResizeAlg::Convolution(FilterType::Box)).use_alpha(false);
        resizer.resize(&from, &mut to, &opts).ok()?;
        scaled = to;
        scaled.buffer()
    };
    let mut out = vec![0u8; ow * oh * 3 / 2];
    let (y, uv) = out.split_at_mut(ow * oh);
    let mut planes = YuvBiPlanarImageMut {
        y_plane: BufferStoreMut::Borrowed(y),
        y_stride: ow as u32,
        uv_plane: BufferStoreMut::Borrowed(uv),
        uv_stride: ow as u32,
        width: ow as u32,
        height: oh as u32,
    };
    bgra_to_yuv_nv12(&mut planes, bgra, (ow * 4) as u32, YuvRange::Limited, YuvStandardMatrix::Bt601, YuvConversionMode::Balanced)
        .ok()?;
    Some(out)
}

fn thumb(f: &Frame) -> String {
    if f.w == 0 || f.h == 0 {
        return String::new();
    }
    let scale = (400.0 / f.w as f32).min(225.0 / f.h as f32).min(1.0);
    let (tw, th) = (((f.w as f32 * scale) as usize).max(1), ((f.h as f32 * scale) as usize).max(1));
    let mut rgb = Vec::with_capacity(tw * th * 3);
    for y in 0..th {
        for x in 0..tw {
            let o = ((y * f.h / th) * f.w + x * f.w / tw) * 4;
            rgb.extend_from_slice(&[f.data[o + 2], f.data[o + 1], f.data[o]]);
        }
    }
    let mut jpeg = Vec::new();
    let enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 72);
    if image::ImageEncoder::write_image(enc, &rgb, tw as u32, th as u32, image::ExtendedColorType::Rgb8).is_err() {
        return String::new();
    }
    format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(jpeg))
}

struct Monitor {
    name: String,
    primary: bool,
    x: i16,
    y: i16,
    w: u16,
    h: u16,
}

fn monitors(conn: &RustConnection, root: Window) -> Vec<Monitor> {
    let list = conn.randr_get_monitors(root, true).ok().and_then(|c| c.reply().ok());
    let mut out: Vec<Monitor> = list
        .map(|r| {
            r.monitors
                .iter()
                .map(|m| Monitor {
                    name: conn
                        .get_atom_name(m.name)
                        .ok()
                        .and_then(|c| c.reply().ok())
                        .map(|n| String::from_utf8_lossy(&n.name).into_owned())
                        .unwrap_or_default(),
                    primary: m.primary,
                    x: m.x,
                    y: m.y,
                    w: m.width,
                    h: m.height,
                })
                .collect()
        })
        .unwrap_or_default();
    if out.is_empty() {
        // Sem RandR: a tela inteira.
        let s = &conn.setup().roots[0];
        out.push(Monitor { name: String::new(), primary: true, x: 0, y: 0, w: s.width_in_pixels, h: s.height_in_pixels });
    }
    out
}

fn connect() -> Result<(RustConnection, Window), String> {
    let (conn, screen) = x11rb::connect(None).map_err(|e| format!("sem acesso ao X11: {e}"))?;
    let root = conn.setup().roots[screen].root;
    // O XFixes só responde depois de negociar a versão.
    let _ = conn.xfixes_query_version(5, 0).ok().and_then(|c| c.reply().ok());
    Ok((conn, root))
}

fn list_sources() -> Result<Vec<Source>, String> {
    let (conn, root) = connect()?;
    let atoms = Atoms::new(&conn)?;
    let me = std::process::id();
    let mut out = Vec::new();
    for win in prop32(&conn, root, atoms.client_list, AtomEnum::WINDOW) {
        let name = title(&conn, &atoms, win);
        if name.trim().is_empty() {
            continue;
        }
        // Minimizada, do próprio Line, ou painel/área de trabalho: não dá para transmitir direito.
        if prop32(&conn, win, atoms.state, AtomEnum::ATOM).contains(&atoms.hidden)
            || prop32(&conn, win, atoms.pid, AtomEnum::CARDINAL).first() == Some(&me)
        {
            continue;
        }
        let types = prop32(&conn, win, atoms.wtype, AtomEnum::ATOM);
        if !types.is_empty() && !types.iter().any(|t| *t == atoms.normal || *t == atoms.dialog) {
            continue;
        }
        let viewable = conn
            .get_window_attributes(win)
            .ok()
            .and_then(|c| c.reply().ok())
            .is_some_and(|a| a.map_state == MapState::VIEWABLE);
        let Some((_, _, w, h)) = window_rect(&conn, root, win) else { continue };
        if !viewable || w < 64 || h < 64 {
            continue;
        }
        let thumbnail = capture(&conn, None, root, Target::Window(win)).map(|(f, _, _)| thumb(&f)).unwrap_or_default();
        out.push(Source { id: format!("window:{win}"), name, is_screen: false, thumbnail });
    }
    for (i, m) in monitors(&conn, root).into_iter().enumerate() {
        let thumbnail = capture(&conn, None, root, Target::Area { x: m.x, y: m.y, w: m.w, h: m.h })
            .map(|(f, _, _)| thumb(&f))
            .unwrap_or_default();
        let base = if m.primary { format!("Tela {} (principal)", i + 1) } else { format!("Tela {}", i + 1) };
        out.push(Source {
            id: format!("screen:{i}"),
            name: if m.name.is_empty() { base } else { format!("{base} · {}", m.name) },
            is_screen: true,
            thumbnail,
        });
    }
    Ok(out)
}

/// Janelas abertas e telas, com miniaturas.
#[tauri::command]
pub async fn screen_sources() -> Result<Vec<Source>, String> {
    tauri::async_runtime::spawn_blocking(list_sources).await.map_err(err)?
}

struct Session {
    stop: Arc<AtomicBool>,
    server: tauri::async_runtime::JoinHandle<()>,
}

static SESSION: Mutex<Option<Session>> = Mutex::new(None);
static NEXT: AtomicU64 = AtomicU64::new(1);

#[derive(Serialize)]
pub struct Started {
    session: u64,
    url: String,
}

#[tauri::command]
pub async fn screen_start(
    id: String,
    fps: u32,
    // O X não dá o som de uma janela; o áudio da tela fica de fora no Linux.
    #[allow(unused_variables)] audio: bool,
    height: Option<u32>,
) -> Result<Started, String> {
    stop_session();
    let (kind, raw) = id.split_once(':').ok_or("fonte inválida")?;
    let raw: u32 = raw.parse().map_err(|_| "fonte inválida")?;
    let fps = fps.clamp(5, 60);
    let max_h = height.unwrap_or(1080).clamp(360, 2160) as f64;

    let (conn, root) = connect()?;
    let target = match kind {
        "window" => {
            window_rect(&conn, root, raw).ok_or("a janela foi fechada")?;
            Target::Window(raw)
        }
        "screen" => {
            let m = monitors(&conn, root).into_iter().nth(raw as usize).ok_or("tela não encontrada")?;
            Target::Area { x: m.x, y: m.y, w: m.w, h: m.h }
        }
        _ => return Err("fonte inválida".into()),
    };

    // WebSocket só no 127.0.0.1, porta livre, com senha aleatória no caminho.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.map_err(err)?;
    let port = listener.local_addr().map_err(err)?.port();
    let token: String = format!("{:032x}", rand::random::<u128>());
    let (tx, mut rx) = mpsc::channel::<Vec<u8>>(3);
    let stop = Arc::new(AtomicBool::new(false));

    // Captura numa thread própria: o GetImage e a conversão são síncronos.
    let stop2 = stop.clone();
    std::thread::spawn(move || {
        let screen = &conn.setup().roots[0];
        let shm = Shm::new(&conn, screen.width_in_pixels as usize * screen.height_in_pixels as usize * 4);
        if shm.is_none() {
            tracing::info!("tela: sem MIT-SHM, capturando pelo socket do X (mais lento)");
        }
        let mut resizer = Resizer::new();
        let gap = Duration::from_micros(1_000_000 / fps as u64);
        let started = Instant::now();
        let mut next = Instant::now();
        let mut misses = 0;
        while !stop2.load(Ordering::Relaxed) {
            let now = Instant::now();
            if now < next {
                std::thread::sleep(next - now);
            }
            // Depois de um atraso, recomeça do agora em vez de soltar uma rajada de quadros.
            next = next.max(Instant::now() - gap) + gap;
            let Some((mut frame, ox, oy)) = capture(&conn, shm.as_ref(), root, target) else {
                // A janela sumiu (fechou): alguns erros seguidos encerram a transmissão.
                misses += 1;
                if misses > 10 {
                    break;
                }
                continue;
            };
            misses = 0;
            draw_cursor(&conn, &mut frame, ox, oy);
            let (w, h) = (frame.w as f64, frame.h as f64);
            let scale = (max_h / h).min(max_h * 16.0 / 9.0 / w).min(1.0);
            let ow = ((w * scale) as usize / 2 * 2).max(2);
            let oh = ((h * scale) as usize / 2 * 2).max(2);
            let Some(nv12) = to_nv12(&frame, ow, oh, &mut resizer) else { continue };
            let mut msg = Vec::with_capacity(17 + nv12.len());
            msg.push(1u8);
            msg.extend_from_slice(&(ow as u32).to_le_bytes());
            msg.extend_from_slice(&(oh as u32).to_le_bytes());
            msg.extend_from_slice(&(started.elapsed().as_micros() as u64).to_le_bytes());
            msg.extend_from_slice(&nv12);
            match tx.try_send(msg) {
                // A página está atrasada: pula este quadro.
                Ok(()) | Err(mpsc::error::TrySendError::Full(_)) => {}
                Err(mpsc::error::TrySendError::Closed(_)) => break,
            }
        }
        // `tx` sai aqui: o servidor avisa a página que a transmissão acabou.
    });

    let path = format!("/{token}");
    let server = tauri::async_runtime::spawn(async move {
        // Uma conexão só: a da página, com a senha certa.
        loop {
            let Ok((sock, _)) = listener.accept().await else { return };
            let want = path.clone();
            // O tipo de erro vem do tungstenite (mesmo padrão do macOS).
            #[allow(clippy::result_large_err)]
            let check = move |req: &tokio_tungstenite::tungstenite::handshake::server::Request,
                              res: tokio_tungstenite::tungstenite::handshake::server::Response| {
                if req.uri().path() == want {
                    Ok(res)
                } else {
                    let mut no = tokio_tungstenite::tungstenite::handshake::server::ErrorResponse::new(None);
                    *no.status_mut() = tokio_tungstenite::tungstenite::http::StatusCode::FORBIDDEN;
                    Err(no)
                }
            };
            let Ok(ws) = tokio_tungstenite::accept_hdr_async(sock, check).await else { continue };
            let (mut sink, mut incoming) = ws.split();
            loop {
                tokio::select! {
                    msg = rx.recv() => match msg {
                        Some(m) => {
                            if sink.send(tokio_tungstenite::tungstenite::Message::binary(m)).await.is_err() {
                                return;
                            }
                        }
                        None => {
                            let _ = sink.send(tokio_tungstenite::tungstenite::Message::binary(vec![3u8])).await;
                            return;
                        }
                    },
                    other = incoming.next() => if other.is_none() { return },
                }
            }
        }
    });

    let session = NEXT.fetch_add(1, Ordering::Relaxed);
    *SESSION.lock().unwrap() = Some(Session { stop, server });
    Ok(Started { session, url: format!("ws://127.0.0.1:{port}/{token}") })
}

fn stop_session() {
    if let Some(s) = SESSION.lock().unwrap().take() {
        s.stop.store(true, Ordering::Relaxed);
        s.server.abort();
    }
}

#[tauri::command]
pub async fn screen_stop() {
    stop_session();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nv12_rapido_e_correto() {
        let (w, h) = (1920, 1080);
        // Fundo cinza médio com uma faixa vermelha pura em cima.
        let mut data = vec![128u8; w * h * 4];
        for px in data[..w * 100 * 4].chunks_exact_mut(4) {
            px.copy_from_slice(&[0, 0, 255, 0]);
        }
        let f = Frame { w, h, data };
        for (ow, oh) in [(1920, 1080), (1280, 720)] {
            let mut resizer = Resizer::new();
            let _ = to_nv12(&f, ow, oh, &mut resizer); // aquece (buffers internos)
            let t = Instant::now();
            let out = to_nv12(&f, ow, oh, &mut resizer).unwrap();
            let ms = t.elapsed().as_secs_f64() * 1000.0;
            eprintln!("to_nv12 {w}x{h} -> {ow}x{oh}: {ms:.1} ms");
            assert_eq!(out.len(), ow * oh * 3 / 2);
            // Cinza 128 -> Y ~126 (faixa de vídeo); vermelho -> Y ~82, V alto.
            let y_gray = out[(oh - 1) * ow + ow / 2];
            let y_red = out[ow / 2];
            let v_red = out[ow * oh + 1];
            assert!((120..=132).contains(&y_gray), "y cinza {y_gray}");
            assert!((76..=88).contains(&y_red), "y vermelho {y_red}");
            assert!(v_red > 220, "v vermelho {v_red}");
        }
    }
}
