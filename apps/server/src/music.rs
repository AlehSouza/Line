//! Bot de música ("ouvir junto"). O servidor NÃO baixa nem retransmite áudio: ele guarda a fila
//! e o estado de cada canal de voz (faixa atual, posição, pausado) e cada app toca o player
//! oficial do YouTube em sincronia. Fica só em memória, como a voz.
//!
//! Travas: banco (`store.q()`) → voz → música, sempre nessa ordem.
use crate::model::PublicUser;
use crate::perms::{self, has};
use crate::store::{Q, lock};
use crate::App;
use regex::Regex;
use serde::Serialize;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, LazyLock};
use std::time::Duration;

const MAX_TRACKS: usize = 200;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub uid: String,
    pub video_id: String,
    pub title: String,
    pub author: String,
    /// Segundos (None quando o YouTube não informou; o app manda depois).
    pub duration: Option<u64>,
    pub added_by: String,
}

pub struct Session {
    pub server_id: String,
    pub channel_id: String,
    /// Canal de texto onde o bot anuncia (o do último /play).
    pub text_channel_id: String,
    /// Quem começou a tocar: pode tudo sem votação.
    pub dj_id: String,
    pub tracks: Vec<Track>,
    pub index: usize,
    pub paused: bool,
    offset_ms: u64,
    started_at_ms: u64,
    generation: u64,
    votes: HashMap<&'static str, HashSet<String>>,
}

impl Session {
    fn position_ms(&self, now: u64) -> u64 {
        if self.paused { self.offset_ms } else { self.offset_ms + now.saturating_sub(self.started_at_ms) }
    }
    fn current(&self) -> Option<&Track> {
        self.tracks.get(self.index)
    }
    fn restart(&mut self) {
        self.offset_ms = 0;
        self.started_at_ms = now_ms();
        self.paused = false;
        self.votes.clear();
        self.generation += 1;
    }
}

#[derive(Default)]
pub struct MusicRegistry {
    sessions: HashMap<String, Session>,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn uid() -> String {
    crate::ids::new_id()
}

/// Mudança pedida na sessão.
pub enum Op {
    Next,
    Prev,
    TogglePause,
    Jump(usize),
    Remove(String),
    Move(String, usize),
    Stop,
    /// O tempo da faixa acabou (vale só se a geração ainda for a mesma).
    Timer(u64),
    Ended(String),
    Failed(String),
    Duration(String, u64),
}

/// Pessoas (não bots) no canal de voz.
fn listeners(app: &App, channel_id: &str) -> Vec<String> {
    lock(&app.voice).in_channel(channel_id).into_iter().map(|v| v.user_id).collect()
}

fn state_json(s: &Session, listeners: usize) -> Value {
    let votes: serde_json::Map<String, Value> = s
        .votes
        .iter()
        .map(|(k, v)| (k.to_string(), json!(v.iter().collect::<Vec<_>>())))
        .collect();
    json!({
        "serverId": s.server_id,
        "channelId": s.channel_id,
        "textChannelId": s.text_channel_id,
        "djId": s.dj_id,
        "tracks": s.tracks,
        "index": s.index,
        "paused": s.paused,
        "positionMs": s.position_ms(now_ms()),
        "votes": votes,
        "listeners": listeners,
        "needed": listeners / 2 + 1,
    })
}

impl App {
    fn emit_music(&self, q: &Q, channel_id: &str) {
        let n = listeners(self, channel_id).len();
        let state = lock(&self.music).sessions.get(channel_id).map(|s| state_json(s, n));
        self.to_channel(q, channel_id, "music:state", &json!({ "channelId": channel_id, "state": state }));
    }

    /// Sessões que o usuário enxerga (ao conectar / sincronizar).
    pub fn music_snapshot(&self, q: &Q, user_id: &str) -> Vec<Value> {
        let ids: Vec<String> = lock(&self.music).sessions.keys().cloned().collect();
        ids.into_iter()
            .filter(|c| q.can_access(user_id, c))
            .filter_map(|c| {
                let n = listeners(self, &c).len();
                lock(&self.music).sessions.get(&c).map(|s| state_json(s, n))
            })
            .collect()
    }

