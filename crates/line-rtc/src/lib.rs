//! Motor WebRTC do app Linux do Line.
//!
//! O WebKitGTK das distros vem sem `RTCPeerConnection` (o backend WebRTC dele é experimental e
//! fica desligado na compilação), então no Linux quem faz o papel do navegador é este crate:
//!
//! - as conexões, o ICE (STUN/TURN), o DTLS/SRTP e o RTP ficam no webrtc-rs;
//! - o áudio chega da página como PCM e sai para a página como PCM (Opus codificado aqui, com
//!   a libopus compilada junto, sem depender do GStreamer de cada distro);
//! - o vídeo chega da página já em VP8 (WebCodecs) e sai para a página em quadros VP8 inteiros,
//!   que ela decodifica com o `VideoDecoder`.
//!
//! O crate não conhece Tauri nem WebKit: quem usa implementa [`Sink`] para entregar os eventos à
//! página. Os números (`Id`) de conexões, envios e fontes são escolhidos pela página; os das
//! recepções, por este lado.

pub mod audio;

use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::{Duration, Instant};

use bytes::Bytes;
use serde::{Deserialize, Serialize};

use rtc::media::Sample;
use rtc::media::io::sample_builder::SampleBuilder;
use rtc::rtcp::payload_feedbacks::picture_loss_indication::PictureLossIndication;
use rtc::rtp::codec::vp8::Vp8Packet;
use rtc::rtp_transceiver::RTCRtpTransceiverDirection;
use rtc::rtp_transceiver::RTCRtpTransceiverInit;
use rtc::rtp_transceiver::rtp_sender::{
    RTCPFeedback, RTCRtpCodec, RTCRtpCodecParameters, RTCRtpCodingParameters,
    RTCRtpEncodingParameters, RtpCodecKind,
};
use webrtc::media_stream::track_local::TrackLocal;
use webrtc::media_stream::track_local::static_sample::TrackLocalStaticSample;
use webrtc::media_stream::track_remote::{TrackRemote, TrackRemoteEvent};
use webrtc::media_stream::MediaStreamTrack;
use webrtc::peer_connection::{
    MediaEngine, PeerConnection, PeerConnectionBuilder, PeerConnectionEventHandler,
    RTCConfigurationBuilder, RTCIceCandidateInit, RTCIceConnectionState, RTCIceGatheringState,
    RTCIceServer, RTCPeerConnectionIceEvent, RTCPeerConnectionState, RTCSdpType,
    RTCSessionDescription, Registry, register_default_interceptors,
};
use webrtc::rtp_transceiver::RtpSender;

pub use webrtc::peer_connection::{RTCIceCandidateInit as IceCandidateInit, RTCSessionDescription as SessionDescription};

pub type Id = u32;

/// STUN de reserva quando a lista do servidor não serve.
const FALLBACK_STUN: &str = "stun:stun.l.google.com:19302";

// ---------- o que vai para a página ----------

/// Eventos de controle (viram JSON na página).
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "lowercase", rename_all_fields = "camelCase")]
pub enum Control {
    /// `negotiationneeded` da conexão.
    NegotiationNeeded { pc: Id },
    /// Candidato ICE novo; `None` quando a coleta terminou.
    IceCandidate { pc: Id, candidate: Option<RTCIceCandidateInit> },
    IceGatheringState { pc: Id, state: String },
    IceConnectionState { pc: Id, state: String },
    ConnectionState { pc: Id, state: String },
    /// Trilha remota nova (o `track` do navegador).
    Track { pc: Id, receiver: Id, kind: Kind, track_id: String, stream_ids: Vec<String> },
    /// A trilha remota acabou (o outro lado tirou ou a conexão fechou).
    TrackEnded { pc: Id, receiver: Id },
    /// Alguém precisa de um quadro-chave desta fonte de vídeo (conexão nova, renegociação).
    Keyframe { source: Id },
}

/// Mídia recebida, já pronta para a página.
#[derive(Debug, Clone)]
pub enum Media {
    /// 48 kHz, mono, normalmente 960 amostras (20 ms).
    Audio { receiver: Id, pcm: Vec<i16> },
    /// Um quadro VP8 inteiro. `timestamp` é o do RTP (90 kHz).
    Video { receiver: Id, keyframe: bool, timestamp: u32, data: Bytes },
}

