//! Busca de GIFs pelo GIPHY. A chave (GIPHY_API_KEY) fica só no servidor; o app chama /api/gifs.

use serde::Serialize;
use std::time::Duration;

#[derive(Clone, Debug)]
pub struct Giphy {
    key: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Gif {
    pub id: String,
    pub title: String,
    /// Versão leve para a grade do seletor.
    pub preview: String,
    /// Versão enviada no chat.
    pub url: String,
    pub width: u32,
    pub height: u32,
}

impl Giphy {
    pub fn from_env() -> Option<Self> {
        let key = std::env::var("GIPHY_API_KEY").ok().filter(|s| !s.is_empty())?;
        Some(Self { key })
    }

    /// Busca (`query` vazio devolve os em alta).
    pub async fn search(&self, query: &str, offset: u32) -> Result<Vec<Gif>, reqwest::Error> {
        let mut params = vec![
            ("api_key", self.key.clone()),
            ("limit", "30".into()),
            ("offset", offset.to_string()),
            ("rating", "pg-13".into()),
        ];
        let url = if query.is_empty() {
            "https://api.giphy.com/v1/gifs/trending"
        } else {
            params.push(("q", query.into()));
            params.push(("lang", "pt".into()));
            "https://api.giphy.com/v1/gifs/search"
        };
        let v: serde_json::Value = reqwest::Client::new()
            .get(url)
            .query(&params)
            .timeout(Duration::from_secs(10))
            .send()
            .await?
            .error_for_status()?
            .json()
            .await?;
        let s = |v: &serde_json::Value| v.as_str().unwrap_or_default().to_string();
        let n = |v: &serde_json::Value| v.as_str().and_then(|s| s.parse().ok()).unwrap_or(0);
        Ok(v["data"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|g| {
                let img = &g["images"];
                let full = &img["downsized_medium"];
                let url = s(&full["url"]);
                if url.is_empty() {
                    return None;
                }
                let prev = s(&img["fixed_width"]["webp"]);
                Some(Gif {
                    id: s(&g["id"]),
                    title: s(&g["title"]),
                    preview: if prev.is_empty() { s(&img["fixed_width"]["url"]) } else { prev },
                    url,
                    width: n(&full["width"]),
                    height: n(&full["height"]),
                })
            })
            .collect())
    }
}
