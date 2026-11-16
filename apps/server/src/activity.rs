//! Atividade de jogos: o app do Windows conta qual jogo está aberto (`presence:game`), o servidor
//! guarda o histórico, respeita a privacidade de cada um e avisa quem pode ver (`activity:update`).
//!
//! Capas vêm da IGDB quando há IGDB_CLIENT_ID e IGDB_CLIENT_SECRET (app da Twitch, em
//! /etc/line/igdb.env na VPS). Sem elas, o cartão usa o ícone do .exe que o app mandou.
use crate::App;
use crate::store::lock;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Jogo aberto agora de cada pessoa: (nome, início ISO, início para contar o tempo).
#[derive(Default)]
pub struct Playing(pub Mutex<HashMap<String, (String, String, Instant)>>);

pub struct Igdb {
    client_id: String,
    secret: String,
    token: tokio::sync::Mutex<Option<(String, Instant)>>,
}

impl Igdb {
    pub fn from_env() -> Option<Self> {
        let var = |k: &str| {
            std::env::var(k)
                .ok()
                .map(|v| v.trim().to_string())
                .filter(|v| !v.is_empty())
        };
        Some(Self {
            client_id: var("IGDB_CLIENT_ID")?,
            secret: var("IGDB_CLIENT_SECRET")?,
            token: Default::default(),
        })
    }

    async fn token(&self, http: &reqwest::Client) -> Option<String> {
        let mut t = self.token.lock().await;
        if let Some((tok, until)) = t.as_ref()
            && Instant::now() < *until
        {
            return Some(tok.clone());
        }
        let v: Value = http
            .post("https://id.twitch.tv/oauth2/token")
            .query(&[
                ("client_id", self.client_id.as_str()),
                ("client_secret", self.secret.as_str()),
                ("grant_type", "client_credentials"),
            ])
            .send()
            .await
            .ok()?
            .json()
            .await
            .ok()?;
        let tok = v.get("access_token")?.as_str()?.to_string();
        let secs = v
            .get("expires_in")
            .and_then(|x| x.as_u64())
            .unwrap_or(3600)
            .saturating_sub(300);
        *t = Some((tok.clone(), Instant::now() + Duration::from_secs(secs)));
        Some(tok)
    }

    /// URL da capa do jogo (ou None se a IGDB não achou).
    pub async fn cover(&self, name: &str) -> Option<String> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(8))
            .build()
            .ok()?;
        let token = self.token(&http).await?;
        let safe: String = name.chars().filter(|c| *c != '"' && *c != '\\').collect();
        let body =
            format!("search \"{safe}\"; fields name,cover.image_id; where cover != null; limit 1;");
        let v: Value = http
            .post("https://api.igdb.com/v4/games")
            .header("Client-ID", &self.client_id)
            .header("Authorization", format!("Bearer {token}"))
            .body(body)
            .send()
            .await
            .ok()?
            .json()
            .await
            .ok()?;
        let id = v.get(0)?.get("cover")?.get("image_id")?.as_str()?;
        Some(format!(
            "https://images.igdb.com/igdb/image/upload/t_cover_big/{id}.jpg"
        ))
    }
}

impl Igdb {
    /// Pega o token mostrando o motivo quando a Twitch recusa (credenciais erradas, rede...).
    async fn token_or_error(&self, http: &reqwest::Client) -> Result<String, String> {
        if let Some(tok) = self.token(http).await {
            return Ok(tok);
        }
        let res = http
            .post("https://id.twitch.tv/oauth2/token")
            .query(&[
                ("client_id", self.client_id.as_str()),
                ("client_secret", self.secret.as_str()),
                ("grant_type", "client_credentials"),
            ])
            .send()
            .await
            .map_err(|e| format!("sem conexão com a Twitch: {e}"))?;
        let status = res.status();
        let body: String = res
            .text()
            .await
            .unwrap_or_default()
            .chars()
            .take(200)
            .collect();
        Err(format!(
            "a Twitch recusou as credenciais da IGDB ({status}): {body}"
        ))
    }