/// Quem recebe os eventos (no app, o casco Tauri, que repassa para a página).
pub trait Sink: Send + Sync + 'static {
    fn control(&self, event: Control);
    fn media(&self, media: Media);
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Audio,
    Video,
}

impl From<Kind> for RtpCodecKind {
    fn from(k: Kind) -> Self {
        match k {
            Kind::Audio => RtpCodecKind::Audio,
            Kind::Video => RtpCodecKind::Video,
        }
    }
}

/// `RTCIceServer` como a página manda (urls pode ser uma só ou uma lista).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IceServer {
    pub urls: Urls,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub credential: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum Urls {
    One(String),
    Many(Vec<String>),
}

/// Estado de sinalização depois de uma operação, para a página atualizar na hora
/// (`signalingState`, `localDescription`...) sem esperar evento.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub signaling_state: &'static str,
    pub local_description: Option<RTCSessionDescription>,
    pub remote_description: Option<RTCSessionDescription>,
}

// ---------- codecs ----------

fn opus_codec() -> RTCRtpCodecParameters {
    RTCRtpCodecParameters {
        rtp_codec: RTCRtpCodec {
            mime_type: "audio/opus".to_owned(),
            clock_rate: 48000,
            channels: 2,
            sdp_fmtp_line: "minptime=10;useinbandfec=1".to_owned(),
            rtcp_feedback: vec![],
        },
        payload_type: 111,
    }
}

fn vp8_codec() -> RTCRtpCodecParameters {
    let fb = |typ: &str, parameter: &str| RTCPFeedback { typ: typ.to_owned(), parameter: parameter.to_owned() };
    RTCRtpCodecParameters {
        rtp_codec: RTCRtpCodec {
            mime_type: "video/VP8".to_owned(),
            clock_rate: 90000,
            channels: 0,
            sdp_fmtp_line: String::new(),
            rtcp_feedback: vec![fb("goog-remb", ""), fb("ccm", "fir"), fb("nack", ""), fb("nack", "pli")],
        },
        payload_type: 96,
    }
}

fn rtx_codec() -> RTCRtpCodecParameters {
    RTCRtpCodecParameters {
        rtp_codec: RTCRtpCodec {
            mime_type: "video/rtx".to_owned(),
            clock_rate: 90000,
            channels: 0,
            sdp_fmtp_line: "apt=96".to_owned(),
            rtcp_feedback: vec![],
        },
        payload_type: 97,
    }
}

/// Só Opus e VP8: o VP8 é o único vídeo que todo navegador manda e que o GStreamer de
/// qualquer distro decodifica (o H.264 depende de plugin que muitas não instalam).
fn media_engine() -> Result<(MediaEngine, Registry), String> {
    let mut me = MediaEngine::default();
    me.register_codec(opus_codec(), RtpCodecKind::Audio).map_err(err)?;
    me.register_codec(vp8_codec(), RtpCodecKind::Video).map_err(err)?;
    me.register_codec(rtx_codec(), RtpCodecKind::Video).map_err(err)?;
    let registry = register_default_interceptors(Registry::new(), &mut me).map_err(err)?;
    Ok((me, registry))
}

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

fn direction(s: &str) -> RTCRtpTransceiverDirection {
    match s {
        "sendonly" => RTCRtpTransceiverDirection::Sendonly,
        "recvonly" => RTCRtpTransceiverDirection::Recvonly,
        "inactive" => RTCRtpTransceiverDirection::Inactive,
        _ => RTCRtpTransceiverDirection::Sendrecv,
    }
}

// ---------- motor ----------

struct Sender {
    kind: Kind,
    rtp_sender: Arc<dyn RtpSender>,
    track: Arc<TrackLocalStaticSample>,
    ssrc: u32,
    /// Payload type negociado (muda numa renegociação, então é esquecido a cada uma).
    payload_type: Mutex<Option<u8>>,
    source: Mutex<Option<Id>>,
}

