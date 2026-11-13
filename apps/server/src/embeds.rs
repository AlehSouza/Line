//! Preview de links do chat (título, descrição, imagem). O servidor busca a página para o app,
//! que não pode ler outros sites direto (CORS). YouTube usa o oEmbed oficial.
//! Só aceita destinos públicos (bloqueia IPs internos) e guarda o resultado em memória.

use regex::Regex;
use serde::Serialize;
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

const MAX_BYTES: usize = 512 * 1024;
const CACHE_TTL: Duration = Duration::from_secs(6 * 3600);
const CACHE_MAX: usize = 2000;

#[derive(Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Embed {
    pub url: String,
    pub site_name: Option<String>,
    pub title: Option<String>,
    pub description: Option<String>,
    pub image: Option<String>,
    /// Id do vídeo quando o link é do YouTube (o app toca embutido).
    pub youtube_id: Option<String>,
}

#[derive(Default)]
pub struct EmbedCache {
    map: Mutex<HashMap<String, (Instant, Option<Embed>)>>,
}

impl EmbedCache {
    pub async fn get(&self, url: &str) -> Option<Embed> {
        if let Some((at, e)) = self.map.lock().unwrap().get(url) {
            if at.elapsed() < CACHE_TTL {
                return e.clone();
            }
        }
        let e = fetch(url).await;
        let mut map = self.map.lock().unwrap();
        if map.len() >= CACHE_MAX {
            map.retain(|_, (at, _)| at.elapsed() < CACHE_TTL);
            if map.len() >= CACHE_MAX {
                map.clear();
            }
        }
        map.insert(url.to_string(), (Instant::now(), e.clone()));
        e
    }
}

pub fn youtube_id(url: &reqwest::Url) -> Option<String> {
    let host = url.host_str()?.trim_start_matches("www.").trim_start_matches("m.");
    let id = match host {
        "youtu.be" => url.path_segments()?.next()?.to_string(),
        "youtube.com" | "music.youtube.com" | "youtube-nocookie.com" => {
            let mut seg = url.path_segments()?;
            match seg.next()? {
                "watch" => url.query_pairs().find(|(k, _)| k == "v")?.1.into_owned(),
                "shorts" | "embed" | "live" => seg.next()?.to_string(),
                _ => return None,
            }
        }
        _ => return None,
    };
    let ok = (6..=20).contains(&id.len()) && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    ok.then_some(id)
}

async fn fetch(raw: &str) -> Option<Embed> {
    let url = reqwest::Url::parse(raw).ok()?;
    if let Some(id) = youtube_id(&url) {
        return Some(youtube(raw, id).await);
    }
    let (final_url, html) = get_html(url).await?;
    let mut e = parse_html(&html, &final_url);
    e.url = raw.to_string();
    (e.title.is_some() || e.description.is_some() || e.image.is_some()).then_some(e)
}

async fn youtube(raw: &str, id: String) -> Embed {
    let mut e = Embed {
        url: raw.to_string(),
        site_name: Some("YouTube".into()),
        image: Some(format!("https://i.ytimg.com/vi/{id}/hqdefault.jpg")),
        youtube_id: Some(id.clone()),
        ..Default::default()
    };
    let watch = format!("https://www.youtube.com/watch?v={id}");
    let res = reqwest::Client::new()
        .get("https://www.youtube.com/oembed")
        .query(&[("url", watch.as_str()), ("format", "json")])
        .timeout(Duration::from_secs(6))
        .send()
        .await;
    if let Ok(r) = res {
        if let Ok(v) = r.json::<serde_json::Value>().await {
            e.title = v["title"].as_str().map(str::to_string);
            e.description = v["author_name"].as_str().map(str::to_string);
        }
    }
    e
}

fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => {
            let o = v.octets();
            !(v.is_private()
                || v.is_loopback()
                || v.is_link_local()
                || v.is_unspecified()
                || v.is_broadcast()
                || v.is_multicast()
                || o[0] == 0
                || (o[0] == 100 && (o[1] & 0xc0) == 64))
        }
        IpAddr::V6(v) => {
            if let Some(v4) = v.to_ipv4_mapped() {
                return public_ip(IpAddr::V4(v4));
            }
            let s = v.segments()[0];
            !(v.is_loopback() || v.is_unspecified() || v.is_multicast() || (s & 0xfe00) == 0xfc00 || (s & 0xffc0) == 0xfe80)
        }
    }
}