    /// Busca jogos pelo nome: até 10 `{ name, cover }` (cover pode faltar).
    pub async fn search(&self, text: &str) -> Result<Vec<Value>, String> {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(8))
            .build()
            .map_err(|e| e.to_string())?;
        let token = self
            .token_or_error(&http)
            .await
            .inspect_err(|e| tracing::warn!("IGDB: {e}"))?;
        let safe: String = text
            .chars()
            .filter(|c| *c != '"' && *c != '\\' && !c.is_control())
            .take(60)
            .collect();
        let body = format!("search \"{safe}\"; fields name,cover.image_id; limit 15;");
        let res = http
            .post("https://api.igdb.com/v4/games")
            .header("Client-ID", &self.client_id)
            .header("Authorization", format!("Bearer {token}"))
            .header("Accept", "application/json")
            .body(body)
            .send()
            .await
            .map_err(|e| format!("sem conexão com a IGDB: {e}"))?;
        let status = res.status();
        let raw = res.text().await.unwrap_or_default();
        if !status.is_success() {
            let msg = format!(
                "IGDB respondeu {status}: {}",
                raw.chars().take(200).collect::<String>()
            );
            tracing::warn!("{msg}");
            if status.as_u16() == 401 {
                // Token vencido ou revogado: pede outro na próxima busca.
                *self.token.lock().await = None;
            }
            return Err(msg);
        }
        let v: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
        let mut list: Vec<Value> = v
            .as_array()
            .map(|list| {
                list.iter()
                    .filter_map(|g| {
                        let name = g.get("name")?.as_str()?;
                        let cover = g
                            .get("cover")
                            .and_then(|c| c.get("image_id"))
                            .and_then(|i| i.as_str())
                            .map(|id| {
                                format!(
                                    "https://images.igdb.com/igdb/image/upload/t_cover_big/{id}.jpg"
                                )
                            });
                        Some(json!({ "name": name, "cover": cover }))
                    })
                    .collect()
            })
            .unwrap_or_default();
        // Com capa primeiro (são os jogos "de verdade"; sem capa costumam ser mods e versões).
        list.sort_by_key(|g| g["cover"].is_null());
        list.truncate(10);
        Ok(list)
    }
}

/// Nome de jogo aceitável vindo do app.
fn clean_name(s: &str) -> Option<String> {
    let n: String = s
        .trim()
        .chars()
        .filter(|c| !c.is_control())
        .take(80)
        .collect();
    (!n.is_empty()).then_some(n)
}

/// Ícone pequeno em data URL PNG (até 48 KB).
fn clean_icon(s: Option<&str>) -> Option<String> {
    s.filter(|i| i.starts_with("data:image/png;base64,") && i.len() <= 48 * 1024)
        .map(String::from)
}

impl App {
    /// Jogo de agora (para quem pode ver): nome, desde quando e capa/ícone.
    fn activity_payload(&self, q: &crate::store::Q, user_id: &str) -> Value {
        let playing = lock(&self.playing.0)
            .get(user_id)
            .map(|(n, since, _)| (n.clone(), since.clone()));
        match playing {
            Some((name, since)) if !q.game_hidden(user_id, &name) => {
                let info = q.game_info(user_id, &name).unwrap_or(json!({}));
                json!({ "userId": user_id, "game": { "name": name, "since": since, "icon": info.get("icon"), "cover": info.get("cover"), "totalSecs": info.get("totalSecs"), "weekSecs": info.get("weekSecs") } })
            }
            _ => json!({ "userId": user_id, "game": null }),
        }
    }

    /// Avisa a própria pessoa e quem pode ver a atividade dela.
    pub fn broadcast_activity(&self, q: &crate::store::Q, user_id: &str) {
        let payload = self.activity_payload(q, user_id);
        let settings = q.activity_settings(user_id);
        let mut to: Vec<String> = q
            .audience_of(user_id)
            .into_iter()
            .filter(|v| q.activity_visible(user_id, v, &settings))
            .collect();
        to.push(user_id.to_string());
        self.to_users(&to, "activity:update", &payload);
    }

