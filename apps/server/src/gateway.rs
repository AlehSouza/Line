//! Gateway em tempo real (Socket.IO sobre WebSocket), compatível com o `socket.io-client` do app.
//! Salas: `user:<id>` (todas as conexões de um usuário) e `server:<id>` (membros de um servidor).
//! Mensagens de DM vão direto para as salas dos participantes.
//!
//! Regra de travas: pegue o banco (`store.q()`) antes do registro de voz e nunca o contrário.
use crate::model::Server;
use crate::perms::{self, has};
use crate::store::{Q, lock};
use crate::voice::VoicePatch;
use crate::{App, AppRef};
use futures_util::FutureExt;
use serde::Serialize;
use serde_json::{Value, json};
use socketioxide::extract::{AckSender, Data, Extension, SocketRef, State, TryData};
use socketioxide::handler::ConnectHandler;
use socketioxide::socket::Sid;
use std::future::Future;

pub fn user_room(id: &str) -> String {
    format!("user:{id}")
}
pub fn server_room(id: &str) -> String {
    format!("server:{id}")
}

#[derive(Clone)]
struct UserId(String);

/// O adaptador local do socketioxide resolve tudo na hora; isso mantém a ordem dos eventos.
fn now<F: Future>(f: F) {
    if f.now_or_never().is_none() {
        tracing::warn!("operação de socket ficou pendente");
    }
}

#[derive(Default)]
pub struct VoiceFilter<'a> {
    pub channel_id: Option<&'a str>,
    pub server_id: Option<&'a str>,
    pub user_id: Option<&'a str>,
}

impl App {
    /// Emite um evento para salas; lista vazia não emite nada (senão iria para todos).
    fn emit_rooms<T: Serialize + ?Sized>(&self, rooms: Vec<String>, event: &str, data: &T) {
        if rooms.is_empty() {
            return;
        }
        now(self.io.to(rooms).emit(event, data));
    }

    pub fn to_users<T: Serialize + ?Sized>(&self, user_ids: &[String], event: &str, data: &T) {
        self.emit_rooms(user_ids.iter().map(|u| user_room(u)).collect(), event, data);
    }

    pub fn to_user<T: Serialize + ?Sized>(&self, user_id: &str, event: &str, data: &T) {
        self.emit_rooms(vec![user_room(user_id)], event, data);
    }

    pub fn to_server<T: Serialize + ?Sized>(&self, server_id: &str, event: &str, data: &T) {
        self.emit_rooms(vec![server_room(server_id)], event, data);
    }

    fn to_socket<T: Serialize + ?Sized>(&self, sid: Sid, event: &str, data: &T) {
        if let Some(s) = self.io.get_socket(sid) {
            let _ = s.emit(event, data);
        }
    }

    /// Emite para quem enxerga o canal (membros do servidor ou participantes da DM).
    pub fn to_channel<T: Serialize + ?Sized>(
        &self,
        q: &Q,
        channel_id: &str,
        event: &str,
        data: &T,
    ) {
        let Some(channel) = q.channel(channel_id) else {
            return;
        };
        match &channel.server_id {
            Some(server_id) => match q.private_audience(&channel.id) {
                Some(ids) => self.to_users(&ids, event, data),
                None => self.to_server(server_id, event, data),
            },
            None => self.to_users(&q.recipient_ids(&channel.id), event, data),
        }
    }

    /// Manda o servidor atualizado; só quem pode criar convite recebe o código.
    pub fn server_updated(&self, q: &Q, server: &Server) {
        let (with, without): (Vec<String>, Vec<String>) = q
            .member_ids(&server.id)
            .into_iter()
            .partition(|u| has(q.permissions(&server.id, u), perms::CREATE_INVITE));
        self.to_users(&with, "server:update", server);
        let hidden = Server { invite_code: String::new(), ..server.clone() };
        self.to_users(&without, "server:update", &hidden);
    }

    pub fn broadcast_presence(&self, q: &Q, user_id: &str) {
        let Some(user) = q.public_user(user_id) else {
            return;
        };
        let payload = json!({ "userId": user_id, "presence": user.presence, "customStatus": user.custom_status });
        // Inclui o próprio usuário para sincronizar outras janelas/dispositivos.
        let mut audience = vec![user_id.to_string()];
        audience.extend(q.audience_of(user_id));
        self.to_users(&audience, "presence:update", &payload);
    }

    pub fn join_server(&self, user_id: &str, server_id: &str) {
        now(self.io.to(user_room(user_id)).join(server_room(server_id)));
    }

    pub fn leave_server(&self, user_id: &str, server_id: &str) {
        now(self.io.to(user_room(user_id)).leave(server_room(server_id)));
    }

