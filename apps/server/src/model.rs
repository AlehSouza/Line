//! Tipos que vão para o app (mesmo formato JSON de `packages/shared/src/types.ts`).
use serde::Serialize;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicUser {
    pub id: String,
    pub username: String,
    pub display_name: String,
    pub avatar_color: String,
    pub bio: String,
    pub custom_status: Option<String>,
    pub presence: &'static str,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelfUser {
    #[serde(flatten)]
    pub public: PublicUser,
    pub status: String,
    pub created_at: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Server {
    pub id: String,
    pub name: String,
    pub description: String,
    pub icon_color: String,
    pub owner_id: String,
    pub is_public: bool,
    pub invite_code: String,
    pub member_count: i64,
    pub created_at: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Category {
    pub id: String,
    pub server_id: String,
    pub name: String,
    pub position: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Channel {
    pub id: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub server_id: Option<String>,
    pub category_id: Option<String>,
    pub name: String,
    pub topic: String,
    pub position: i64,
    pub last_message_at: Option<String>,
    /// Só para dm / group_dm.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_id: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recipients: Option<Vec<PublicUser>>,
}

impl Channel {
    pub fn is_dm(&self) -> bool {
        self.kind == "dm" || self.kind == "group_dm"
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Member {
    pub server_id: String,
    pub user: PublicUser,
    pub nickname: Option<String>,
    pub joined_at: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    pub id: String,
    pub channel_id: String,
    pub author: PublicUser,
    pub content: String,
    pub created_at: String,
    pub edited_at: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Friend {
    pub user: PublicUser,
    /// friends | incoming | outgoing
    pub state: &'static str,
    pub since: String,
}

#[derive(Serialize)]
pub struct ServerDetail {
    pub server: Server,
    pub categories: Vec<Category>,
    pub channels: Vec<Channel>,
    pub members: Vec<Member>,
}

#[derive(Serialize)]
pub struct AuthResponse {
    pub token: String,
    pub user: SelfUser,
}
