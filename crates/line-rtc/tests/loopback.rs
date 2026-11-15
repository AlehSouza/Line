//! Duas instâncias do motor conversando pela rede local, com a mesma sinalização que a página
//! faz (negociação perfeita): áudio Opus, depois vídeo VP8 numa renegociação, e ofertas cruzadas.

use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use line_rtc::{Control, Engine, Kind, Media, Sink};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};

enum Ev {
    Control(Control),
    Media(Media),
}

struct ChanSink(UnboundedSender<Ev>);

impl Sink for ChanSink {
    fn control(&self, event: Control) {
        let _ = self.0.send(Ev::Control(event));
    }
    fn media(&self, media: Media) {
        let _ = self.0.send(Ev::Media(media));
    }
}

struct Side {
    engine: Arc<Engine>,
    polite: bool,
}

const PC: u32 = 1;

/// Faz o papel do `voice.ts`: repassa ofertas, respostas e candidatos entre os dois lados.
async fn signaling(a: Arc<Side>, b: Arc<Side>, rx: UnboundedReceiver<Ev>, out: UnboundedSender<Ev>) {
    let mut rx = rx;
    while let Some(ev) = rx.recv().await {
        match ev {
            Ev::Control(Control::NegotiationNeeded { .. }) => {
                let (a, b) = (a.clone(), b.clone());
                tokio::spawn(async move {
                    let Ok(snap) = a.engine.set_local(PC, None).await else { return };
                    if let Some(desc) = snap.local_description {
                        deliver(&b, &a, desc).await;
                    }
                });
            }
            Ev::Control(Control::IceCandidate { candidate, .. }) => {
                let _ = b.engine.add_ice_candidate(PC, candidate).await;
            }
            other => {
                let _ = out.send(other);
            }
        }
    }
}

/// Entrega uma descrição em `to` (vinda de `from`) e devolve a resposta, se for oferta.
async fn deliver(to: &Arc<Side>, from: &Arc<Side>, desc: line_rtc::SessionDescription) {
    let offer = format!("{:?}", desc.sdp_type).to_lowercase() == "offer";
    let snap = to.engine.snapshot(PC).await.unwrap();
    // Lado "mal-educado" ignora oferta que colide com a dele.
    if offer && snap.signaling_state != "stable" && !to.polite {
        return;
    }
    if to.engine.set_remote(PC, desc).await.is_err() {
        return;
    }
    if offer {
        let snap = to.engine.set_local(PC, None).await.unwrap();
        let answer = snap.local_description.unwrap();
        let _ = from.engine.set_remote(PC, answer).await;
    }
}

fn side(polite: bool) -> (Arc<Side>, UnboundedReceiver<Ev>) {
    let (tx, rx) = unbounded_channel();
    (Arc::new(Side { engine: Arc::new(Engine::new(Arc::new(ChanSink(tx)))), polite }), rx)
}

fn sine(frame: usize) -> Vec<i16> {
    (0..960)
        .map(|i| {
            let t = (frame * 960 + i) as f64 / 48000.0;
            ((t * 440.0 * std::f64::consts::TAU).sin() * 9000.0) as i16
        })
        .collect()
}

