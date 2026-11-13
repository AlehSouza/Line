//! Validação das entradas (equivalente aos schemas zod de `packages/shared/src/schemas.ts`).
use crate::errors::{ApiResult, validation};
use serde::Deserialize;
use serde::de::{DeserializeOwned, Deserializer};
use std::sync::LazyLock;

/// Lê o corpo JSON; JSON inválido ou tipo errado vira 400.
pub fn body<T: DeserializeOwned>(bytes: &[u8]) -> ApiResult<T> {
    let bytes = if bytes.iter().all(|b| b.is_ascii_whitespace()) {
        b"null".as_slice()
    } else {
        bytes
    };
    serde_json::from_slice(bytes).map_err(|_| validation("Dados inválidos"))
}

/// Distingue "campo ausente" (None) de "campo = null" (Some(None)).
pub fn nullable<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    d: D,
) -> Result<Option<Option<T>>, D::Error> {
    Option::<T>::deserialize(d).map(Some)
}

fn len(s: &str) -> usize {
    // O zod conta em UTF-16, como o JavaScript.
    s.encode_utf16().count()
}

fn text(s: &str, min: usize, max: usize, field: &str) -> ApiResult<()> {
    let n = len(s);
    if n < min {
        return Err(validation(if min <= 1 {
            format!("{field} não pode ficar vazio")
        } else {
            format!("{field} precisa ter pelo menos {min} caracteres")
        }));
    }
    if n > max {
        return Err(validation(format!(
            "{field} pode ter no máximo {max} caracteres"
        )));
    }
    Ok(())
}

static USERNAME_RE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"^[a-z0-9_.]+$").unwrap());
static COLOR_RE: LazyLock<regex::Regex> =
    LazyLock::new(|| regex::Regex::new(r"^#[0-9a-fA-F]{6}$").unwrap());
static SPACES_RE: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r"\s+").unwrap());

pub fn username(raw: &str) -> ApiResult<String> {
    let u = raw.trim().to_lowercase();
    if len(&u) < 2 {
        return Err(validation(
            "O nome de usuário precisa ter pelo menos 2 caracteres",
        ));
    }
    if len(&u) > 32 {
        return Err(validation(
            "O nome de usuário pode ter no máximo 32 caracteres",
        ));
    }
    if !USERNAME_RE.is_match(&u) {
        return Err(validation("Use apenas letras minúsculas, números, _ e ."));
    }
    Ok(u)
}

fn display_name(raw: &str) -> ApiResult<String> {
    let s = raw.trim().to_string();
    text(&s, 1, 32, "O nome de exibição")?;
    Ok(s)
}

fn color(raw: &str) -> ApiResult<String> {
    if !COLOR_RE.is_match(raw) {
        return Err(validation("Cor inválida"));
    }
    Ok(raw.to_string())
}

pub fn channel_name(raw: &str) -> ApiResult<String> {
    let s = raw.trim().to_lowercase();
    text(&s, 1, 100, "O nome do canal")?;
    Ok(SPACES_RE.replace_all(&s, "-").into_owned())
}

// ---------- corpos das rotas ----------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Register {
    pub username: String,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub captcha_token: Option<String>,
    pub display_name: Option<String>,
    pub password: String,
}

impl Register {
    pub fn check(mut self) -> ApiResult<Self> {
        self.username = username(&self.username)?;
        self.display_name = self.display_name.as_deref().map(display_name).transpose()?;
        self.email = match self.email.as_deref().map(str::trim) {
            None | Some("") => None,
            Some(e) => {
                let e = e.to_lowercase();
                let valid = e.len() <= 254
                    && !e.contains(char::is_whitespace)
                    && e.split_once('@').is_some_and(|(user, host)| {
                        !user.is_empty() && host.contains('.') && !host.starts_with('.') && !host.ends_with('.')
                    });
                if !valid {
                    return Err(validation("Digite um email válido"));
                }
                Some(e)
            }
        };
        if len(&self.password) < 6 {
            return Err(validation("A senha precisa ter pelo menos 6 caracteres"));
        }
        text(&self.password, 6, 128, "A senha")?;
        Ok(self)
    }
}

#[derive(Deserialize)]
pub struct Login {
    pub username: String,
    pub password: String,
}