    /// Alguém saiu da voz: se não sobrou ninguém ouvindo, o bot sai junto.
    pub fn music_on_voice_left(&self, q: &Q, channel_id: &str) {
        if !listeners(self, channel_id).is_empty() {
            return;
        }
        if lock(&self.music).sessions.remove(channel_id).is_some() {
            self.emit_music(q, channel_id);
        } else {
            return;
        }
    }

    /// Bot do servidor; avisa a lista de membros se ele acabou de entrar.
    pub fn music_bot(&self, q: &Q, server_id: &str) -> Option<PublicUser> {
        let (id, joined) = q.music_bot(server_id);
        if joined {
            if let Some(m) = q.member(server_id, &id) {
                self.to_server(server_id, "member:add", &m);
            }
        }
        q.public_user(&id)
    }

    fn bot_say(&self, q: &Q, server_id: &str, text_channel_id: &str, content: &str, requires: &[String]) {
        if q.channel(text_channel_id).is_none() {
            return;
        }
        let Some(bot) = self.music_bot(q, server_id) else { return };
        let message = q.create_message(text_channel_id, &bot.id, content, &[], requires);
        self.to_channel(q, text_channel_id, "message:create", &message);
    }

    /// Anuncia a faixa atual no chat: `[[musica:<voz>:<uid>:<vídeo>:<segundos>:<quem>]] título\nartista`.
    fn announce(&self, q: &Q, channel_id: &str) {
        let info = {
            let m = lock(&self.music);
            m.sessions.get(channel_id).and_then(|s| {
                let t = s.current()?;
                Some((s.server_id.clone(), s.text_channel_id.clone(), t.clone()))
            })
        };
        let Some((server_id, text, t)) = info else { return };
        let title = t.title.replace('\n', " ");
        let author = t.author.replace('\n', " ");
        let content = format!(
            "[[musica:{}:{}:{}:{}:{}]] {}\n{}",
            channel_id,
            t.uid,
            t.video_id,
            t.duration.unwrap_or(0),
            t.added_by,
            title,
            author
        );
        self.bot_say(q, &server_id, &text, &content, &["music".to_string()]);
    }
}

/// Agenda o fim da faixa atual (se a duração for conhecida e não estiver pausada).
fn schedule(app: &Arc<App>, channel_id: &str) {
    let plan = {
        let m = lock(&app.music);
        m.sessions.get(channel_id).and_then(|s| {
            let d = s.current()?.duration? * 1000;
            (!s.paused).then(|| (s.generation, d.saturating_sub(s.position_ms(now_ms()))))
        })
    };
    let Some((generation, remaining)) = plan else { return };
    let app = app.clone();
    let channel_id = channel_id.to_string();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(remaining + 1500)).await;
        let q = app.store.q();
        apply(&app, &q, &channel_id, Op::Timer(generation));
    });
}