impl Sender {
    async fn payload_type(&self) -> Option<u8> {
        if let Some(pt) = *self.payload_type.lock().unwrap() {
            return Some(pt);
        }
        let params = self.rtp_sender.get_parameters().await.ok()?;
        let pt = params.rtp_parameters.codecs.first()?.payload_type;
        *self.payload_type.lock().unwrap() = Some(pt);
        Some(pt)
    }

    async fn write(&self, data: Bytes, duration: Duration) {
        let Some(pt) = self.payload_type().await else { return };
        let sample = Sample { data, duration, ..Sample::new(Instant::now()) };
        // Antes de negociar (ou depois de fechar) a trilha não está ligada: só descarta.
        let _ = self.track.sample_writer(self.ssrc, pt).write_sample(&sample).await;
    }
}

/// Recepção aberta: id da trilha remota e a trilha.
type Receiver = (String, Arc<dyn TrackRemote>);

struct Pc {
    conn: Arc<dyn PeerConnection>,
    senders: Mutex<HashMap<Id, Arc<Sender>>>,
    receivers: Mutex<HashMap<Id, Receiver>>,
}

struct Source {
    kind: Kind,
    /// Só existe para áudio.
    encoder: Mutex<Option<audio::Encoder>>,
    /// (conexão, envio) que transmitem esta fonte.
    targets: Mutex<Vec<(Id, Id)>>,
}

struct Inner {
    sink: Arc<dyn Sink>,
    pcs: Mutex<HashMap<Id, Arc<Pc>>>,
    sources: Mutex<HashMap<Id, Arc<Source>>>,
    next_receiver: AtomicU32,
}

impl Inner {
    fn pc(&self, id: Id) -> Result<Arc<Pc>, String> {
        self.pcs.lock().unwrap().get(&id).cloned().ok_or_else(|| "conexão fechada".to_string())
    }

    fn unbind(&self, pc: Id, sender: Id, source: Option<Id>) {
        let Some(source) = source else { return };
        if let Some(s) = self.sources.lock().unwrap().get(&source) {
            s.targets.lock().unwrap().retain(|t| *t != (pc, sender));
        }
    }

    /// Encerra uma recepção (uma vez só: pelo fim da trilha ou pela renegociação, o que vier antes).
    fn end_receiver(&self, pc_id: Id, pc: &Pc, receiver: Id) {
        if pc.receivers.lock().unwrap().remove(&receiver).is_some() {
            self.sink.control(Control::TrackEnded { pc: pc_id, receiver });
        }
    }

    /// Pede quadro-chave das fontes de vídeo transmitidas nesta conexão.
    fn keyframes_for(&self, pc: &Pc) {
        let sources: Vec<Id> = pc
            .senders
            .lock()
            .unwrap()
            .values()
            .filter(|s| s.kind == Kind::Video)
            .filter_map(|s| *s.source.lock().unwrap())
            .collect();
        for source in sources {
            self.sink.control(Control::Keyframe { source });
        }
    }
}

pub struct Engine {
    inner: Arc<Inner>,
}

impl Engine {
    pub fn new(sink: Arc<dyn Sink>) -> Self {
        Self {
            inner: Arc::new(Inner {
                sink,
                pcs: Mutex::new(HashMap::new()),
                sources: Mutex::new(HashMap::new()),
                next_receiver: AtomicU32::new(1),
            }),
        }
    }

    // ----- conexões -----

    pub async fn create_pc(&self, id: Id, ice_servers: Vec<IceServer>) -> Result<(), String> {
        let servers: Vec<RTCIceServer> = ice_servers
            .into_iter()
            .map(|s| RTCIceServer {
                urls: match s.urls {
                    Urls::One(u) => vec![u],
                    Urls::Many(u) => u,
                },
                username: s.username.unwrap_or_default(),
                credential: s.credential.unwrap_or_default(),
            })
            .filter(|s| !s.urls.is_empty())
            .collect();
        let urls: Vec<&str> = servers.iter().flat_map(|s| s.urls.iter().map(String::as_str)).collect();
        tracing::info!("conexão {id}: criando (ICE: {})", urls.join(", "));
        let conn = match self.build(id, servers.clone()).await {
            Ok(c) => c,
            Err(e) => {
                // Um endereço de TURN/STUN que o webrtc-rs não entende não pode derrubar a chamada.
                tracing::warn!("ICE do servidor recusado ({e}); usando só o STUN público");
                let stun = RTCIceServer { urls: vec![FALLBACK_STUN.to_owned()], ..Default::default() };
                self.build(id, vec![stun]).await?
            }
        };
        self.inner.pcs.lock().unwrap().insert(
            id,
            Arc::new(Pc { conn, senders: Mutex::new(HashMap::new()), receivers: Mutex::new(HashMap::new()) }),
        );
        Ok(())
    }

