//! "Entrar com Google" (OAuth 2.0 / OpenID Connect).
//!
//! Configurado por GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET (/etc/line/google.env na VPS).
//! PUBLIC_URL é o endereço público do servidor (padrão https://useline.tech): o Google volta
//! para {PUBLIC_URL}/api/auth/google/callback. Sem as duas chaves, o botão não aparece.
//!
//! Fluxo: o app abre /api/auth/google/start (no navegador do sistema, no desktop), o Google
//! volta no callback, o servidor acha ou cria a conta e devolve um código de uso único
//! (2 min) para o app trocar pelo token em POST /api/auth/google/finish. No web o código volta
//! em {APP_URL}/?google=...; no desktop, em http://127.0.0.1:{porta}/?code=..., onde o app
//! ficou escutando.
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Para onde mandar o código depois do Google.
#[derive(Clone, Copy, Debug)]
pub enum Target {
    Web,
    /// App desktop escutando em 127.0.0.1:{porta}.
    Desktop(u16),
}

pub struct Google {
    client_id: String,
    client_secret: String,
    pub redirect_uri: String,
    pub app_url: String,
    states: Mutex<HashMap<String, (Target, Instant)>>,
    codes: Mutex<HashMap<String, (String, Instant)>>,
}

/// O que interessa do perfil do Google.
#[derive(serde::Deserialize, Debug)]
pub struct Profile {
    pub sub: String,
    pub email: Option<String>,
    #[serde(default)]
    pub email_verified: bool,
    pub name: Option<String>,
}

const STATE_TTL: Duration = Duration::from_secs(10 * 60);
const CODE_TTL: Duration = Duration::from_secs(2 * 60);

fn random_token() -> String {
    use base64::Engine;
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

fn take<V: Clone>(map: &Mutex<HashMap<String, (V, Instant)>>, key: &str, ttl: Duration) -> Option<V> {
    let mut m = map.lock().unwrap_or_else(|e| e.into_inner());
    m.retain(|_, (_, t)| t.elapsed() < ttl);
    m.remove(key).map(|(v, _)| v)
}

fn put<V>(map: &Mutex<HashMap<String, (V, Instant)>>, v: V, ttl: Duration) -> String {
    let key = random_token();
    let mut m = map.lock().unwrap_or_else(|e| e.into_inner());
    m.retain(|_, (_, t)| t.elapsed() < ttl);
    m.insert(key.clone(), (v, Instant::now()));
    key
}

impl Google {
    pub fn from_env() -> Option<Self> {
        let var = |k: &str| std::env::var(k).ok().map(|v| v.trim().to_string()).filter(|v| !v.is_empty());
        let client_id = var("GOOGLE_CLIENT_ID")?;
        let client_secret = var("GOOGLE_CLIENT_SECRET")?;
        let public = var("PUBLIC_URL").unwrap_or_else(|| "https://useline.tech".into());
        let app_url = var("APP_URL").unwrap_or_else(|| format!("{}/app", public.trim_end_matches('/')));
        Some(Self {
            client_id,
            client_secret,
            redirect_uri: format!("{}/api/auth/google/callback", public.trim_end_matches('/')),
            app_url: app_url.trim_end_matches('/').to_string(),
            states: Mutex::default(),
            codes: Mutex::default(),
        })
    }

    /// Link da tela de consentimento do Google.
    pub fn authorize_url(&self, target: Target) -> String {
        let state = put(&self.states, target, STATE_TTL);
        let mut url = reqwest::Url::parse("https://accounts.google.com/o/oauth2/v2/auth").unwrap();
        url.query_pairs_mut()
            .append_pair("client_id", &self.client_id)
            .append_pair("redirect_uri", &self.redirect_uri)
            .append_pair("response_type", "code")
            .append_pair("scope", "openid email profile")
            .append_pair("state", &state)
            .append_pair("prompt", "select_account");
        url.into()
    }

    pub fn take_state(&self, state: &str) -> Option<Target> {
        take(&self.states, state, STATE_TTL)
    }

    /// Código de uso único que o app troca pelo token.
    pub fn issue_code(&self, user_id: String) -> String {
        put(&self.codes, user_id, CODE_TTL)
    }

    pub fn take_code(&self, code: &str) -> Option<String> {
        take(&self.codes, code, CODE_TTL)
    }

    /// Troca o `code` do callback pelo perfil do usuário. O perfil vem direto do Google por
    /// HTTPS com o nosso segredo, então não precisa conferir assinatura de id_token.
    pub async fn profile(&self, code: &str) -> Result<Profile, String> {
        #[derive(serde::Deserialize)]
        struct TokenReply {
            access_token: String,
        }
        let http = reqwest::Client::new();
        let token: TokenReply = http
            .post("https://oauth2.googleapis.com/token")
            .timeout(Duration::from_secs(15))
            .form(&[
                ("code", code),
                ("client_id", &self.client_id),
                ("client_secret", &self.client_secret),
                ("redirect_uri", &self.redirect_uri),
                ("grant_type", "authorization_code"),
            ])
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?
            .json()
            .await
            .map_err(|e| e.to_string())?;
        http.get("https://openidconnect.googleapis.com/v1/userinfo")
            .timeout(Duration::from_secs(15))
            .bearer_auth(token.access_token)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?
            .json()
            .await
            .map_err(|e| e.to_string())
    }

    /// Para onde o navegador vai depois do callback (com o código ou com o erro).
    pub fn return_url(&self, target: Target, result: Result<&str, &str>) -> String {
        let (key, value) = match result {
            Ok(code) => (if matches!(target, Target::Web) { "google" } else { "code" }, code),
            Err(msg) => ("googleError", msg),
        };
        let base = match target {
            Target::Web => format!("{}/", self.app_url),
            Target::Desktop(port) => format!("http://127.0.0.1:{port}/"),
        };
        let mut url = reqwest::Url::parse(&base).unwrap();
        url.query_pairs_mut().append_pair(key, value);
        url.into()
    }
}

/// Nome de usuário a partir do email/nome do Google: só [a-z0-9_.], 2 a 28 caracteres.
pub fn username_base(profile: &Profile) -> String {
    let raw = profile
        .email
        .as_deref()
        .and_then(|e| e.split('@').next())
        .or(profile.name.as_deref())
        .unwrap_or("usuario");
    let mut u: String = raw
        .to_lowercase()
        .chars()
        .map(|c| match c {
            'á' | 'à' | 'â' | 'ã' | 'ä' => 'a',
            'é' | 'è' | 'ê' | 'ë' => 'e',
            'í' | 'ì' | 'î' | 'ï' => 'i',
            'ó' | 'ò' | 'ô' | 'õ' | 'ö' => 'o',
            'ú' | 'ù' | 'û' | 'ü' => 'u',
            'ç' => 'c',
            c if c.is_ascii_alphanumeric() || c == '_' || c == '.' => c,
            _ => '_',
        })
        .take(28)
        .collect();
    if u.chars().count() < 2 {
        u = "usuario".into();
    }
    u
}
