//! Proteção do cadastro: Cloudflare Turnstile (captcha) e limite de contas novas por IP.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// TURNSTILE_SITE_KEY (pública, vai para a interface) e TURNSTILE_SECRET (só no servidor).
#[derive(Clone, Debug)]
pub struct Turnstile {
    pub site_key: String,
    secret: String,
}

impl Turnstile {
    pub fn from_env() -> Option<Self> {
        let site_key = std::env::var("TURNSTILE_SITE_KEY").ok().filter(|s| !s.is_empty())?;
        let secret = std::env::var("TURNSTILE_SECRET").ok().filter(|s| !s.is_empty())?;
        Some(Self { site_key, secret })
    }

    /// Confere o token do widget com a Cloudflare.
    pub async fn verify(&self, token: &str, ip: Option<&str>) -> bool {
        #[derive(serde::Deserialize)]
        struct Reply {
            success: bool,
        }
        let mut form = vec![("secret", self.secret.as_str()), ("response", token)];
        if let Some(ip) = ip {
            form.push(("remoteip", ip));
        }
        let res = reqwest::Client::new()
            .post("https://challenges.cloudflare.com/turnstile/v0/siteverify")
            .timeout(Duration::from_secs(10))
            .form(&form)
            .send()
            .await;
        match res {
            Ok(r) => r.json::<Reply>().await.map(|r| r.success).unwrap_or(false),
            Err(err) => {
                tracing::warn!("Turnstile indisponível: {err}");
                false
            }
        }
    }
}

/// Até `MAX` contas novas por IP a cada `WINDOW`.
pub struct SignupLimiter(Mutex<HashMap<String, Vec<Instant>>>);

const MAX: usize = 3;
const WINDOW: Duration = Duration::from_secs(60 * 60);

impl SignupLimiter {
    pub fn new() -> Self {
        Self(Mutex::new(HashMap::new()))
    }

    /// Registra uma tentativa; devolve false se o IP já passou do limite.
    pub fn allow(&self, ip: &str) -> bool {
        let mut map = self.0.lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        map.retain(|_, times| {
            times.retain(|t| now.duration_since(*t) < WINDOW);
            !times.is_empty()
        });
        let times = map.entry(ip.to_string()).or_default();
        if times.len() >= MAX {
            return false;
        }
        times.push(now);
        true
    }
}

impl Default for SignupLimiter {
    fn default() -> Self {
        Self::new()
    }
}