    async fn build(&self, id: Id, servers: Vec<RTCIceServer>) -> Result<Arc<dyn PeerConnection>, String> {
        let (me, registry) = media_engine()?;
        let config = RTCConfigurationBuilder::new().with_ice_servers(servers).build();
        let handler = Arc::new(Handler { pc: id, inner: Arc::downgrade(&self.inner) });
        let conn = PeerConnectionBuilder::new()
            .with_configuration(config)
            .with_media_engine(me)
            .with_interceptor_registry(registry)
            .with_handler(handler)
            .with_udp_addrs(vec!["0.0.0.0:0"])
            .build()
            .await
            .map_err(err)?;
        Ok(Arc::new(conn))
    }

    pub async fn close_pc(&self, id: Id) {
        let Some(pc) = self.inner.pcs.lock().unwrap().remove(&id) else { return };
        let senders: Vec<(Id, Option<Id>)> =
            pc.senders.lock().unwrap().iter().map(|(sid, s)| (*sid, *s.source.lock().unwrap())).collect();
        for (sid, source) in senders {
            self.inner.unbind(id, sid, source);
        }
        let _ = pc.conn.close().await;
    }

    // ----- envio -----

    /// `addTrack` / `addTransceiver(track)`. Com `direction`, cria um transceiver próprio.
    pub async fn add_track(
        &self,
        pc: Id,
        sender: Id,
        kind: Kind,
        track_id: String,
        stream_ids: Vec<String>,
        direction_: Option<String>,
    ) -> Result<(), String> {
        let p = self.inner.pc(pc)?;
        let codec = match kind {
            Kind::Audio => opus_codec(),
            Kind::Video => vp8_codec(),
        };
        let ssrc: u32 = rand::random();
        let encodings = vec![RTCRtpEncodingParameters {
            rtp_coding_parameters: RTCRtpCodingParameters { ssrc: Some(ssrc), ..Default::default() },
            codec: codec.rtp_codec.clone(),
            ..Default::default()
        }];
        let stream_id = stream_ids.first().cloned().unwrap_or_else(|| "-".to_owned());
        let track = Arc::new(
            TrackLocalStaticSample::new(
                Instant::now(),
                MediaStreamTrack::new(stream_id, track_id.clone(), track_id, kind.into(), encodings.clone()),
            )
            .map_err(err)?,
        );
        let local: Arc<dyn TrackLocal> = track.clone();
        let rtp_sender = match direction_ {
            Some(d) => {
                let init = RTCRtpTransceiverInit {
                    direction: direction(&d),
                    streams: stream_ids,
                    send_encodings: encodings,
                };
                let t = p.conn.add_transceiver_from_track(local, Some(init)).await.map_err(err)?;
                t.sender().await.map_err(err)?.ok_or("transceiver sem envio")?
            }
            None => p.conn.add_track(local).await.map_err(err)?,
        };
        p.senders.lock().unwrap().insert(
            sender,
            Arc::new(Sender {
                kind,
                rtp_sender,
                track,
                ssrc,
                payload_type: Mutex::new(None),
                source: Mutex::new(None),
            }),
        );
        Ok(())
    }

    pub async fn remove_track(&self, pc: Id, sender: Id) -> Result<(), String> {
        let p = self.inner.pc(pc)?;
        let Some(s) = p.senders.lock().unwrap().remove(&sender) else { return Ok(()) };
        self.inner.unbind(pc, sender, *s.source.lock().unwrap());
        p.conn.remove_track(&s.rtp_sender).await.map_err(err)
    }

