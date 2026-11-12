use crate::ids::now_iso;
use serde::Serialize;
use socketioxide::socket::Sid;
use std::collections::HashMap;

/// Estado de alguém conectado a um canal de voz (ou chamada de DM).
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceState {
    pub user_id: String,
    pub channel_id: String,
    pub server_id: Option<String>,
    pub muted: bool,
    pub deafened: bool,
    pub camera_stream_id: Option<String>,
    pub screen_stream_id: Option<String>,
    pub joined_at: String,
}

#[derive(Clone)]
pub struct VoiceEntry {
    pub state: VoiceState,
    /// A conexão (janela) que está na voz. Cada usuário fica em um canal por vez.
    pub sid: Sid,
}

/// Patch vindo do cliente; cada campo só vale se tiver o tipo certo.
#[derive(Default)]
pub struct VoicePatch {
    pub muted: Option<bool>,
    pub deafened: Option<bool>,
    pub camera_stream_id: Option<Option<String>>,
    pub screen_stream_id: Option<Option<String>>,
}

impl VoicePatch {
    pub fn from_json(v: &serde_json::Value) -> Self {
        let stream = |key: &str| match v.get(key) {
            Some(serde_json::Value::Null) => Some(None),
            Some(serde_json::Value::String(s)) => Some(Some(s.chars().take(100).collect())),
            _ => None,
        };
        Self {
            muted: v.get("muted").and_then(|x| x.as_bool()),
            deafened: v.get("deafened").and_then(|x| x.as_bool()),
            camera_stream_id: stream("cameraStreamId"),
            screen_stream_id: stream("screenStreamId"),
        }
    }
}

/// Quem está em qual canal de voz. Fica só em memória: reiniciar o servidor derruba as chamadas.
#[derive(Default)]
pub struct VoiceRegistry {
    by_user: HashMap<String, VoiceEntry>,
}

impl VoiceRegistry {
    pub fn get(&self, user_id: &str) -> Option<&VoiceEntry> {
        self.by_user.get(user_id)
    }

    pub fn join(
        &mut self,
        user_id: &str,
        sid: Sid,
        channel_id: &str,
        server_id: Option<String>,
        muted: bool,
        deafened: bool,
    ) -> VoiceState {
        let state = VoiceState {
            user_id: user_id.to_string(),
            channel_id: channel_id.to_string(),
            server_id,
            muted,
            deafened,
            camera_stream_id: None,
            screen_stream_id: None,
            joined_at: now_iso(),
        };
        self.by_user.insert(
            user_id.to_string(),
            VoiceEntry {
                state: state.clone(),
                sid,
            },
        );
        state
    }

    pub fn update(&mut self, user_id: &str, patch: VoicePatch) -> Option<VoiceState> {
        let entry = self.by_user.get_mut(user_id)?;
        let s = &mut entry.state;
        if let Some(m) = patch.muted {
            s.muted = m;
        }
        if let Some(d) = patch.deafened {
            s.deafened = d;
        }
        if let Some(c) = patch.camera_stream_id {
            s.camera_stream_id = c;
        }
        if let Some(c) = patch.screen_stream_id {
            s.screen_stream_id = c;
        }
        Some(s.clone())
    }

    pub fn leave(&mut self, user_id: &str) -> Option<VoiceState> {
        self.by_user.remove(user_id).map(|e| e.state)
    }

    pub fn in_channel(&self, channel_id: &str) -> Vec<VoiceState> {
        let mut v: Vec<VoiceState> = self
            .by_user
            .values()
            .filter(|e| e.state.channel_id == channel_id)
            .map(|e| e.state.clone())
            .collect();
        v.sort_by(|a, b| a.joined_at.cmp(&b.joined_at));
        v
    }

    pub fn all(&self) -> Vec<VoiceEntry> {
        self.by_user.values().cloned().collect()
    }
}