/// Aplica a mudança, avisa todo mundo e anuncia a faixa nova. Devolve false se não mudou nada.
pub fn apply(app: &Arc<App>, q: &Q, channel_id: &str, op: Op) -> bool {
    enum Out {
        Nothing,
        Same,
        NewTrack,
        Ended,
    }
    let out = {
        let mut m = lock(&app.music);
        let Some(s) = m.sessions.get_mut(channel_id) else { return false };
        let now = now_ms();
        let next = |s: &mut Session| {
            if s.index + 1 < s.tracks.len() {
                s.index += 1;
                s.restart();
                Out::NewTrack
            } else {
                Out::Ended
            }
        };
        let current_uid = s.current().map(|t| t.uid.clone()).unwrap_or_default();
        let out = match op {
            Op::Next => next(s),
            Op::Timer(g) => {
                if g == s.generation { next(s) } else { Out::Nothing }
            }
            Op::Ended(u) => {
                let dur = s.current().and_then(|t| t.duration);
                let near_end = dur.is_none_or(|d| s.position_ms(now) + 8000 >= d * 1000);
                if u == current_uid && near_end { next(s) } else { Out::Nothing }
            }
            Op::Failed(u) => {
                if u == current_uid { next(s) } else { Out::Nothing }
            }
            Op::Prev => {
                if s.position_ms(now) > 5000 || s.index == 0 {
                    s.restart();
                    Out::Same
                } else {
                    s.index -= 1;
                    s.restart();
                    Out::NewTrack
                }
            }
            Op::TogglePause => {
                if s.paused {
                    s.started_at_ms = now;
                    s.paused = false;
                } else {
                    s.offset_ms = s.position_ms(now);
                    s.paused = true;
                }
                s.votes.remove("pause");
                s.generation += 1;
                Out::Same
            }
            Op::Jump(i) => {
                if i < s.tracks.len() {
                    s.index = i;
                    s.restart();
                    Out::NewTrack
                } else {
                    Out::Nothing
                }
            }
            Op::Remove(u) => match s.tracks.iter().position(|t| t.uid == u) {
                None => Out::Nothing,
                Some(j) if j == s.index => {
                    s.tracks.remove(j);
                    if s.index < s.tracks.len() {
                        s.restart();
                        Out::NewTrack
                    } else {
                        Out::Ended
                    }
                }
                Some(j) => {
                    s.tracks.remove(j);
                    if j < s.index {
                        s.index -= 1;
                    }
                    Out::Same
                }
            },
            Op::Move(u, to) => match s.tracks.iter().position(|t| t.uid == u) {
                // Só reordena o que ainda vai tocar.
                Some(j) if j > s.index && to > s.index && to < s.tracks.len() && to != j => {
                    let t = s.tracks.remove(j);
                    s.tracks.insert(to, t);
                    Out::Same
                }
                _ => Out::Nothing,
            },
            Op::Stop => Out::Ended,
            Op::Duration(u, secs) => {
                let idx = s.index;
                match s.tracks.get_mut(idx) {
                    Some(t) if t.uid == u && t.duration.is_none() && secs > 0 && secs < 24 * 3600 => {
                        t.duration = Some(secs);
                        s.generation += 1;
                        Out::Same
                    }
                    _ => Out::Nothing,
                }
            }
        };
        if matches!(out, Out::Ended) {
            m.sessions.remove(channel_id);
        }
        out
    };
    match out {
        Out::Nothing => return false,
        Out::Ended => app.emit_music(q, channel_id),
        Out::Same => {
            app.emit_music(q, channel_id);
            schedule(app, channel_id);
        }
        Out::NewTrack => {
            app.emit_music(q, channel_id);
            app.announce(q, channel_id);
            schedule(app, channel_id);
        }
    }
    true
}

fn is_dj(app: &App, q: &Q, channel_id: &str, user_id: &str) -> bool {
    let (dj, server) = {
        let m = lock(&app.music);
        let Some(s) = m.sessions.get(channel_id) else { return false };
        (s.dj_id.clone(), s.server_id.clone())
    };
    dj == user_id || has(q.permissions(&server, user_id), perms::MANAGE_SERVER)
}

