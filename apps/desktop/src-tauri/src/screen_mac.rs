//! Compartilhar tela com seletor próprio no macOS (ScreenCaptureKit).
//!
//! O WKWebView não deixa escolher a fonte do `getDisplayMedia` por código, então:
//! 1. `screen_sources` lista janelas e telas com miniaturas (SCShareableContent + SCScreenshotManager).
//! 2. `screen_start` captura a fonte já reduzida pelo próprio macOS até a resolução escolhida,
//!    em NV12 (1,5 byte por pixel), e manda cada quadro por um WebSocket só do 127.0.0.1
//!    (com senha aleatória na URL). A página monta uma trilha de vídeo a partir disso.
//! 3. O áudio vem do próprio ScreenCaptureKit, já sem o som do Line.
//!
//! Mensagens binárias: byte 0 = tipo (1 vídeo, 2 áudio, 3 fim).
//! Vídeo: u32 largura, u32 altura, u64 tempo (µs), plano Y e depois plano UV, sem sobra.
//! Áudio: u32 taxa, u32 canais, u64 tempo (µs), float32 intercalado.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Instant;

use base64::Engine;
use futures_util::{SinkExt, StreamExt};
use screencapturekit::cv::CVPixelBufferLockFlags;
use screencapturekit::prelude::*;
use screencapturekit::screenshot_manager::{CGImageExt, SCScreenshotManager};
use serde::Serialize;
use tokio::sync::mpsc;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Source {
    id: String,
    name: String,
    is_screen: bool,
    thumbnail: String,
}

fn no_permission() -> String {
    "Sem permissão de gravação de tela. Libere o Line em Ajustes do Sistema > Privacidade e Segurança > Gravação de Tela e abra o Line de novo.".into()
}

fn thumb(filter: &SCContentFilter, w: f64, h: f64) -> String {
    if w <= 0.0 || h <= 0.0 {
        return String::new();
    }
    let scale = (400.0 / w).min(225.0 / h).min(1.0);
    let (tw, th) = (((w * scale) as u32).max(2), ((h * scale) as u32).max(2));
    let config = SCStreamConfiguration::new().with_width(tw).with_height(th).with_shows_cursor(false);
    let Ok(img) = SCScreenshotManager::capture_image(filter, &config) else { return String::new() };
    let (iw, ih) = (img.width() as u32, img.height() as u32);
    let Ok(rgba) = img.rgba_data() else { return String::new() };
    let Some(rgba) = image::RgbaImage::from_raw(iw, ih, rgba) else { return String::new() };
    let rgb = image::DynamicImage::ImageRgba8(rgba).to_rgb8();
    let mut jpeg = Vec::new();
    let enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 72);
    if image::ImageEncoder::write_image(enc, rgb.as_raw(), rgb.width(), rgb.height(), image::ExtendedColorType::Rgb8).is_err() {
        return String::new();
    }
    format!("data:image/jpeg;base64,{}", base64::engine::general_purpose::STANDARD.encode(jpeg))
}

#[tauri::command]
pub async fn screen_sources() -> Result<Vec<Source>, String> {
    tauri::async_runtime::spawn_blocking(list_sources).await.map_err(|e| e.to_string())?
}