    /// Liga um envio a uma fonte local (ou desliga, com `None`). É o `replaceTrack`: não mexe
    /// na negociação, só muda de onde vêm os pacotes.
    pub fn bind(&self, pc: Id, sender: Id, source: Option<Id>) {
        let Ok(p) = self.inner.pc(pc) else { return };
        let Some(s) = p.senders.lock().unwrap().get(&sender).cloned() else { return };
        let old = std::mem::replace(&mut *s.source.lock().unwrap(), source);
        self.inner.unbind(pc, sender, old);
        if let Some(id) = source {
            if let Some(src) = self.inner.sources.lock().unwrap().get(&id) {
                src.targets.lock().unwrap().push((pc, sender));
            }
            if s.kind == Kind::Video {
                self.inner.sink.control(Control::Keyframe { source: id });
            }
        }
    }

    // ----- sinalização -----

    pub async fn create_offer(&self, pc: Id) -> Result<RTCSessionDescription, String> {
        self.inner.pc(pc)?.conn.create_offer(None).await.map_err(err)
    }

    pub async fn create_answer(&self, pc: Id) -> Result<RTCSessionDescription, String> {
        self.inner.pc(pc)?.conn.create_answer(None).await.map_err(err)
    }

    /// `setLocalDescription(desc?)`. Sem `desc`, cria a oferta ou a resposta conforme o estado
    /// (o "setLocalDescription implícito" que a negociação perfeita usa).
    pub async fn set_local(&self, pc: Id, desc: Option<RTCSessionDescription>) -> Result<Snapshot, String> {
        let p = self.inner.pc(pc)?;
        let desc = match desc {
            Some(d) => d,
            None if snapshot(&*p.conn).await.signaling_state == "have-remote-offer" => {
                p.conn.create_answer(None).await.map_err(err)?
            }
            None => p.conn.create_offer(None).await.map_err(err)?,
        };
        p.conn.set_local_description(desc).await.map_err(err)?;
        self.after_negotiation(pc, &p).await
    }

    /// `setRemoteDescription`. Uma oferta que chega enquanto a minha está pendente desfaz a minha
    /// primeiro (rollback implícito, como os navegadores fazem para o lado "educado").
    pub async fn set_remote(&self, pc: Id, desc: RTCSessionDescription) -> Result<Snapshot, String> {
        let p = self.inner.pc(pc)?;
        if desc.sdp_type == RTCSdpType::Offer && snapshot(&*p.conn).await.signaling_state == "have-local-offer" {
            let rollback = RTCSessionDescription::rollback(None).map_err(err)?;
            p.conn.set_local_description(rollback).await.map_err(err)?;
        }
        p.conn.set_remote_description(desc).await.map_err(err)?;
        self.after_negotiation(pc, &p).await
    }

    async fn after_negotiation(&self, pc: Id, p: &Pc) -> Result<Snapshot, String> {
        let snap = snapshot(&*p.conn).await;
        if snap.signaling_state == "stable" {
            for s in p.senders.lock().unwrap().values() {
                *s.payload_type.lock().unwrap() = None;
            }
            // Trilhas novas do outro lado só mostram imagem a partir de um quadro-chave.
            self.inner.keyframes_for(p);
            self.drop_removed_tracks(pc, p).await;
        }
        Ok(snap)
    }

    /// O outro lado tirou uma trilha (`removeTrack`): o transceiver deixa de receber, mas o
    /// webrtc-rs não encerra a trilha remota. O navegador tira a trilha do stream nessa hora;
    /// aqui ela acaba, e a página faz o mesmo.
    async fn drop_removed_tracks(&self, pc: Id, p: &Pc) {
        for t in p.conn.get_transceivers().await {
            let receiving = matches!(
                t.current_direction().await,
                Ok(RTCRtpTransceiverDirection::Sendrecv | RTCRtpTransceiverDirection::Recvonly)
            );
            if receiving {
                continue;
            }
            let Ok(Some(receiver)) = t.receiver().await else { continue };
            let track_id = receiver.track().track_id().await;
            let ended: Vec<Id> = p
                .receivers
                .lock()
                .unwrap()
                .iter()
                .filter(|(_, (tid, _))| *tid == track_id)
                .map(|(id, _)| *id)
                .collect();
            for id in ended {
                self.inner.end_receiver(pc, p, id);
            }
        }
    }