/// Controle vindo do app (`music:control`). Quem deu o /play (ou gerencia o servidor) manda direto;
/// os outros que estão ouvindo votam em pular / voltar / pausar e vale a maioria.
pub fn control(app: &Arc<App>, me: &str, d: &Value) {
    let Some(channel_id) = d.get("channelId").and_then(|c| c.as_str()) else { return };
    let action = d.get("action").and_then(|c| c.as_str()).unwrap_or("");
    let q = app.store.q();
    if !q.can_access(me, channel_id) || !lock(&app.music).sessions.contains_key(channel_id) {
        return;
    }
    let dj = is_dj(app, &q, channel_id, me);
    let people = listeners(app, channel_id);
    let listening = people.iter().any(|u| u == me);
    let uid_arg = || d.get("uid").and_then(|u| u.as_str()).unwrap_or("").to_string();
    let vote_kind: Option<&'static str> = match action {
        "skip" => Some("skip"),
        "prev" => Some("prev"),
        "pause" => Some("pause"),
        _ => None,
    };
    if let Some(kind) = vote_kind {
        let op = || match kind {
            "skip" => Op::Next,
            "prev" => Op::Prev,
            _ => Op::TogglePause,
        };
        if dj {
            apply(app, &q, channel_id, op());
            return;
        }
        if !listening {
            return;
        }
        let passed = {
            let mut m = lock(&app.music);
            let Some(s) = m.sessions.get_mut(channel_id) else { return };
            let set = s.votes.entry(kind).or_default();
            if !set.remove(me) {
                set.insert(me.to_string());
            }
            let valid = set.iter().filter(|u| people.contains(u)).count();
            valid * 2 > people.len()
        };
        if passed {
            apply(app, &q, channel_id, op());
        } else {
            app.emit_music(&q, channel_id);
        }
        return;
    }
    match action {
        "jump" if dj => {
            if let Some(i) = d.get("index").and_then(|v| v.as_u64()) {
                apply(app, &q, channel_id, Op::Jump(i as usize));
            }
        }
        "move" if dj => {
            if let Some(to) = d.get("to").and_then(|v| v.as_u64()) {
                apply(app, &q, channel_id, Op::Move(uid_arg(), to as usize));
            }
        }
        "remove" => {
            let u = uid_arg();
            let own = lock(&app.music)
                .sessions
                .get(channel_id)
                .is_some_and(|s| s.tracks.iter().any(|t| t.uid == u && t.added_by == me));
            if dj || own {
                apply(app, &q, channel_id, Op::Remove(u));
            }
        }
        "stop" if dj => {
            apply(app, &q, channel_id, Op::Stop);
        }
        _ => {}
    }
}

/// O player de quem está ouvindo avisa: a faixa acabou, deu erro ou qual a duração.
pub fn report(app: &Arc<App>, me: &str, d: &Value) {
    let (Some(channel_id), Some(kind)) = (
        d.get("channelId").and_then(|c| c.as_str()),
        d.get("kind").and_then(|c| c.as_str()),
    ) else {
        return;
    };
    let u = d.get("uid").and_then(|c| c.as_str()).unwrap_or("").to_string();
    let q = app.store.q();
    if !listeners(app, channel_id).iter().any(|x| x == me) {
        return;
    }
    let op = match kind {
        "ended" => Op::Ended(u),
        "error" => Op::Failed(u),
        "duration" => match d.get("duration").and_then(|v| v.as_f64()) {
            Some(secs) if secs.is_finite() && secs > 0.0 => Op::Duration(u, secs.round() as u64),
            _ => return,
        },
        _ => return,
    };
    apply(app, &q, channel_id, op);
}

/// Título, canal e duração do vídeo (oEmbed oficial + página do vídeo para a duração).
pub async fn fetch_meta(video_id: &str) -> Option<(String, String, Option<u64>)> {
    static LEN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#""lengthSeconds":"(\d+)""#).unwrap());
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36")
        .timeout(Duration::from_secs(8))
        .build()
        .ok()?;
    let watch = format!("https://www.youtube.com/watch?v={video_id}");
    let oembed = client
        .get("https://www.youtube.com/oembed")
        .query(&[("url", watch.as_str()), ("format", "json")])
        .send()
        .await
        .ok()?;
    if !oembed.status().is_success() {
        return None;
    }
    let v: Value = oembed.json().await.ok()?;
    let title = v["title"].as_str()?.to_string();
    let author = v["author_name"].as_str().unwrap_or("").to_string();
    let duration = match client.get(&watch).header("Accept-Language", "pt-BR,pt;q=0.9").send().await {
        Ok(r) => r
            .text()
            .await
            .ok()
            .and_then(|html| LEN.captures(&html).and_then(|c| c[1].parse::<u64>().ok()))
            .filter(|d| *d > 0),
        Err(_) => None,
    };
    Some((title, author, duration))
}

