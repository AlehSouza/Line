//! Ponte entre a página e o motor WebRTC em Rust (crate `line-rtc`), só no Linux.
//!
//! O WebKitGTK das distros não tem `RTCPeerConnection`. O `rtc_shim.js` (injetado antes da
//! interface) cria um `RTCPeerConnection` com a mesma forma do navegador e repassa cada chamada
//! para cá. Assim o `voice.ts` é o mesmo do Windows, do macOS e da web.
//!
//! Do Rust para a página vão dois canais:
//! - `control`: eventos em JSON (candidatos ICE, estado da conexão, trilha nova...);
//! - `media`: binário, em lotes. Cada item é `[tipo u8][recepção u32][tamanho u32][dados]`, com
//!   tipo 1 = PCM 48 kHz mono (i16), 2 = quadro VP8, 3 = quadro-chave VP8 (os dois com o
//!   timestamp RTP u32 na frente).
//!
//! Da página para cá, a mídia local chega por `rtc_push` com corpo binário:
//! `[tipo u8][fonte u32][duração em µs u32][dados]` (1 = PCM de 20 ms, 2 = quadro VP8).

use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::Bytes;
use line_rtc::{Control, Engine, IceCandidateInit, IceServer, Id, Kind, Media, SessionDescription, Sink, Snapshot};
use tauri::ipc::{Channel, InvokeBody, InvokeResponseBody, Request};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};

/// Junta a mídia que chega em até ~5 ms numa mensagem só: cada mensagem custa uma ida e volta
/// pela ponte do WebView, então mandar pacote a pacote não escala com várias pessoas na chamada.
const BATCH_WINDOW: Duration = Duration::from_millis(5);
const BATCH_MAX: usize = 256 * 1024;

struct PageSink {
    control: Mutex<Option<Channel<Control>>>,
    media: Mutex<Option<UnboundedSender<Media>>>,
}

impl Sink for PageSink {
    fn control(&self, event: Control) {
        if let Some(ch) = self.control.lock().unwrap().as_ref() {
            let _ = ch.send(event);
        }
    }

    fn media(&self, media: Media) {
        if let Some(tx) = self.media.lock().unwrap().as_ref() {
            let _ = tx.send(media);
        }
    }
}

pub struct Rtc {
    engine: Engine,
    sink: Arc<PageSink>,
    /// Conexões abertas pela página atual (fecham se a página recarregar).
    pcs: Mutex<Vec<Id>>,
}

impl Rtc {
    pub fn new() -> Self {
        let sink = Arc::new(PageSink { control: Mutex::new(None), media: Mutex::new(None) });
        Self { engine: Engine::new(sink.clone()), sink, pcs: Mutex::new(Vec::new()) }
    }
}

fn encode(item: &Media, out: &mut Vec<u8>) {
    match item {
        Media::Audio { receiver, pcm } => {
            out.push(1);
            out.extend_from_slice(&receiver.to_le_bytes());
            out.extend_from_slice(&((pcm.len() * 2) as u32).to_le_bytes());
            for s in pcm {
                out.extend_from_slice(&s.to_le_bytes());
            }
        }
        Media::Video { receiver, keyframe, timestamp, data } => {
            out.push(if *keyframe { 3 } else { 2 });
            out.extend_from_slice(&receiver.to_le_bytes());
            out.extend_from_slice(&((data.len() + 4) as u32).to_le_bytes());
            out.extend_from_slice(&timestamp.to_le_bytes());
            out.extend_from_slice(data);
        }
    }
}

async fn pump(mut rx: UnboundedReceiver<Media>, channel: Channel<InvokeResponseBody>) {
    while let Some(first) = rx.recv().await {
        let mut buf = Vec::with_capacity(4096);
        encode(&first, &mut buf);
        let deadline = tokio::time::Instant::now() + BATCH_WINDOW;
        while buf.len() < BATCH_MAX {
            match tokio::time::timeout_at(deadline, rx.recv()).await {
                Ok(Some(item)) => encode(&item, &mut buf),
                Ok(None) => break,
                Err(_) => break,
            }
        }
        if channel.send(InvokeResponseBody::Raw(buf)).is_err() {
            break;
        }
    }
}

type R<T> = Result<T, String>;

/// A página (re)abriu: liga os canais novos e fecha o que a página anterior deixou aberto.
#[tauri::command]
pub async fn rtc_attach(
    state: tauri::State<'_, Rtc>,
    control: Channel<Control>,
    media: Channel<InvokeResponseBody>,
) -> R<()> {
    let old: Vec<Id> = std::mem::take(&mut *state.pcs.lock().unwrap());
    for pc in old {
        state.engine.close_pc(pc).await;
    }
    let (tx, rx) = unbounded_channel();
    *state.sink.control.lock().unwrap() = Some(control);
    *state.sink.media.lock().unwrap() = Some(tx);
    tauri::async_runtime::spawn(pump(rx, media));
    Ok(())
}