    pub fn close_server_room(&self, server_id: &str) {
        now(self
            .io
            .to(server_room(server_id))
            .leave(server_room(server_id)));
    }

    // ---------- voz ----------

    pub fn leave_voice(&self, q: &Q, user_id: &str) {
        let left = lock(&self.voice).leave(user_id);
        if let Some((state, cleared)) = left {
            self.to_channel(
                q,
                &state.channel_id,
                "voice:update",
                &json!({ "userId": user_id, "channelId": state.channel_id, "state": null }),
            );
            if cleared {
                self.to_channel(
                    q,
                    &state.channel_id,
                    "voice:status",
                    &json!({ "channelId": state.channel_id, "status": null }),
                );
            }
        }
    }

    /// Tira da voz quem perdeu acesso (canal apagado, saiu/expulso do servidor, servidor apagado).
    pub fn drop_voice(&self, q: &Q, filter: VoiceFilter) {
        let all = lock(&self.voice).all();
        for v in all {
            let s = &v.state;
            if filter.channel_id.is_some_and(|c| c != s.channel_id)
                || filter
                    .server_id
                    .is_some_and(|id| Some(id) != s.server_id.as_deref())
                || filter.user_id.is_some_and(|u| u != s.user_id)
            {
                continue;
            }
            self.to_socket(v.sid, "voice:kicked", &json!({ "channelId": s.channel_id }));
            self.leave_voice(q, &s.user_id);
        }
    }
}

// ---------- conexão ----------

#[derive(Debug)]
struct Unauthorized;
impl std::fmt::Display for Unauthorized {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("unauthorized")
    }
}

async fn authenticate(
    s: SocketRef,
    State(app): State<AppRef>,
    TryData(auth): TryData<Value>,
) -> Result<(), Unauthorized> {
    let token = auth
        .ok()
        .and_then(|a| a.get("token").and_then(|t| t.as_str()).map(String::from));
    let user_id = token
        .and_then(|t| app.tokens.verify(&t))
        .ok_or(Unauthorized)?;
    if app.store.q().self_user(&user_id).is_none() {
        return Err(Unauthorized);
    }
    s.extensions.insert(UserId(user_id));
    Ok(())
}

pub fn register(io: &socketioxide::SocketIo) {
    io.ns("/", on_connect.with(authenticate));
}

async fn on_connect(
    s: SocketRef,
    State(app): State<AppRef>,
    Extension(UserId(user_id)): Extension<UserId>,
) {
    {
        let q = app.store.q();
        s.join(user_room(&user_id));
        for server_id in q.server_ids_of(&user_id) {
            s.join(server_room(&server_id));
        }
        let came_online = lock(&app.store.presence).connect(&user_id, s.id);
        if let Some(me) = q.self_user(&user_id) {
            let _ = s.emit("ready", &json!({ "user": me }));
        }
        if came_online {
            app.broadcast_presence(&q, &user_id);
        }
        let states: Vec<_> = lock(&app.voice)
            .all()
            .into_iter()
            .map(|v| v.state)
            .collect();
        let visible: Vec<_> = states
            .into_iter()
            .filter(|v| q.can_access(&user_id, &v.channel_id))
            .collect();
        let _ = s.emit("voice:snapshot", &visible);
        let statuses: serde_json::Map<String, Value> = lock(&app.voice)
            .statuses()
            .into_iter()
            .filter(|(c, _)| q.can_access(&user_id, c))
            .map(|(c, st)| (c, Value::String(st)))
            .collect();
        let _ = s.emit("voice:statuses", &statuses);
    }

    s.on("typing:start", typing_start);
    s.on("presence:activity", presence_activity);
    s.on("voice:join", voice_join);
    s.on("voice:leave", voice_leave);
    s.on("voice:state", voice_state);
    s.on("voice:signal", voice_signal);
    s.on("voice:status", voice_status);
    s.on("voice:moderate", voice_moderate);
    s.on_disconnect(on_disconnect);
}

async fn typing_start(
    s: SocketRef,
    State(app): State<AppRef>,
    Extension(UserId(me)): Extension<UserId>,
    TryData(d): TryData<Value>,
) {
    let Some(channel_id) = d.ok().and_then(|d| {
        d.get("channelId")
            .and_then(|c| c.as_str())
            .map(String::from)
    }) else {
        return;
    };
    let q = app.store.q();
    let Some(channel) = q.channel(&channel_id) else {
        return;
    };
    if !q.can_access(&me, &channel.id) {
        return;
    }
    let Some(user) = q.public_user(&me) else {
        return;
    };
    let payload =
        json!({ "channelId": channel_id, "userId": me, "displayName": user.display_name });
    let private = channel.server_id.as_ref().and_then(|_| q.private_audience(&channel.id));
    match (&channel.server_id, private) {
        (Some(_), Some(ids)) => {
            let others: Vec<String> = ids.into_iter().filter(|r| *r != me).collect();
            app.to_users(&others, "typing:start", &payload);
        }
        (Some(server_id), None) => now(s.to(server_room(server_id)).emit("typing:start", &payload)),
        (None, _) => {
            let others: Vec<String> = q
                .recipient_ids(&channel.id)
                .into_iter()
                .filter(|r| *r != me)
                .collect();
            app.to_users(&others, "typing:start", &payload);
        }
    }
}