/// Baixa a página seguindo até 4 redirecionamentos, conferindo o IP de cada destino.
async fn get_html(mut url: reqwest::Url) -> Option<(reqwest::Url, String)> {
    for _ in 0..5 {
        if !matches!(url.scheme(), "http" | "https") {
            return None;
        }
        let host = url.host_str()?.to_string();
        let port = url.port_or_known_default()?;
        let addr: SocketAddr = tokio::time::timeout(Duration::from_secs(3), tokio::net::lookup_host((host.as_str(), port)))
            .await
            .ok()?
            .ok()?
            .find(|a| public_ip(a.ip()))?;
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .resolve(&host, addr)
            .timeout(Duration::from_secs(6))
            .user_agent("Mozilla/5.0 (compatible; LineBot/1.0; +https://useline.tech)")
            .build()
            .ok()?;
        let mut res = client
            .get(url.clone())
            .header("accept", "text/html,application/xhtml+xml")
            .header("accept-language", "pt-BR,pt;q=0.9,en;q=0.8")
            .send()
            .await
            .ok()?;
        if res.status().is_redirection() {
            let loc = res.headers().get("location")?.to_str().ok()?;
            url = url.join(loc).ok()?;
            continue;
        }
        if !res.status().is_success() {
            return None;
        }
        let ctype = res.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or("").to_ascii_lowercase();
        if !ctype.contains("html") {
            return None;
        }
        let mut buf = Vec::new();
        while let Ok(Some(chunk)) = res.chunk().await {
            buf.extend_from_slice(&chunk);
            if buf.len() >= MAX_BYTES {
                break;
            }
        }
        return Some((url, String::from_utf8_lossy(&buf).into_owned()));
    }
    None
}

static META: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?is)<meta\s[^>]*>").unwrap());
static ATTR: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"(?is)([a-z:_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')"#).unwrap());
static TITLE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?is)<title[^>]*>(.*?)</title>").unwrap());

fn decode(s: &str) -> String {
    let s = s
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&#x27;", "'")
        .replace("&apos;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&nbsp;", " ");
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    s.chars().take(300).collect()
}

fn parse_html(html: &str, base: &reqwest::Url) -> Embed {
    let mut tags: HashMap<String, String> = HashMap::new();
    for m in META.find_iter(html) {
        let mut key = None;
        let mut content = None;
        for a in ATTR.captures_iter(m.as_str()) {
            let name = a[1].to_ascii_lowercase();
            let val = a.get(2).or(a.get(3)).map(|v| v.as_str()).unwrap_or("");
            match name.as_str() {
                "property" | "name" => key = Some(val.to_ascii_lowercase()),
                "content" => content = Some(val.to_string()),
                _ => {}
            }
        }
        if let (Some(k), Some(c)) = (key, content) {
            if !c.trim().is_empty() {
                tags.entry(k).or_insert(c);
            }
        }
    }
    let pick = |keys: &[&str]| keys.iter().find_map(|k| tags.get(*k)).map(|v| decode(v)).filter(|v| !v.is_empty());
    let title = pick(&["og:title", "twitter:title"])
        .or_else(|| TITLE.captures(html).map(|c| decode(&c[1])).filter(|v| !v.is_empty()));
    let image = pick(&["og:image", "og:image:url", "twitter:image", "twitter:image:src"])
        .and_then(|i| base.join(&i).ok())
        .filter(|u| u.scheme() == "https" || u.scheme() == "http")
        .map(|u| u.to_string());
    Embed {
        url: String::new(),
        site_name: pick(&["og:site_name"]).or_else(|| base.host_str().map(|h| h.trim_start_matches("www.").to_string())),
        title,
        description: pick(&["og:description", "twitter:description", "description"]),
        image,
        youtube_id: None,
    }
}