#[tauri::command]
pub async fn rtc_create(state: tauri::State<'_, Rtc>, pc: Id, ice_servers: Vec<IceServer>) -> R<()> {
    state.engine.create_pc(pc, ice_servers).await?;
    state.pcs.lock().unwrap().push(pc);
    Ok(())
}

#[tauri::command]
pub async fn rtc_close(state: tauri::State<'_, Rtc>, pc: Id) -> R<()> {
    state.pcs.lock().unwrap().retain(|p| *p != pc);
    state.engine.close_pc(pc).await;
    Ok(())
}

#[tauri::command]
pub async fn rtc_add_track(
    state: tauri::State<'_, Rtc>,
    pc: Id,
    sender: Id,
    kind: Kind,
    track_id: String,
    stream_ids: Vec<String>,
    direction: Option<String>,
) -> R<()> {
    state.engine.add_track(pc, sender, kind, track_id, stream_ids, direction).await
}

#[tauri::command]
pub async fn rtc_remove_track(state: tauri::State<'_, Rtc>, pc: Id, sender: Id) -> R<()> {
    state.engine.remove_track(pc, sender).await
}

#[tauri::command]
pub fn rtc_bind(state: tauri::State<'_, Rtc>, pc: Id, sender: Id, source: Option<Id>) {
    state.engine.bind(pc, sender, source);
}

#[tauri::command]
pub async fn rtc_create_offer(state: tauri::State<'_, Rtc>, pc: Id) -> R<SessionDescription> {
    state.engine.create_offer(pc).await
}

#[tauri::command]
pub async fn rtc_create_answer(state: tauri::State<'_, Rtc>, pc: Id) -> R<SessionDescription> {
    state.engine.create_answer(pc).await
}

#[tauri::command]
pub async fn rtc_set_local(state: tauri::State<'_, Rtc>, pc: Id, desc: Option<SessionDescription>) -> R<Snapshot> {
    state.engine.set_local(pc, desc).await
}

#[tauri::command]
pub async fn rtc_set_remote(state: tauri::State<'_, Rtc>, pc: Id, desc: SessionDescription) -> R<Snapshot> {
    state.engine.set_remote(pc, desc).await
}

#[tauri::command]
pub async fn rtc_add_ice(state: tauri::State<'_, Rtc>, pc: Id, candidate: Option<IceCandidateInit>) -> R<()> {
    state.engine.add_ice_candidate(pc, candidate).await
}

#[tauri::command]
pub async fn rtc_restart_ice(state: tauri::State<'_, Rtc>, pc: Id) -> R<()> {
    state.engine.restart_ice(pc).await
}

#[tauri::command]
pub async fn rtc_request_keyframe(state: tauri::State<'_, Rtc>, pc: Id, receiver: Id) -> R<()> {
    state.engine.request_keyframe(pc, receiver).await;
    Ok(())
}

#[tauri::command]
pub fn rtc_add_source(state: tauri::State<'_, Rtc>, source: Id, kind: Kind) -> R<()> {
    state.engine.add_source(source, kind)
}

#[tauri::command]
pub fn rtc_remove_source(state: tauri::State<'_, Rtc>, source: Id) {
    state.engine.remove_source(source);
}

/// Mídia local vinda da página (PCM do microfone ou quadro VP8 da câmera/tela).
#[tauri::command]
pub async fn rtc_push(state: tauri::State<'_, Rtc>, request: Request<'_>) -> R<()> {
    let InvokeBody::Raw(body) = request.body() else { return Err("corpo inválido".into()) };
    if body.len() < 9 {
        return Err("corpo curto".into());
    }
    let kind = body[0];
    let source = u32::from_le_bytes(body[1..5].try_into().unwrap());
    let duration_us = u32::from_le_bytes(body[5..9].try_into().unwrap());
    let data = &body[9..];
    match kind {
        1 => {
            let pcm: Vec<i16> = data.chunks_exact(2).map(|c| i16::from_le_bytes([c[0], c[1]])).collect();
            state.engine.push_audio(source, &pcm).await;
        }
        2 => {
            let duration = Duration::from_micros(duration_us.clamp(1_000, 1_000_000) as u64);
            state.engine.push_video(source, duration, Bytes::copy_from_slice(data)).await;
        }
        _ => return Err("tipo desconhecido".into()),
    }
    Ok(())
}