async fn presence_activity(
    s: SocketRef,
    State(app): State<AppRef>,
    Extension(UserId(me)): Extension<UserId>,
    TryData(d): TryData<Value>,
) {
    let idle = d
        .ok()
        .and_then(|d| d.get("idle").map(|v| v.as_bool().unwrap_or(!v.is_null())))
        .unwrap_or(false);
    let q = app.store.q();
    let status = q.user_status(&me);
    let changed = {
        let mut p = lock(&app.store.presence);
        let before = p.resolve(&me, &status);
        p.set_idle(&me, s.id, idle);
        before != p.resolve(&me, &status)
    };
    if changed {
        app.broadcast_presence(&q, &me);
    }
}

async fn voice_join(
    s: SocketRef,
    State(app): State<AppRef>,
    Extension(UserId(me)): Extension<UserId>,
    TryData(d): TryData<Value>,
    ack: AckSender,
) {
    let d = d.unwrap_or(Value::Null);
    let q = app.store.q();
    let channel = d
        .get("channelId")
        .and_then(|c| c.as_str())
        .and_then(|id| q.channel(id));
    let Some(channel) = channel.filter(|c| q.can_access(&me, &c.id)) else {
        let _ = ack.send(&json!({ "ok": false, "error": "Canal não encontrado" }));
        return;
    };
    if !matches!(channel.kind.as_str(), "voice" | "dm" | "group_dm") {
        let _ = ack.send(&json!({ "ok": false, "error": "Esse canal é de texto" }));
        return;
    }
    let p = channel.server_id.as_deref().map(|sid| q.permissions(sid, &me)).unwrap_or(perms::ALL);
    if !has(p, perms::CONNECT) {
        let _ = ack.send(&json!({ "ok": false, "error": "Você não tem permissão para entrar neste canal de voz" }));
        return;
    }

    let current = lock(&app.voice).get(&me).cloned();
    if let Some(current) = current {
        if current.sid != s.id {
            app.to_socket(
                current.sid,
                "voice:kicked",
                &json!({ "channelId": current.state.channel_id }),
            );
        }
        app.leave_voice(&q, &me);
    }
    let truthy = |k: &str| {
        d.get(k).is_some_and(|v| {
            v.as_bool()
                .unwrap_or(!v.is_null() && v != &json!(0) && v != &json!(""))
        })
    };
    let state = lock(&app.voice).join(
        &me,
        s.id,
        &channel.id,
        channel.server_id.clone(),
        truthy("muted") || !has(p, perms::SPEAK),
        truthy("deafened"),
    );
    app.to_channel(
        &q,
        &channel.id,
        "voice:update",
        &json!({ "userId": me, "channelId": channel.id, "state": state }),
    );
    let peers: Vec<_> = lock(&app.voice)
        .in_channel(&channel.id)
        .into_iter()
        .filter(|v| v.user_id != me)
        .collect();
    let _ = ack.send(&json!({ "ok": true, "peers": peers }));
}

async fn voice_leave(
    s: SocketRef,
    State(app): State<AppRef>,
    Extension(UserId(me)): Extension<UserId>,
) {
    let q = app.store.q();
    let mine = lock(&app.voice).get(&me).is_some_and(|v| v.sid == s.id);
    if mine {
        app.leave_voice(&q, &me);
    }
}

async fn voice_state(
    s: SocketRef,
    State(app): State<AppRef>,
    Extension(UserId(me)): Extension<UserId>,
    TryData(d): TryData<Value>,
) {
    let Ok(patch) = d else { return };
    if !patch.is_object() {
        return;
    }
    let q = app.store.q();
    let server_id = lock(&app.voice).get(&me).and_then(|v| v.state.server_id.clone());
    let p = server_id.as_deref().map(|sid| q.permissions(sid, &me)).unwrap_or(perms::ALL);
    let mut patch = VoicePatch::from_json(&patch);
    // Sem "Falar" fica sempre mudo; sem "Vídeo" não liga câmera nem compartilha tela.
    if !has(p, perms::SPEAK) && patch.muted == Some(false) {
        patch.muted = None;
    }
    if !has(p, perms::VIDEO) {
        if matches!(patch.camera_stream_id, Some(Some(_))) {
            patch.camera_stream_id = None;
        }
        if matches!(patch.screen_stream_id, Some(Some(_))) {
            patch.screen_stream_id = None;
        }
    }
    let state = {
        let mut voice = lock(&app.voice);
        if voice.get(&me).is_none_or(|v| v.sid != s.id) {
            return;
        }
        voice.update(&me, patch)
    };
    if let Some(state) = state {
        app.to_channel(
            &q,
            &state.channel_id,
            "voice:update",
            &json!({ "userId": me, "channelId": state.channel_id, "state": state }),
        );
    }
}