fn list_sources() -> Result<Vec<Source>, String> {
    let content = SCShareableContent::get().map_err(|_| no_permission())?;
    let me = std::process::id() as i32;
    let mut out = Vec::new();
    for w in content.windows() {
        let title = w.title().unwrap_or_default();
        let f = w.frame();
        let app = w.owning_application();
        if title.trim().is_empty()
            || !w.is_on_screen()
            || w.window_layer() != 0
            || f.size.width < 64.0
            || f.size.height < 64.0
            || app.as_ref().map(|a| a.process_id()) == Some(me)
        {
            continue;
        }
        let name = match app.map(|a| a.application_name()) {
            Some(a) if !a.is_empty() && a != title => format!("{title} · {a}"),
            _ => title,
        };
        let thumbnail = SCContentFilter::create()
            .with_window(&w)
            .build()
            .map(|f2| thumb(&f2, f.size.width, f.size.height))
            .unwrap_or_default();
        out.push(Source { id: format!("window:{}", w.window_id()), name, is_screen: false, thumbnail });
    }
    for (i, d) in content.displays().into_iter().enumerate() {
        let thumbnail = SCContentFilter::create()
            .with_display(&d)
            .with_excluding_windows(&[])
            .build()
            .map(|f| thumb(&f, d.width() as f64, d.height() as f64))
            .unwrap_or_default();
        out.push(Source {
            id: format!("screen:{}", d.display_id()),
            name: if i == 0 { format!("Tela {} (principal)", i + 1) } else { format!("Tela {}", i + 1) },
            is_screen: true,
            thumbnail,
        });
    }
    Ok(out)
}

// ---------- captura ----------

struct Output {
    tx: mpsc::Sender<Vec<u8>>,
    started: Instant,
}

fn header(kind: u8, a: u32, b: u32, ts: u64, cap: usize) -> Vec<u8> {
    let mut v = Vec::with_capacity(17 + cap);
    v.push(kind);
    v.extend_from_slice(&a.to_le_bytes());
    v.extend_from_slice(&b.to_le_bytes());
    v.extend_from_slice(&ts.to_le_bytes());
    v
}

impl SCStreamOutputTrait for Output {
    fn did_output_sample_buffer(&self, sample: CMSampleBuffer, kind: SCStreamOutputType) {
        let ts = self.started.elapsed().as_micros() as u64;
        match kind {
            SCStreamOutputType::Screen => {
                // Página atrasada (fila cheia): pula o quadro em vez de acumular atraso.
                if self.tx.capacity() == 0 {
                    return;
                }
                let Some(pb) = sample.pixel_buffer() else { return };
                let Ok(guard) = pb.lock(CVPixelBufferLockFlags::READ_ONLY) else { return };
                let (w, h) = (pb.width(), pb.height());
                if w == 0 || h == 0 || pb.plane_count() < 2 {
                    return;
                }
                let mut msg = header(1, w as u32, h as u32, ts, w * h * 3 / 2);
                for plane in 0..2 {
                    let Some(base) = guard.base_address_of_plane(plane) else { return };
                    let rows = pb.height_of_plane(plane);
                    let stride = pb.bytes_per_row_of_plane(plane);
                    let row = pb.width_of_plane(plane) * if plane == 0 { 1 } else { 2 };
                    for y in 0..rows {
                        let src = unsafe { std::slice::from_raw_parts(base.add(y * stride), row) };
                        msg.extend_from_slice(src);
                    }
                }
                drop(guard);
                let _ = self.tx.try_send(msg);
            }
            SCStreamOutputType::Audio => {
                let Ok(list) = sample.audio_buffer_list() else { return };
                let n = list.num_buffers();
                if n == 0 {
                    return;
                }
                // O macOS entrega float32 com um buffer por canal; junta intercalado.
                let chans: Vec<&[u8]> = (0..n).filter_map(|i| list.get(i).map(|b| b.data())).collect();
                if chans.len() == 1 {
                    let mut msg = header(2, 48_000, 1, ts, chans[0].len());
                    msg.extend_from_slice(chans[0]);
                    let _ = self.tx.try_send(msg);
                    return;
                }
                let frames = chans.iter().map(|c| c.len() / 4).min().unwrap_or(0);
                let mut msg = header(2, 48_000, chans.len() as u32, ts, frames * chans.len() * 4);
                for f in 0..frames {
                    for c in &chans {
                        msg.extend_from_slice(&c[f * 4..f * 4 + 4]);
                    }
                }
                let _ = self.tx.try_send(msg);
            }
            _ => {}
        }
    }
}