async fn wait_for<T>(rx: &mut UnboundedReceiver<Ev>, secs: u64, mut pick: impl FnMut(Ev) -> Option<T>) -> T {
    tokio::time::timeout(Duration::from_secs(secs), async {
        loop {
            let ev = rx.recv().await.expect("canal fechou");
            if let Some(t) = pick(ev) {
                return t;
            }
        }
    })
    .await
    .expect("demorou demais")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn audio_depois_video_por_renegociacao() {
    let (a, a_rx) = side(false);
    let (b, b_rx) = side(true);
    let ice = || vec![];
    a.engine.create_pc(PC, ice()).await.unwrap();
    b.engine.create_pc(PC, ice()).await.unwrap();

    let (a_out, mut a_events) = unbounded_channel();
    let (b_out, mut b_events) = unbounded_channel();
    tokio::spawn(signaling(a.clone(), b.clone(), a_rx, a_out));
    tokio::spawn(signaling(b.clone(), a.clone(), b_rx, b_out));

    // A manda o microfone.
    a.engine.add_source(10, Kind::Audio).unwrap();
    a.engine.add_track(PC, 1, Kind::Audio, "mic".into(), vec!["stream-mic".into()], None).await.unwrap();
    a.engine.bind(PC, 1, Some(10));

    let track = wait_for(&mut b_events, 20, |ev| match ev {
        Ev::Control(Control::Track { kind: Kind::Audio, stream_ids, receiver, .. }) => Some((stream_ids, receiver)),
        _ => None,
    });
    // O primeiro pacote é que abre a trilha: manda áudio enquanto espera.
    let pusher = {
        let a = a.clone();
        tokio::spawn(async move {
            for f in 0..400 {
                a.engine.push_audio(10, &sine(f)).await;
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
    };
    let (stream_ids, receiver) = track.await;
    assert_eq!(stream_ids, vec!["stream-mic".to_string()]);
    eprintln!("passo: trilha de audio");

    // Áudio chegando decodificado, com energia (não é silêncio).
    let pcm = wait_for(&mut b_events, 10, |ev| match ev {
        Ev::Media(Media::Audio { receiver: r, pcm }) if r == receiver && pcm.iter().any(|&s| s.abs() > 1000) => Some(pcm),
        _ => None,
    })
    .await;
    assert_eq!(pcm.len(), 960);
    eprintln!("passo: audio chegou");

    // Liga a câmera: renegocia e o vídeo chega inteiro do outro lado.
    a.engine.add_source(20, Kind::Video).unwrap();
    a.engine
        .add_track(PC, 2, Kind::Video, "cam".into(), vec!["stream-cam".into()], Some("sendonly".into()))
        .await
        .unwrap();
    a.engine.bind(PC, 2, Some(20));
    // Pedido de quadro-chave da fonte nova.
    wait_for(&mut a_events, 5, |ev| match ev {
        Ev::Control(Control::Keyframe { source: 20 }) => Some(()),
        _ => None,
    })
    .await;
    eprintln!("passo: pedido de keyframe");

    let frame: Vec<u8> = std::iter::once(0x10u8).chain((0..3000u32).map(|i| (i % 251) as u8)).collect();
    let video_pusher = {
        let a = a.clone();
        let frame = Bytes::from(frame.clone());
        tokio::spawn(async move {
            for _ in 0..300 {
                a.engine.push_video(20, Duration::from_millis(33), frame.clone()).await;
                tokio::time::sleep(Duration::from_millis(33)).await;
            }
        })
    };
    let video_receiver = wait_for(&mut b_events, 20, |ev| match ev {
        Ev::Control(Control::Track { kind: Kind::Video, stream_ids, receiver, .. }) => {
            assert_eq!(stream_ids, vec!["stream-cam".to_string()]);
            Some(receiver)
        }
        _ => None,
    })
    .await;
    eprintln!("passo: trilha de video");
    let (keyframe, data) = wait_for(&mut b_events, 10, |ev| match ev {
        Ev::Media(Media::Video { receiver, keyframe, data, .. }) if receiver == video_receiver => Some((keyframe, data)),
        _ => None,
    })
    .await;
    assert!(keyframe);
    assert_eq!(&data[..], &frame[..]);
    eprintln!("passo: video chegou");

    // Desliga a câmera: a trilha de vídeo acaba do outro lado.
    a.engine.remove_track(PC, 2).await.unwrap();
    wait_for(&mut b_events, 15, |ev| match ev {
        Ev::Control(Control::TrackEnded { receiver, .. }) if receiver == video_receiver => Some(()),
        _ => None,
    })
    .await;

    pusher.abort();
    video_pusher.abort();
    a.engine.close_pc(PC).await;
    b.engine.close_pc(PC).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn ofertas_cruzadas_se_resolvem() {
    // Os dois lados ligam o microfone ao mesmo tempo: as ofertas colidem e o lado educado desfaz a dele.
    let (a, a_rx) = side(false);
    let (b, b_rx) = side(true);
    a.engine.create_pc(PC, vec![]).await.unwrap();
    b.engine.create_pc(PC, vec![]).await.unwrap();
    let (a_out, mut a_events) = unbounded_channel();
    let (b_out, mut b_events) = unbounded_channel();
    tokio::spawn(signaling(a.clone(), b.clone(), a_rx, a_out));
    tokio::spawn(signaling(b.clone(), a.clone(), b_rx, b_out));

    for (s, src) in [(&a, 10), (&b, 11)] {
        s.engine.add_source(src, Kind::Audio).unwrap();
        s.engine.add_track(PC, 1, Kind::Audio, format!("mic{src}"), vec![format!("s{src}")], None).await.unwrap();
        s.engine.bind(PC, 1, Some(src));
    }
    let pusher = {
        let (a, b) = (a.clone(), b.clone());
        tokio::spawn(async move {
            for f in 0..600 {
                a.engine.push_audio(10, &sine(f)).await;
                b.engine.push_audio(11, &sine(f)).await;
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
    };
    async fn heard(rx: &mut UnboundedReceiver<Ev>) {
        wait_for(rx, 25, |ev| match ev {
            Ev::Media(Media::Audio { pcm, .. }) if pcm.iter().any(|&s| s.abs() > 1000) => Some(()),
            _ => None,
        })
        .await
    }
    heard(&mut a_events).await;
    heard(&mut b_events).await;
    pusher.abort();
}
