//! Eventos do canal base "Eventos": quem criou, quando, onde (canal de voz ou local),
//! o jogo e quem marcou presença.
use super::{Q, ok};
use crate::ids::{new_id, now_iso};
use rusqlite::{OptionalExtension, Row, params};
use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Rsvp {
    pub user_id: String,
    /// 'going' | 'maybe' | 'no'
    pub status: String,
    pub at: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub id: String,
    pub server_id: String,
    pub channel_id: String,
    pub creator_id: String,
    pub title: String,
    pub description: String,
    pub starts_at: String,
    pub ends_at: Option<String>,
    pub location: String,
    pub voice_channel_id: Option<String>,
    pub game: String,
    pub created_at: String,
    pub rsvps: Vec<Rsvp>,
}

/// O que dá para mudar num evento.
pub struct EventInput {
    pub title: String,
    pub description: String,
    pub starts_at: String,
    pub ends_at: Option<String>,
    pub location: String,
    pub voice_channel_id: Option<String>,
    pub game: String,
}

fn from_row(r: &Row) -> rusqlite::Result<Event> {
    Ok(Event {
        id: r.get("id")?,
        server_id: r.get("server_id")?,
        channel_id: r.get("channel_id")?,
        creator_id: r.get("creator_id")?,
        title: r.get("title")?,
        description: r.get("description")?,
        starts_at: r.get("starts_at")?,
        ends_at: r.get("ends_at")?,
        location: r.get("location")?,
        voice_channel_id: r.get("voice_channel_id")?,
        game: r.get("game")?,
        created_at: r.get("created_at")?,
        rsvps: Vec::new(),
    })
}

impl Q<'_> {
    fn with_rsvps(&self, mut e: Event) -> Event {
        let mut st = ok(self.c.prepare_cached(
            "SELECT user_id, status, at FROM event_rsvps WHERE event_id = ? ORDER BY at",
        ));
        e.rsvps = ok(ok(st.query_map([&e.id], |r| {
            Ok(Rsvp {
                user_id: r.get(0)?,
                status: r.get(1)?,
                at: r.get(2)?,
            })
        }))
        .collect());
        e
    }

    pub fn event(&self, id: &str) -> Option<Event> {
        ok(self
            .c
            .query_row("SELECT * FROM events WHERE id = ?", [id], from_row)
            .optional())
        .map(|e| self.with_rsvps(e))
    }

    /// Eventos do canal: os próximos e os que terminaram há até 30 dias.
    pub fn channel_events(&self, channel_id: &str) -> Vec<Event> {
        let list: Vec<Event> = {
            let mut st = ok(self.c.prepare_cached(
                "SELECT * FROM events WHERE channel_id = ?
                   AND COALESCE(ends_at, starts_at) >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days')
                 ORDER BY starts_at",
            ));
            ok(ok(st.query_map([channel_id], from_row)).collect())
        };
        list.into_iter().map(|e| self.with_rsvps(e)).collect()
    }

    pub fn create_event(
        &self,
        server_id: &str,
        channel_id: &str,
        creator: &str,
        e: &EventInput,
    ) -> Event {
        let id = new_id();
        let now = now_iso();
        ok(self.c.execute(
            "INSERT INTO events (id, server_id, channel_id, creator_id, title, description, starts_at, ends_at, location, voice_channel_id, game, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            params![id, server_id, channel_id, creator, e.title, e.description, e.starts_at, e.ends_at, e.location, e.voice_channel_id, e.game, now],
        ));
        // Quem cria já vai.
        self.set_rsvp(&id, creator, Some("going"));
        self.event(&id).unwrap()
    }

    pub fn update_event(&self, id: &str, e: &EventInput) -> Option<Event> {
        ok(self.c.execute(
            "UPDATE events SET title = ?, description = ?, starts_at = ?, ends_at = ?, location = ?, voice_channel_id = ?, game = ? WHERE id = ?",
            params![e.title, e.description, e.starts_at, e.ends_at, e.location, e.voice_channel_id, e.game, id],
        ));
        self.event(id)
    }

    pub fn delete_event(&self, id: &str) {
        ok(self.c.execute("DELETE FROM events WHERE id = ?", [id]));
    }

    /// None tira a resposta. Mudar de resposta atualiza a hora.
    pub fn set_rsvp(&self, event_id: &str, user_id: &str, status: Option<&str>) {
        match status {
            Some(s) => ok(self.c.execute(
                "INSERT INTO event_rsvps (event_id, user_id, status, at) VALUES (?, ?, ?, ?)
                 ON CONFLICT (event_id, user_id) DO UPDATE SET status = excluded.status, at = excluded.at
                 WHERE status != excluded.status",
                params![event_id, user_id, s, now_iso()],
            )),
            None => ok(self.c.execute(
                "DELETE FROM event_rsvps WHERE event_id = ? AND user_id = ?",
                params![event_id, user_id],
            )),
        };
    }
}