impl Login {
    pub fn check(mut self) -> ApiResult<Self> {
        self.username = username(&self.username)?;
        text(&self.password, 1, 128, "A senha")?;
        Ok(self)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProfile {
    pub display_name: Option<String>,
    pub bio: Option<String>,
    pub avatar_color: Option<String>,
    #[serde(default, deserialize_with = "nullable")]
    pub custom_status: Option<Option<String>>,
    pub status: Option<String>,
}

impl UpdateProfile {
    pub fn check(mut self) -> ApiResult<Self> {
        self.display_name = self.display_name.as_deref().map(display_name).transpose()?;
        if let Some(bio) = &self.bio {
            text(bio, 0, 190, "A bio")?;
        }
        self.avatar_color = self.avatar_color.as_deref().map(color).transpose()?;
        if let Some(Some(s)) = &self.custom_status {
            text(s, 0, 128, "O status personalizado")?;
        }
        if let Some(s) = &self.status
            && !["online", "idle", "dnd", "invisible"].contains(&s.as_str())
        {
            return Err(validation("Status inválido"));
        }
        Ok(self)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateServer {
    pub name: String,
    pub description: Option<String>,
    pub is_public: Option<bool>,
}

fn server_name(raw: &str) -> ApiResult<String> {
    let s = raw.trim().to_string();
    text(&s, 2, 100, "O nome do servidor")?;
    Ok(s)
}

impl CreateServer {
    pub fn check(mut self) -> ApiResult<Self> {
        self.name = server_name(&self.name)?;
        if let Some(d) = &self.description {
            text(d, 0, 300, "A descrição")?;
        }
        Ok(self)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateServer {
    pub name: Option<String>,
    pub description: Option<String>,
    pub is_public: Option<bool>,
    pub icon_color: Option<String>,
}

impl UpdateServer {
    pub fn check(mut self) -> ApiResult<Self> {
        self.name = self.name.as_deref().map(server_name).transpose()?;
        if let Some(d) = &self.description {
            text(d, 0, 300, "A descrição")?;
        }
        self.icon_color = self.icon_color.as_deref().map(color).transpose()?;
        Ok(self)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateChannel {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: Option<String>,
    #[serde(default, deserialize_with = "nullable")]
    pub category_id: Option<Option<String>>,
    pub topic: Option<String>,
}

impl CreateChannel {
    pub fn check(mut self) -> ApiResult<Self> {
        self.name = channel_name(&self.name)?;
        let kind = self.kind.get_or_insert_with(|| "text".into());
        if kind != "text" && kind != "voice" {
            return Err(validation("Tipo de canal inválido"));
        }
        if let Some(t) = &self.topic {
            text(t, 0, 1024, "O tópico")?;
        }
        Ok(self)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateChannel {
    pub name: Option<String>,
    pub topic: Option<String>,
    #[serde(default, deserialize_with = "nullable")]
    pub category_id: Option<Option<String>>,
    pub position: Option<u32>,
}

impl UpdateChannel {
    pub fn check(mut self) -> ApiResult<Self> {
        self.name = self.name.as_deref().map(channel_name).transpose()?;
        if let Some(t) = &self.topic {
            text(t, 0, 1024, "O tópico")?;
        }
        Ok(self)
    }
}

#[derive(Deserialize)]
pub struct CreateCategory {
    pub name: String,
}

impl CreateCategory {
    pub fn check(mut self) -> ApiResult<Self> {
        self.name = self.name.trim().to_string();
        text(&self.name, 1, 100, "O nome da categoria")?;
        Ok(self)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendMessage {
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub attachment_ids: Vec<String>,
}

impl SendMessage {
    pub fn check(mut self) -> ApiResult<Self> {
        self.content = self.content.trim().to_string();
        if self.attachment_ids.len() > 10 {
            return Err(validation("No máximo 10 anexos por mensagem"));
        }
        if self.content.is_empty() && self.attachment_ids.is_empty() {
            return Err(validation("Mensagem vazia"));
        }
        if len(&self.content) > 4000 {
            return Err(validation("A mensagem pode ter no máximo 4000 caracteres"));
        }
        Ok(self)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateThread {
    pub name: String,
    #[serde(default)]
    pub message_id: Option<String>,
}

impl CreateThread {
    pub fn check(mut self) -> ApiResult<Self> {
        self.name = self.name.trim().to_string();
        text(&self.name, 1, 100, "O nome da thread")?;
        Ok(self)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateDm {
    /// Usernames ou ids dos participantes (além de você). 1 = DM, 2+ = grupo.
    pub user_ids: Vec<String>,
    pub name: Option<String>,
}

impl CreateDm {
    pub fn check(mut self) -> ApiResult<Self> {
        if self.user_ids.is_empty() || self.user_ids.len() > 9 {
            return Err(validation("Escolha de 1 a 9 pessoas"));
        }
        if let Some(n) = &mut self.name {
            *n = n.trim().to_string();
            text(n, 0, 100, "O nome do grupo")?;
        }
        Ok(self)
    }
}

#[derive(Deserialize)]
pub struct FriendRequest {
    pub username: String,
}

impl FriendRequest {
    pub fn check(mut self) -> ApiResult<Self> {
        self.username = username(&self.username)?;
        Ok(self)
    }
}
