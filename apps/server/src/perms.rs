//! Permissões de servidor (bits). Mesmos valores de `packages/shared/src/permissions.ts`.
//!
//! As permissões de alguém são a soma (OU) do cargo @everyone com os cargos que a pessoa tem.
//! O dono do servidor e quem tem "Administrador" podem tudo.

pub const VIEW_CHANNELS: i64 = 1 << 0;
pub const MANAGE_CHANNELS: i64 = 1 << 1;
pub const MANAGE_ROLES: i64 = 1 << 2;
pub const MANAGE_SERVER: i64 = 1 << 3;
pub const CREATE_INVITE: i64 = 1 << 4;
pub const KICK_MEMBERS: i64 = 1 << 5;
pub const MANAGE_MESSAGES: i64 = 1 << 6;
pub const MENTION_EVERYONE: i64 = 1 << 7;
pub const SEND_MESSAGES: i64 = 1 << 8;
pub const ATTACH_FILES: i64 = 1 << 9;
pub const CREATE_THREADS: i64 = 1 << 10;
pub const CONNECT: i64 = 1 << 11;
pub const SPEAK: i64 = 1 << 12;
pub const VIDEO: i64 = 1 << 13;
pub const ADMINISTRATOR: i64 = 1 << 14;
pub const CHANGE_NICKNAME: i64 = 1 << 15;
pub const MANAGE_NICKNAMES: i64 = 1 << 16;
/// Silenciar o microfone e o áudio de outros na voz.
pub const MUTE_MEMBERS: i64 = 1 << 17;
/// Mover outros entre canais de voz e desconectar da voz.
pub const MOVE_MEMBERS: i64 = 1 << 18;

pub const ALL: i64 = (1 << 19) - 1;

/// O que o @everyone de um servidor novo pode fazer.
pub const DEFAULT_EVERYONE: i64 =
    VIEW_CHANNELS | CREATE_INVITE | SEND_MESSAGES | ATTACH_FILES | CREATE_THREADS | CONNECT | SPEAK | VIDEO | CHANGE_NICKNAME;

pub fn has(perms: i64, flag: i64) -> bool {
    perms & flag == flag
}