async fn voice_status(
    State(app): State<AppRef>,
    Extension(UserId(me)): Extension<UserId>,
    TryData(d): TryData<Value>,
) {
    let Ok(d) = d else { return };
    let (Some(channel_id), Some(status)) = (
        d.get("channelId").and_then(|c| c.as_str()),
        d.get("status").and_then(|c| c.as_str()),
    ) else {
        return;
    };
    let q = app.store.q();
    let set = lock(&app.voice).set_status(&me, channel_id, status);
    if let Some(status) = set {
        app.to_channel(
            &q,
            channel_id,
            "voice:status",
            &json!({ "channelId": channel_id, "status": status }),
        );
    }
}

/// Silenciar pede "Silenciar membros"; mover e desconectar pedem "Mover membros".
fn can_moderate_voice(q: &Q, user_id: &str, server_id: &str, action: &str) -> bool {
    let flag = if matches!(action, "mute" | "deafen") { perms::MUTE_MEMBERS } else { perms::MOVE_MEMBERS };
    has(q.permissions(server_id, user_id), flag)
}

async fn voice_moderate(
    State(app): State<AppRef>,
    Extension(UserId(me)): Extension<UserId>,
    TryData(d): TryData<Value>,
) {
    let Ok(d) = d else { return };
    let (Some(target), Some(action)) = (
        d.get("userId").and_then(|c| c.as_str()),
        d.get("action").and_then(|c| c.as_str()),
    ) else {
        return;
    };
    let q = app.store.q();
    let Some(entry) = lock(&app.voice).get(target).cloned() else {
        return;
    };
    let Some(server_id) = entry.state.server_id.clone() else {
        return;
    };
    if !can_moderate_voice(&q, &me, &server_id, action) {
        return;
    }
    let value = d.get("value").and_then(|v| v.as_bool());
    match action {
        "mute" | "deafen" => {
            let flags = if action == "mute" { (value, None) } else { (None, value) };
            let state = lock(&app.voice).set_server_flags(target, flags.0, flags.1);
            if let Some(state) = state {
                app.to_channel(
                    &q,
                    &state.channel_id,
                    "voice:update",
                    &json!({ "userId": target, "channelId": state.channel_id, "state": state }),
                );
            }
        }
        "disconnect" => {
            app.to_socket(entry.sid, "voice:kicked", &json!({ "channelId": entry.state.channel_id }));
            app.leave_voice(&q, target);
        }
        "move" => {
            let to = d
                .get("channelId")
                .and_then(|c| c.as_str())
                .and_then(|id| q.channel(id))
                .filter(|c| c.kind == "voice" && c.server_id.as_deref() == Some(server_id.as_str()));
            if let Some(to) = to.filter(|c| c.id != entry.state.channel_id && q.can_access(target, &c.id)) {
                app.to_socket(entry.sid, "voice:move", &json!({ "channelId": to.id }));
            }
        }
        _ => {}
    }
}

async fn voice_signal(
    s: SocketRef,
    State(app): State<AppRef>,
    Extension(UserId(me)): Extension<UserId>,
    Data(d): Data<Value>,
) {
    let Some(to) = d.get("to").and_then(|t| t.as_str()) else {
        return;
    };
    let target = {
        let voice = lock(&app.voice);
        let (Some(mine), Some(target)) = (voice.get(&me), voice.get(to)) else {
            return;
        };
        // Só repassa entre pessoas que estão no mesmo canal agora.
        if mine.sid != s.id || target.state.channel_id != mine.state.channel_id {
            return;
        }
        target.sid
    };
    let signal = d.get("signal").cloned().unwrap_or(Value::Null);
    app.to_socket(
        target,
        "voice:signal",
        &json!({ "from": me, "signal": signal }),
    );
}

async fn on_disconnect(
    s: SocketRef,
    State(app): State<AppRef>,
    Extension(UserId(me)): Extension<UserId>,
) {
    let q = app.store.q();
    let mine = lock(&app.voice).get(&me).is_some_and(|v| v.sid == s.id);
    if mine {
        app.leave_voice(&q, &me);
    }
    let went_offline = lock(&app.store.presence).disconnect(&me, s.id);
    if went_offline {
        app.broadcast_presence(&q, &me);
    }
}