struct Session {
    stream: SCStream,
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
pub async fn screen_start(id: String, fps: u32, audio: bool, height: Option<u32>) -> Result<Started, String> {
    stop_session();
    let (kind, raw) = id.split_once(':').ok_or("fonte inválida")?;
    let raw: u32 = raw.parse().map_err(|_| "fonte inválida")?;
    let fps = fps.clamp(5, 60);
    let max_h = height.unwrap_or(1080).clamp(360, 2160) as f64;

    let content = SCShareableContent::get().map_err(|_| no_permission())?;
    let (filter, w, h) = match kind {
        "window" => {
            let win = content.windows().into_iter().find(|w| w.window_id() == raw).ok_or("a janela foi fechada")?;
            let f = win.frame();
            // O frame vem em pontos; a captura em pixels reais pode ter o dobro (Retina).
            let filter = SCContentFilter::create().with_window(&win).build().map_err(|e| e.to_string())?;
            let s = filter.point_pixel_scale().max(1.0) as f64;
            (filter, f.size.width * s, f.size.height * s)
        }
        "screen" => {
            let d = content.displays().into_iter().find(|d| d.display_id() == raw).ok_or("tela não encontrada")?;
            let filter = SCContentFilter::create()
                .with_display(&d)
                .with_excluding_windows(&[])
                .build()
                .map_err(|e| e.to_string())?;
            let s = filter.point_pixel_scale().max(1.0) as f64;
            (filter, d.width() as f64 * s, d.height() as f64 * s)
        }
        _ => return Err("fonte inválida".into()),
    };
    // Reduz no próprio macOS (de graça, na placa de vídeo) até a resolução escolhida.
    let scale = (max_h / h).min(max_h * 16.0 / 9.0 / w).min(1.0);
    let (ow, oh) = (((w * scale) as u32 / 2 * 2).max(2), ((h * scale) as u32 / 2 * 2).max(2));

    let config = SCStreamConfiguration::new()
        .with_width(ow)
        .with_height(oh)
        .with_pixel_format(PixelFormat::YCbCr_420v)
        .with_fps(fps)
        .with_queue_depth(5)
        .with_shows_cursor(true)
        .with_captures_audio(audio)
        .with_sample_rate(48_000)
        .with_channel_count(2)
        .with_excludes_current_process_audio(true);

    // WebSocket só no 127.0.0.1, porta livre, com senha aleatória no caminho.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    let token: String = format!("{:032x}", rand::random::<u128>());
    let (tx, mut rx) = mpsc::channel::<Vec<u8>>(3);

    let mut stream = SCStream::new(&filter, &config).map_err(|e| e.to_string())?;
    let started = Instant::now();
    stream
        .add_output_handler(Output { tx: tx.clone(), started }, SCStreamOutputType::Screen)
        .map_err(|e| e.to_string())?;
    if audio {
        let _ = stream.add_output_handler(Output { tx: tx.clone(), started }, SCStreamOutputType::Audio);
    }
    drop(tx);

    let path = format!("/{token}");
    let server = tauri::async_runtime::spawn(async move {
        // Uma conexão só: a da página, com a senha certa.
        loop {
            let Ok((sock, _)) = listener.accept().await else { return };
            let want = path.clone();
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
                            // A captura parou (janela fechada ou fim): avisa a página.
                            let _ = sink.send(tokio_tungstenite::tungstenite::Message::binary(vec![3u8])).await;
                            return;
                        }
                    },
                    other = incoming.next() => if other.is_none() { return },
                }
            }
        }
    });

    if let Err(err) = stream.start_capture() {
        server.abort();
        return Err(format!("não foi possível capturar: {err}"));
    }
    let session = NEXT.fetch_add(1, Ordering::Relaxed);
    *SESSION.lock().unwrap() = Some(Session { stream, server });
    Ok(Started { session, url: format!("ws://127.0.0.1:{port}/{token}") })
}

fn stop_session() {
    if let Some(s) = SESSION.lock().unwrap().take() {
        let _ = s.stream.stop_capture();
        s.server.abort();
    }
}

#[tauri::command]
pub async fn screen_stop() {
    let _ = tauri::async_runtime::spawn_blocking(stop_session).await;
}
