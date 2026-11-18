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
    pub avatar_url: Option<String>,
    pub banner_url: Option<String>,
    pub pronouns: String,
    /// O "pensamento": balãozinho ao lado da foto no cartão de perfil.
    pub thought: Option<String>,
    /// Bot (ex.: o de música do servidor).
    pub bot: bool,
    /// Tag de servidor que a pessoa escolheu exibir ao lado do nome.
    pub tag: Option<UserTag>,
    /// Só para bots: aparência do nome e da etiqueta.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bot_style: Option<BotStyle>,
    /// Estilo do nome exibido: { font, effect, colors }.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name_style: Option<serde_json::Value>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BotStyle {
    pub name_color: Option<String>,
    pub tag_color: Option<String>,
    pub tag_text: String,
    /// Cor do anel de quando o agente "fala" na chamada (tocando música).
    pub ring_color: Option<String>,
    /// Status do canal de voz enquanto toca, com {musica} e {artista} (null = padrão, "" = desligado).
    pub now_playing: Option<String>,
    /// Aviso do chat no lugar de cada comando ({"hoje": "Perguntou sobre Hoje para o Agente"}).
    pub command_notes: serde_json::Value,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserTag {
    pub server_id: String,
    pub text: String,
    /// Nome de um ícone do Lucide; None = foto do servidor (`icon_url`).
    pub icon: Option<String>,
    pub icon_url: Option<String>,
    /// Cores e estilo do ícone (bg, fg, border, iconColor, iconStyle); null = padrão.
    pub style: serde_json::Value,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelfUser {
    #[serde(flatten)]
    pub public: PublicUser,
    pub status: String,
    pub status_until: Option<String>,
    pub created_at: String,
    pub email: Option<String>,
    /// false em conta criada pelo Google que ainda não definiu senha.
    pub has_password: bool,
    /// Data de nascimento (AAAA-MM-DD), só para a própria pessoa.
    pub birth_date: Option<String>,
    /// Mídias +18 aparecem atrás de um aviso até clicar.
    pub blur_sensitive: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Server {
    pub id: String,
    pub name: String,
    pub description: String,
    pub icon_color: String,
    /// Tag de identificação (até 4 caracteres); vazia = sem tag.
    pub tag: String,
    /// Ícone da tag: '' = foto do servidor; senão nome de um ícone do Lucide.
    pub tag_icon: String,
    /// Aparência da tag (bg, fg, border, iconColor, iconStyle); null = padrão.
    pub tag_style: serde_json::Value,
    pub icon_url: Option<String>,
    pub banner_url: Option<String>,
    pub owner_id: String,
    pub is_public: bool,
    pub invite_code: String,
    pub member_count: i64,
    pub created_at: String,
    /// Suspenso pelo admin do Line: ninguém fala, manda mensagem nem entra na voz.
    pub suspended: bool,
    /// Mostra a estrelinha de dono ao lado do nome do dono na lista de membros.
    pub show_owner_badge: bool,
    /// Rigor da detecção automática de +18 nas mídias: light | moderate | high.
    pub nsfw_level: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Category {
    pub id: String,
    pub server_id: String,
    pub name: String,
    pub position: i64,
    pub is_private: bool,
    /// Categoria base "Notas e Atualizações" (não pode ser excluída).
    pub base: bool,
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
    /// Canal privado: só o dono do servidor e os membros escolhidos enxergam.
    pub is_private: bool,
    /// Canal privado: pessoas e cargos que enxergam.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub member_ids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role_ids: Option<Vec<String>>,
    /// Só quem está nas listas abaixo manda mensagem (texto) ou fala (voz).
    pub interact_restricted: bool,
    /// Canal +18: aviso de conteúdo sensível na primeira entrada; só para 18 anos ou mais.
    pub nsfw: bool,
    /// Canal base: 'rules' | 'announcements' | 'events' | 'activity'; vazio = canal comum.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub base: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interact_member_ids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interact_role_ids: Option<Vec<String>>,
    pub last_message_at: Option<String>,
    /// Só para dm / group_dm / thread.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub owner_id: Option<Option<String>>,
    /// Só para thread: o canal de texto onde ela nasceu e a mensagem que a começou.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_message_id: Option<Option<String>>,
    /// Thread que responde a uma mídia só da mensagem (o topo da thread mostra só ela).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_attachment_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message_count: Option<i64>,
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
    /// Cargos da pessoa (sem o @everyone, que todo mundo tem).
    pub role_ids: Vec<String>,
    /// Perfil por servidor: { avatarUrl, bannerUrl, bio } (só o que a pessoa trocou).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile: Option<serde_json::Value>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Role {
    pub id: String,
    pub server_id: String,
    pub name: String,
    pub color: Option<String>,
    pub permissions: i64,
    /// Maior = mais alto na lista. O @everyone fica sempre em 0.
    pub position: i64,
    pub mentionable: bool,
    /// Aparece numa seção própria na lista de membros.
    pub hoist: bool,
    pub member_count: i64,
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
    pub attachments: Vec<Attachment>,
    /// Thread que começou nesta mensagem (se houver).
    pub thread: Option<ThreadSummary>,
    pub poll: Option<Poll>,
    /// @everyone/@here que vale (quem mandou tinha permissão).
    pub mention_everyone: bool,
    /// Cargos mencionados que valem (o app avisa quem tem esses cargos).
    pub mention_role_ids: Vec<String>,
    /// Reações agrupadas por emoji, na ordem em que cada emoji apareceu pela primeira vez.
    pub reactions: Vec<Reaction>,
    /// Recursos que o app precisa conhecer para mostrar esta mensagem (ex.: "poll", "audio").
    /// Se o app não conhecer algum, mostra o aviso para atualizar no lugar do conteúdo.
    pub requires: Vec<String>,
    /// Fixada no canal: desde quando e até quando (None = sempre). Vencida vira None.
    pub pinned_at: Option<String>,
    pub pinned_until: Option<String>,
    pub pinned_by: Option<String>,
    /// Excluída, mas mantida porque a thread dela tem respostas.
    pub deleted: bool,
    /// Encaminhada: canal de onde a mensagem original veio.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub forwarded_from: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reaction {
    pub emoji: String,
    /// Quem reagiu, na ordem em que reagiu.
    pub user_ids: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Poll {
    pub question: String,
    pub multi: bool,
    pub options: Vec<PollOption>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PollOption {
    pub id: String,
    pub text: String,
    pub voter_ids: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub id: String,
    pub filename: String,
    pub content_type: String,
    pub size: i64,
    /// Caminho relativo ao servidor (o app junta com o endereço do servidor).
    pub url: String,
    /// Fica borrado até clicar.
    pub spoiler: bool,
    /// +18: só aparece para quem informou ter 18 anos ou mais.
    pub nsfw: bool,
    /// +18 confirmado no painel admin: ninguém tira.
    pub nsfw_locked: bool,
    /// Tamanho real da imagem/vídeo em pixels (quando o app informou no envio).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<i64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadSummary {
    pub id: String,
    pub name: String,
    pub message_count: i64,
    pub last_message_at: Option<String>,
    /// Quem respondeu por último (até 3, mais recente primeiro), para os mini avatares.
    pub participant_ids: Vec<String>,
    /// Quantas pessoas diferentes responderam.
    pub participant_count: i64,
}

#[derive(Clone, Debug, Serialize)]
pub struct Friend {
    pub user: PublicUser,
    /// friends | incoming | outgoing | blocked
    pub state: &'static str,
    pub since: String,
}

#[derive(Serialize)]
pub struct ServerDetail {
    pub server: Server,
    pub categories: Vec<Category>,
    pub channels: Vec<Channel>,
    pub members: Vec<Member>,
    pub roles: Vec<Role>,
}

#[derive(Serialize)]
pub struct AuthResponse {
    pub token: String,
    pub user: SelfUser,
}
