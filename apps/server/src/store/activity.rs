//! Atividade de jogos: histórico de jogos de cada pessoa, privacidade e capas (cache da IGDB).
use super::{Q, ok};
use crate::ids::now_iso;
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};

/// "Onde eu compartilho": todos os servidores, só os com até 200 membros, ou nenhum (só amigos).
pub const SMALL_SERVER: i64 = 200;

#[derive(Clone, Debug)]
pub struct ActivitySettings {
    pub share: bool,
    /// "all" | "small" | "none"
    pub scope: String,
    pub hidden_servers: Vec<String>,
}

impl Default for ActivitySettings {
    fn default() -> Self {
        Self {
            share: true,
            scope: "all".into(),
            hidden_servers: vec![],
        }
    }
}

impl Q<'_> {
    pub fn activity_settings(&self, user_id: &str) -> ActivitySettings {
        ok(self
            .c
            .query_row(
                "SELECT share, scope, hidden_servers FROM activity_settings WHERE user_id = ?",
                [user_id],
                |r| {
                    let hidden: String = r.get(2)?;
                    Ok(ActivitySettings {
                        share: r.get::<_, i64>(0)? != 0,
                        scope: r.get(1)?,
                        hidden_servers: serde_json::from_str(&hidden).unwrap_or_default(),
                    })
                },
            )
            .optional())
        .unwrap_or_default()
    }

    pub fn set_activity_settings(&self, user_id: &str, s: &ActivitySettings) {
        ok(self.c.execute(
            "INSERT INTO activity_settings (user_id, share, scope, hidden_servers) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(user_id) DO UPDATE SET share = ?2, scope = ?3, hidden_servers = ?4",
            params![user_id, s.share as i64, s.scope, serde_json::to_string(&s.hidden_servers).unwrap_or_else(|_| "[]".into())],
        ));
    }

    fn are_friends(&self, a: &str, b: &str) -> bool {
        ok(self
            .c
            .query_row(
                "SELECT 1 FROM friendships WHERE status = 'accepted'
                 AND ((requester_id = ?1 AND addressee_id = ?2) OR (requester_id = ?2 AND addressee_id = ?1))",
                [a, b],
                |_| Ok(()),
            )
            .optional())
        .is_some()
    }

    /// Servidores em que `owner` mostra a atividade (pelas configurações de privacidade).
    pub fn activity_servers(&self, owner: &str, s: &ActivitySettings) -> Vec<String> {
        if !s.share || s.scope == "none" {
            return vec![];
        }
        let mut st = ok(self.c.prepare_cached(
            "SELECT m.server_id, (SELECT COUNT(*) FROM members x WHERE x.server_id = m.server_id) FROM members m WHERE m.user_id = ?",
        ));
        let rows: Vec<(String, i64)> =
            ok(ok(st.query_map([owner], |r| Ok((r.get(0)?, r.get(1)?)))).collect());
        rows.into_iter()
            .filter(|(id, n)| {
                !s.hidden_servers.contains(id) && (s.scope != "small" || *n <= SMALL_SERVER)
            })
            .map(|(id, _)| id)
            .collect()
    }

    /// `viewer` pode ver a atividade de `owner`? Amigos sempre (se compartilha); senão, precisa de
    /// um servidor em comum liberado.
    pub fn activity_visible(&self, owner: &str, viewer: &str, s: &ActivitySettings) -> bool {
        if owner == viewer {
            return true;
        }
        if !s.share {
            return false;
        }
        if self.are_friends(owner, viewer) {
            return true;
        }
        let shared = self.activity_servers(owner, s);
        shared.iter().any(|sid| self.is_member(sid, viewer))
    }

    /// Começou a jogar: cria o jogo no histórico (ou atualiza ícone/última vez).
    pub fn game_started(&self, user_id: &str, name: &str, icon: Option<&str>) {
        let now = now_iso();
        ok(self.c.execute(
            "INSERT INTO user_games (user_id, name, icon, first_played, last_played) VALUES (?1, ?2, ?3, ?4, ?4)
             ON CONFLICT(user_id, name) DO UPDATE SET last_played = ?4, icon = COALESCE(?3, icon)",
            params![user_id, name, icon, now],
        ));
    }

    /// Parou de jogar: soma o tempo da sessão (no total e na semana).
    pub fn game_stopped(&self, user_id: &str, name: &str, secs: i64) {
        ok(self.c.execute(
            "UPDATE user_games SET total_secs = total_secs + ?3, last_played = ?4,
               week_secs = CASE WHEN week_start = ?5 THEN week_secs + ?3 ELSE ?3 END, week_start = ?5
             WHERE user_id = ?1 AND name = ?2",
            params![user_id, name, secs.max(0), now_iso(), week_start()],
        ));
    }

    pub fn game_hidden(&self, user_id: &str, name: &str) -> bool {
        ok(self
            .c
            .query_row(
                "SELECT hidden FROM user_games WHERE user_id = ? AND name = ?",
                [user_id, name],
                |r| r.get::<_, i64>(0),
            )
            .optional())
        .is_some_and(|h| h != 0)
    }

    pub fn set_game_hidden(&self, user_id: &str, name: &str, hidden: bool) -> bool {
        ok(self.c.execute(
            "UPDATE user_games SET hidden = ? WHERE user_id = ? AND name = ?",
            params![hidden as i64, user_id, name],
        )) > 0
    }

    pub fn remove_game(&self, user_id: &str, name: &str) {
        ok(self.c.execute(
            "DELETE FROM user_games WHERE user_id = ? AND name = ?",
            [user_id, name],
        ));
    }

    /// Jogos da pessoa, do mais recente ao mais antigo.
    pub fn user_games(&self, user_id: &str) -> Vec<Value> {
        let mut st = ok(self.c.prepare_cached(
            "SELECT g.name, g.icon, g.first_played, g.last_played, g.total_secs, g.hidden, c.cover
             FROM user_games g LEFT JOIN game_covers c ON c.name = lower(g.name)
             WHERE g.user_id = ? ORDER BY g.last_played DESC LIMIT 200",
        ));
        ok(ok(st.query_map([user_id], |r| {
            Ok(json!({
                "name": r.get::<_, String>(0)?,
                "icon": r.get::<_, Option<String>>(1)?,
                "firstPlayed": r.get::<_, String>(2)?,
                "lastPlayed": r.get::<_, String>(3)?,
                "totalSecs": r.get::<_, i64>(4)?,
                "hidden": r.get::<_, i64>(5)? != 0,
                "cover": r.get::<_, Option<String>>(6)?,
            }))
        }))
        .collect())
    }

    /// Jogo mais recente (não escondido) de cada um, jogado nas últimas `hours` horas.
    pub fn recent_games(&self, user_ids: &[String], hours: i64) -> Vec<(String, Value)> {
        let since = (chrono::Utc::now() - chrono::Duration::hours(hours))
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();
        let mut out = vec![];
        let mut st = ok(self.c.prepare_cached(
            "SELECT g.name, g.icon, g.last_played, g.total_secs, c.cover,
               CASE WHEN g.week_start = ?3 THEN g.week_secs ELSE 0 END
             FROM user_games g LEFT JOIN game_covers c ON c.name = lower(g.name)
             WHERE g.user_id = ?1 AND g.hidden = 0 AND g.last_played > ?2 ORDER BY g.last_played DESC LIMIT 1",
        ));
        let week = week_start();
        for id in user_ids {
            let row = ok(st
                .query_row(params![id, since, week], |r| {
                    Ok(json!({
                        "name": r.get::<_, String>(0)?,
                        "icon": r.get::<_, Option<String>>(1)?,
                        "lastPlayed": r.get::<_, String>(2)?,
                        "totalSecs": r.get::<_, i64>(3)?,
                        "cover": r.get::<_, Option<String>>(4)?,
                        "weekSecs": r.get::<_, i64>(5)?,
                    }))
                })
                .optional());
            if let Some(v) = row {
                out.push((id.clone(), v));
            }
        }
        out
    }

    pub fn game_info(&self, user_id: &str, name: &str) -> Option<Value> {
        ok(self
            .c
            .query_row(
                "SELECT g.icon, g.total_secs, c.cover, CASE WHEN g.week_start = ?3 THEN g.week_secs ELSE 0 END
                 FROM user_games g LEFT JOIN game_covers c ON c.name = lower(g.name)
                 WHERE g.user_id = ?1 AND g.name = ?2",
                params![user_id, name, week_start()],
                |r| {
                    Ok(json!({
                        "icon": r.get::<_, Option<String>>(0)?,
                        "totalSecs": r.get::<_, i64>(1)?,
                        "cover": r.get::<_, Option<String>>(2)?,
                        "weekSecs": r.get::<_, i64>(3)?,
                    }))
                },
            )
            .optional())
    }

    /// Capa em cache: Some(Some(url)) achou, Some(None) já procurou e não achou, None nunca procurou.
    pub fn cached_cover(&self, name: &str) -> Option<Option<String>> {
        ok(self
            .c
            .query_row(
                "SELECT cover FROM game_covers WHERE name = ?",
                [name.to_lowercase()],
                |r| r.get::<_, Option<String>>(0),
            )
            .optional())
    }

    pub fn save_cover(&self, name: &str, cover: Option<&str>) {
        ok(self.c.execute(
            "INSERT INTO game_covers (name, cover, fetched_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(name) DO UPDATE SET cover = ?2, fetched_at = ?3",
            params![name.to_lowercase(), cover, now_iso()],
        ));
    }
}

/// Segunda-feira (UTC) da semana atual, "AAAA-MM-DD".
fn week_start() -> String {
    use chrono::Datelike;
    let d = chrono::Utc::now().date_naive();
    (d - chrono::Duration::days(d.weekday().num_days_from_monday() as i64))
        .format("%Y-%m-%d")
        .to_string()
}