    pub async fn add_ice_candidate(&self, pc: Id, candidate: Option<RTCIceCandidateInit>) -> Result<(), String> {
        let p = self.inner.pc(pc)?;
        match candidate {
            Some(c) if !c.candidate.is_empty() => {
                // "candidate:... typ host|srflx|relay ..." e o endereço (um .local é mDNS do outro lado).
                let f: Vec<&str> = c.candidate.split_whitespace().collect();
                let typ = f.iter().position(|w| *w == "typ").and_then(|i| f.get(i + 1)).copied().unwrap_or("?");
                let addr = f.get(4).copied().unwrap_or("?");
                let proto = f.get(2).copied().unwrap_or("?");
                let res = p.conn.add_ice_candidate(c.clone()).await.map_err(err);
                match &res {
                    Ok(()) => tracing::info!("conexão {pc}: candidato remoto {typ} {proto} {addr}"),
                    Err(e) => tracing::warn!("conexão {pc}: candidato remoto {typ} {addr} recusado: {e}"),
                }
                res
            }
            // Fim dos candidatos: nada a fazer.
            _ => Ok(()),
        }
    }

    pub async fn restart_ice(&self, pc: Id) -> Result<(), String> {
        self.inner.pc(pc)?.conn.restart_ice().await.map_err(err)
    }

    pub async fn snapshot(&self, pc: Id) -> Result<Snapshot, String> {
        Ok(snapshot(&*self.inner.pc(pc)?.conn).await)
    }

    /// Pede ao outro lado um quadro-chave do vídeo que ele manda (o decodificador da página perdeu o fio).
    pub async fn request_keyframe(&self, pc: Id, receiver: Id) {
        let Ok(p) = self.inner.pc(pc) else { return };
        let Some((_, track)) = p.receivers.lock().unwrap().get(&receiver).cloned() else { return };
        send_pli(&*track).await;
    }

    // ----- fontes locais -----

    pub fn add_source(&self, id: Id, kind: Kind) -> Result<(), String> {
        let encoder = match kind {
            Kind::Audio => Some(audio::Encoder::new().map_err(err)?),
            Kind::Video => None,
        };
        self.inner.sources.lock().unwrap().insert(
            id,
            Arc::new(Source { kind, encoder: Mutex::new(encoder), targets: Mutex::new(Vec::new()) }),
        );
        Ok(())
    }

    pub fn remove_source(&self, id: Id) {
        self.inner.sources.lock().unwrap().remove(&id);
    }

    fn targets(&self, source: &Source) -> Vec<Arc<Sender>> {
        let targets = source.targets.lock().unwrap().clone();
        let pcs = self.inner.pcs.lock().unwrap();
        targets
            .into_iter()
            .filter_map(|(pc, sid)| pcs.get(&pc)?.senders.lock().unwrap().get(&sid).cloned())
            .collect()
    }

    /// 20 ms de PCM do microfone (ou de outra fonte de áudio): codifica uma vez e manda para todos.
    pub async fn push_audio(&self, source: Id, pcm: &[i16]) {
        let Some(src) = self.inner.sources.lock().unwrap().get(&source).cloned() else { return };
        let targets = self.targets(&src);
        if targets.is_empty() {
            return;
        }
        let Some(packet) = src.encoder.lock().unwrap().as_mut().and_then(|e| e.encode(pcm)) else { return };
        let data = Bytes::from(packet);
        for t in targets {
            t.write(data.clone(), Duration::from_millis(20)).await;
        }
    }

    /// Um quadro VP8 já codificado pela página.
    pub async fn push_video(&self, source: Id, duration: Duration, data: Bytes) {
        let Some(src) = self.inner.sources.lock().unwrap().get(&source).cloned() else { return };
        if src.kind != Kind::Video {
            return;
        }
        for t in self.targets(&src) {
            t.write(data.clone(), duration).await;
        }
    }
}