    /// Fecha a sessão de jogo aberta (soma o tempo). Devolve true se havia jogo.
    fn stop_game(&self, q: &crate::store::Q, user_id: &str) -> bool {
        let prev = lock(&self.playing.0).remove(user_id);
        if let Some((name, _, started)) = prev {
            q.game_stopped(user_id, &name, started.elapsed().as_secs() as i64);
            true
        } else {
            false
        }
    }

    /// `presence:game` do app: `{ name, icon }` ou null.
    pub fn set_game(self: &Arc<Self>, user_id: &str, data: Option<&Value>) {
        let name = data
            .and_then(|d| d.get("name"))
            .and_then(|n| n.as_str())
            .and_then(clean_name);
        let icon = clean_icon(data.and_then(|d| d.get("icon")).and_then(|i| i.as_str()));
        let q = self.store.q();
        let current = lock(&self.playing.0)
            .get(user_id)
            .map(|(n, _, _)| n.clone());
        if current == name {
            return;
        }
        self.stop_game(&q, user_id);
        let Some(name) = name else {
            self.broadcast_activity(&q, user_id);
            return;
        };
        q.game_started(user_id, &name, icon.as_deref());
        lock(&self.playing.0).insert(
            user_id.to_string(),
            (name.clone(), crate::ids::now_iso(), Instant::now()),
        );
        self.broadcast_activity(&q, user_id);
        let need_cover = self.igdb.is_some() && q.cached_cover(&name).is_none();
        drop(q);
        if need_cover {
            let (app, user_id) = (self.clone(), user_id.to_string());
            tokio::spawn(async move {
                let Some(igdb) = &app.igdb else { return };
                let cover = igdb.cover(&name).await;
                let q = app.store.q();
                q.save_cover(&name, cover.as_deref());
                if cover.is_some() {
                    app.broadcast_activity(&q, &user_id);
                }
            });
        }
    }

    /// Saiu (última aba/app fechou): encerra o jogo.
    pub fn clear_game(&self, q: &crate::store::Q, user_id: &str) {
        if self.stop_game(q, user_id) {
            self.broadcast_activity(q, user_id);
        }
    }

    /// Atividade de agora (ou recente, até 24 h) dos membros de um servidor que eu posso ver.
    pub fn server_activities(&self, q: &crate::store::Q, me: &str, server_id: &str) -> Vec<Value> {
        let members: Vec<String> = q.ids(
            "SELECT user_id FROM members WHERE server_id = ?",
            [server_id],
        );
        let playing = lock(&self.playing.0).clone();
        let mut out: Vec<(bool, String, Value)> = vec![];
        let mut settings_cache: HashMap<String, crate::store::activity::ActivitySettings> =
            HashMap::new();
        let visible =
            |id: &str, cache: &mut HashMap<String, crate::store::activity::ActivitySettings>| {
                let s = cache
                    .entry(id.to_string())
                    .or_insert_with(|| q.activity_settings(id))
                    .clone();
                s.share && q.activity_servers(id, &s).iter().any(|x| x == server_id) || id == me
            };
        let mut rest = vec![];
        for id in &members {
            if let Some((name, since, _)) = playing.get(id) {
                if q.game_hidden(id, name) || !visible(id, &mut settings_cache) {
                    continue;
                }
                let info = q.game_info(id, name).unwrap_or(json!({}));
                out.push((
                    true,
                    since.clone(),
                    json!({ "userId": id, "playing": true, "name": name, "since": since, "icon": info.get("icon"), "cover": info.get("cover"), "totalSecs": info.get("totalSecs"), "weekSecs": info.get("weekSecs") }),
                ));
            } else {
                rest.push(id.clone());
            }
        }
        for (id, g) in q.recent_games(&rest, 24) {
            if !visible(&id, &mut settings_cache) {
                continue;
            }
            let last = g
                .get("lastPlayed")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            let mut v = g;
            v["userId"] = json!(id);
            v["playing"] = json!(false);
            out.push((false, last, v));
        }
        // Jogando agora primeiro; depois o mais recente.
        out.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)));
        out.into_iter().take(20).map(|(_, _, v)| v).collect()
    }
}
