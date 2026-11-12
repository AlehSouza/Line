use socketioxide::socket::Sid;
use std::collections::{HashMap, HashSet};

#[derive(Default)]
struct Entry {
    sockets: HashSet<Sid>,
    /// Sockets que reportaram inatividade (sem mouse/teclado há um tempo).
    idle_sockets: HashSet<Sid>,
}

/// Guarda em memória quem está conectado. A presença final combina:
/// - conexões abertas (nenhuma = offline)
/// - status escolhido (invisível = offline para os outros, ocupado = dnd)
/// - inatividade (todas as conexões ociosas = ausente)
#[derive(Default)]
pub struct PresenceTracker {
    entries: HashMap<String, Entry>,
}

impl PresenceTracker {
    /// Devolve true se o usuário acabou de ficar online.
    pub fn connect(&mut self, user_id: &str, sid: Sid) -> bool {
        let entry = self.entries.entry(user_id.to_string()).or_default();
        let was_online = !entry.sockets.is_empty();
        entry.sockets.insert(sid);
        !was_online
    }

    /// Devolve true se o usuário acabou de ficar offline.
    pub fn disconnect(&mut self, user_id: &str, sid: Sid) -> bool {
        let Some(entry) = self.entries.get_mut(user_id) else {
            return false;
        };
        entry.sockets.remove(&sid);
        entry.idle_sockets.remove(&sid);
        if entry.sockets.is_empty() {
            self.entries.remove(user_id);
            return true;
        }
        false
    }

    pub fn set_idle(&mut self, user_id: &str, sid: Sid, idle: bool) {
        if let Some(entry) = self.entries.get_mut(user_id) {
            if idle {
                entry.idle_sockets.insert(sid);
            } else {
                entry.idle_sockets.remove(&sid);
            }
        }
    }

    pub fn resolve(&self, user_id: &str, status: &str) -> &'static str {
        let Some(entry) = self.entries.get(user_id).filter(|e| !e.sockets.is_empty()) else {
            return "offline";
        };
        match status {
            "invisible" => "offline",
            "dnd" => "dnd",
            "idle" => "idle",
            _ if entry.idle_sockets.len() == entry.sockets.len() => "idle",
            _ => "online",
        }
    }
}