/// O estado de sinalização sai das descrições pendentes, como diz a especificação.
async fn snapshot(conn: &dyn PeerConnection) -> Snapshot {
    let pending_local = conn.pending_local_description().await;
    let pending_remote = conn.pending_remote_description().await;
    let signaling_state = match (&pending_local, &pending_remote) {
        (Some(d), _) if d.sdp_type == RTCSdpType::Offer => "have-local-offer",
        (_, Some(d)) if d.sdp_type == RTCSdpType::Offer => "have-remote-offer",
        (Some(d), _) if d.sdp_type == RTCSdpType::Pranswer => "have-local-pranswer",
        (_, Some(d)) if d.sdp_type == RTCSdpType::Pranswer => "have-remote-pranswer",
        _ => "stable",
    };
    Snapshot {
        signaling_state,
        local_description: conn.local_description().await,
        remote_description: conn.remote_description().await,
    }
}

async fn send_pli(track: &dyn TrackRemote) {
    let Some(&media_ssrc) = track.ssrcs().await.first() else { return };
    let _ = track.write_rtcp(vec![Box::new(PictureLossIndication { sender_ssrc: 0, media_ssrc })]).await;
}

// ---------- eventos do webrtc-rs ----------

struct Handler {
    pc: Id,
    inner: Weak<Inner>,
}

impl Handler {
    fn emit(&self, event: Control) {
        if let Some(inner) = self.inner.upgrade() {
            inner.sink.control(event);
        }
    }
}

#[async_trait::async_trait]
impl PeerConnectionEventHandler for Handler {
    async fn on_negotiation_needed(&self) {
        self.emit(Control::NegotiationNeeded { pc: self.pc });
    }

    async fn on_ice_candidate(&self, event: RTCPeerConnectionIceEvent) {
        tracing::info!(
            "conexão {}: candidato local {} {}:{}",
            self.pc,
            event.candidate.typ,
            event.candidate.address,
            event.candidate.port
        );
        match event.candidate.to_json() {
            Ok(candidate) => self.emit(Control::IceCandidate { pc: self.pc, candidate: Some(candidate) }),
            Err(e) => tracing::warn!("candidato ICE inválido: {e}"),
        }
    }

    async fn on_ice_gathering_state_change(&self, state: RTCIceGatheringState) {
        tracing::info!("conexão {}: coleta de candidatos {state}", self.pc);
        self.emit(Control::IceGatheringState { pc: self.pc, state: state.to_string() });
        if state == RTCIceGatheringState::Complete {
            self.emit(Control::IceCandidate { pc: self.pc, candidate: None });
        }
    }

    async fn on_ice_connection_state_change(&self, state: RTCIceConnectionState) {
        tracing::info!("conexão {}: ICE {state}", self.pc);
        self.emit(Control::IceConnectionState { pc: self.pc, state: state.to_string() });
    }

    async fn on_connection_state_change(&self, state: RTCPeerConnectionState) {
        tracing::info!("conexão {}: {state}", self.pc);
        self.emit(Control::ConnectionState { pc: self.pc, state: state.to_string() });
        if state == RTCPeerConnectionState::Connected
            && let Some(inner) = self.inner.upgrade()
            && let Ok(pc) = inner.pc(self.pc)
        {
            inner.keyframes_for(&pc);
        }
    }

    async fn on_track(&self, track: Arc<dyn TrackRemote>) {
        let Some(inner) = self.inner.upgrade() else { return };
        let receiver = inner.next_receiver.fetch_add(1, Ordering::Relaxed);
        let track_id = track.track_id().await;
        if let Ok(pc) = inner.pc(self.pc) {
            pc.receivers.lock().unwrap().insert(receiver, (track_id, track.clone()));
        }
        let pc = self.pc;
        let weak = self.inner.clone();
        tokio::spawn(async move {
            receive(weak.clone(), pc, receiver, track).await;
            if let Some(inner) = weak.upgrade() {
                match inner.pc(pc) {
                    Ok(p) => inner.end_receiver(pc, &p, receiver),
                    // Conexão já fechada: a página também fecha as trilhas dela.
                    Err(_) => inner.sink.control(Control::TrackEnded { pc, receiver }),
                }
            }
        });
    }
}