/// `/play <nome>`: primeiro vídeo da busca do YouTube (página pública de resultados, sem chave de API).
pub async fn search(query: &str) -> Option<String> {
    static FIRST: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#""videoRenderer":\{"videoId":"([\w-]{11})""#).unwrap());
    let client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36")
        .timeout(Duration::from_secs(8))
        .build()
        .ok()?;
    let html = client
        .get("https://www.youtube.com/results")
        // sp=EgIQAQ%3D%3D: só vídeos (sem canais, playlists ou shorts misturados).
        .query(&[("search_query", query), ("sp", "EgIQAQ==")])
        .header("Accept-Language", "pt-BR,pt;q=0.9")
        .header("Cookie", "CONSENT=YES+1; SOCS=CAI")
        .send()
        .await
        .ok()?
        .text()
        .await
        .ok()?;
    static ANY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"/watch\?v=([\w-]{11})"#).unwrap());
    FIRST.captures(&html).or_else(|| ANY.captures(&html)).map(|c| c[1].to_string())
}

/// `/play <link>`: põe na fila do canal de voz em que a pessoa está (cria a sessão se preciso).
pub async fn play(app: &Arc<App>, me: &str, text_channel_id: &str, video_id: String) -> Result<(), String> {
    let (title, author, duration) = fetch_meta(&video_id)
        .await
        .ok_or("Não consegui abrir esse vídeo. Ele pode ser privado ou não permitir reprodução fora do YouTube.")?;
    let q = app.store.q();
    let text = q.channel(text_channel_id).ok_or("Canal não encontrado")?;
    let server_id = text.server_id.clone().ok_or("O bot de música só funciona em servidores")?;
    let voice = lock(&app.voice).get(me).map(|v| v.state.clone());
    let Some(voice) = voice.filter(|v| v.server_id.as_deref() == Some(server_id.as_str())) else {
        return Err("Entre em um canal de voz deste servidor para usar o /play".into());
    };
    app.music_bot(&q, &server_id);
    let added_by_name = q
        .member(&server_id, me)
        .map(|m| m.nickname.unwrap_or(m.user.display_name))
        .unwrap_or_default();
    let track = Track { uid: uid(), video_id, title: title.clone(), author, duration, added_by: me.to_string() };
    let queued_at = {
        let mut m = lock(&app.music);
        match m.sessions.get_mut(&voice.channel_id) {
            Some(s) => {
                if s.tracks.len() >= MAX_TRACKS {
                    return Err("A fila já está cheia".into());
                }
                s.text_channel_id = text.id.clone();
                s.tracks.push(track);
                Some(s.tracks.len() - s.index - 1)
            }
            None => {
                let mut s = Session {
                    server_id: server_id.clone(),
                    channel_id: voice.channel_id.clone(),
                    text_channel_id: text.id.clone(),
                    dj_id: me.to_string(),
                    tracks: vec![track],
                    index: 0,
                    paused: false,
                    offset_ms: 0,
                    started_at_ms: 0,
                    generation: 0,
                    votes: HashMap::new(),
                };
                s.restart();
                m.sessions.insert(voice.channel_id.clone(), s);
                None
            }
        }
    };
    match queued_at {
        None => {
            app.emit_music(&q, &voice.channel_id);
            app.announce(&q, &voice.channel_id);
            schedule(app, &voice.channel_id);
        }
        Some(pos) => {
            app.emit_music(&q, &voice.channel_id);
            let msg = format!("**{added_by_name}** adicionou **{}** à fila (posição {pos}).", title.replace('*', ""));
            app.bot_say(&q, &server_id, &text.id, &msg, &[]);
        }
    }
    Ok(())
}