/// Lê a trilha remota até ela acabar, entregando PCM (áudio) ou quadros VP8 (vídeo).
async fn receive(inner: Weak<Inner>, pc: Id, receiver: Id, track: Arc<dyn TrackRemote>) {
    let kind = if track.kind().await == RtpCodecKind::Video { Kind::Video } else { Kind::Audio };
    let stream_ids: Vec<String> =
        Some(track.stream_id().await).into_iter().filter(|s| !s.is_empty() && s != "-").collect();
    let track_id = track.track_id().await;
    let Some(sink) = inner.upgrade().map(|i| i.sink.clone()) else { return };
    tracing::info!("conexão {pc}: trilha {kind:?} recebida (recepção {receiver}, streams {stream_ids:?})");
    sink.control(Control::Track { pc, receiver, kind, track_id, stream_ids });

    match kind {
        Kind::Audio => {
            let Ok(mut dec) = audio::Decoder::new() else { return };
            let mut last_seq: Option<u16> = None;
            while let Some(event) = track.poll().await {
                match event {
                    TrackRemoteEvent::OnRtpPacket(p) => {
                        let seq = p.header.sequence_number;
                        if let Some(prev) = last_seq {
                            let gap = seq.wrapping_sub(prev);
                            // Repetido ou atrasado demais: o lugar dele já foi tocado.
                            if gap == 0 || gap > 0x8000 {
                                continue;
                            }
                            // Até 3 pacotes perdidos viram áudio inventado pelo Opus; mais que isso, silêncio.
                            for _ in 1..gap.min(4) {
                                if let Some(pcm) = dec.conceal() {
                                    sink.media(Media::Audio { receiver, pcm });
                                }
                            }
                        }
                        last_seq = Some(seq);
                        if p.payload.is_empty() {
                            continue;
                        }
                        if let Some(pcm) = dec.decode(&p.payload) {
                            sink.media(Media::Audio { receiver, pcm });
                        }
                    }
                    TrackRemoteEvent::OnEnded => break,
                    _ => {}
                }
            }
        }
        Kind::Video => {
            // Até ~meio segundo de pacotes fora de ordem antes de desistir de um quadro.
            let mut builder =
                SampleBuilder::new(512, Vp8Packet::default(), 90000).with_max_time_delay(Duration::from_millis(500));
            send_pli(&*track).await;
            let mut last_pli = Instant::now();
            while let Some(event) = track.poll().await {
                match event {
                    TrackRemoteEvent::OnRtpPacket(p) => {
                        let now = Instant::now();
                        builder.push(now, p);
                        while let Some(sample) = builder.pop(now) {
                            // Quadro perdido no meio: o decodificador vai precisar de um quadro-chave.
                            if sample.prev_dropped_packets > 0 && last_pli.elapsed() > Duration::from_millis(500) {
                                send_pli(&*track).await;
                                last_pli = Instant::now();
                            }
                            if sample.data.is_empty() {
                                continue;
                            }
                            // No VP8, o bit 0 do primeiro byte zerado marca o quadro-chave.
                            let keyframe = sample.data[0] & 0x01 == 0;
                            sink.media(Media::Video {
                                receiver,
                                keyframe,
                                timestamp: sample.packet_timestamp,
                                data: sample.data,
                            });
                        }
                    }
                    TrackRemoteEvent::OnEnded => break,
                    _ => {}
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Nada;
    impl Sink for Nada {
        fn control(&self, _: Control) {}
        fn media(&self, _: Media) {}
    }

    /// A lista que o servidor do Line manda em /voice/ice (STUN público + coturn por UDP e TCP)
    /// precisa ser aceita como está: se o webrtc-rs recusasse, a chamada perderia o TURN.
    #[tokio::test]
    async fn aceita_o_ice_do_servidor() {
        let engine = Engine::new(Arc::new(Nada));
        let servers = vec![
            RTCIceServer {
                urls: vec!["stun:stun.l.google.com:19302".into(), "stun:stun1.l.google.com:19302".into()],
                ..Default::default()
            },
            RTCIceServer {
                urls: vec!["turn:useline.tech:3478".into(), "turn:useline.tech:3478?transport=tcp".into()],
                username: "1794700000:usuario".into(),
                credential: "c2VncmVkbw==".into(),
            },
        ];
        let conn = engine.build(1, servers).await.expect("ICE do servidor recusado");
        let _ = conn.close().await;
    }
}
