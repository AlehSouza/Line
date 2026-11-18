import { z } from 'zod';

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(2, 'O nome de usuário precisa ter pelo menos 2 caracteres')
  .max(32, 'O nome de usuário pode ter no máximo 32 caracteres')
  .regex(/^[a-z0-9_.]+$/, 'Use apenas letras minúsculas, números, _ e .');

export const registerSchema = z.object({
  username: usernameSchema,
  email: z.string().trim().email('Digite um email válido').max(254).optional(),
  displayName: z.string().trim().min(1).max(32).optional(),
  password: z.string().min(6, 'A senha precisa ter pelo menos 6 caracteres').max(128),
});

export const loginSchema = z.object({
  username: usernameSchema,
  password: z.string().min(1).max(128),
});

export const updateProfileSchema = z.object({
  displayName: z.string().trim().min(1).max(32).optional(),
  bio: z.string().max(190).optional(),
  avatarColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  customStatus: z.string().max(128).nullable().optional(),
  status: z.enum(['online', 'idle', 'dnd', 'invisible']).optional(),
  /** Duração do status em minutos; sem = para sempre. */
  statusMinutes: z.number().int().min(1).max(43200).optional(),
  pronouns: z.string().max(40).optional(),
  thought: z.string().max(80).nullable().optional(),
  avatarId: z.string().nullable().optional(),
  bannerId: z.string().nullable().optional(),
  tagServerId: z.string().nullable().optional(),
  botNameColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
  botTagColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
  botTagText: z.enum(['BOT', 'B']).optional(),
  botRingColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
  /** Status do canal enquanto o agente toca, com {musica} e {artista} (null = padrão, "" = desligado). */
  botNowPlaying: z.string().max(100).nullable().optional(),
  /** Aviso no chat no lugar de cada comando do agente ({ hoje: "Perguntou sobre Hoje para o Agente" }); vazio = padrão. */
  botCommandNotes: z.record(z.string(), z.string().max(80)).optional(),
});

export const createServerSchema = z.object({
  name: z.string().trim().min(2).max(100),
  description: z.string().max(300).optional(),
  isPublic: z.boolean().optional(),
});

export const updateServerSchema = createServerSchema.partial().extend({
  iconColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  tag: z.string().max(4).optional(),
  tagIcon: z.string().max(40).optional(),
  tagStyle: z
    .object({
      bg: z.union([z.string(), z.array(z.string()).min(2).max(4)]).optional(),
      fg: z.union([z.string(), z.array(z.string()).min(2).max(4)]).optional(),
      border: z.union([z.string(), z.array(z.string()).min(2).max(4)]).optional(),
      iconColor: z.union([z.string(), z.array(z.string()).min(2).max(4)]).optional(),
      iconStyle: z.enum(['outline', 'solid']).optional(),
      dir: z.enum(['h', 'v']).optional(),
      motion: z.enum(['static', 'wave', 'pulse']).optional(),
      font: z.string().max(20).optional(),
      effect: z.string().max(20).optional(),
      speed: z.enum(['slow', 'medium', 'fast']).optional(),
    })
    .nullable()
    .optional(),
  iconId: z.string().nullable().optional(),
  bannerId: z.string().nullable().optional(),
  showOwnerBadge: z.boolean().optional(),
});

export const channelNameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(100)
  .transform((s) => s.replace(/\s+/g, '-'));

export const createChannelSchema = z.object({
  name: channelNameSchema,
  type: z.enum(['text', 'voice']).default('text'),
  categoryId: z.string().nullable().optional(),
  topic: z.string().max(1024).optional(),
  isPrivate: z.boolean().optional(),
  /** Quem pode ver o canal privado (o dono do servidor sempre vê). */
  memberIds: z.array(z.string()).max(500).optional(),
  /** Cargos que podem ver o canal privado. */
  roleIds: z.array(z.string()).max(250).optional(),
});

export const updateChannelSchema = z.object({
  name: channelNameSchema.optional(),
  topic: z.string().max(1024).optional(),
  categoryId: z.string().nullable().optional(),
  position: z.number().int().min(0).optional(),
  /** Canal +18 (aviso de conteúdo sensível na primeira entrada). */
  nsfw: z.boolean().optional(),
  /** Quem vê (canal privado) e quem interage (manda mensagem / fala). Manda tudo de uma vez. */
  access: z
    .object({
      isPrivate: z.boolean(),
      memberIds: z.array(z.string()).max(500),
      roleIds: z.array(z.string()).max(250),
      interactRestricted: z.boolean(),
      interactMemberIds: z.array(z.string()).max(500),
      interactRoleIds: z.array(z.string()).max(250),
    })
    .optional(),
});

export const createCategorySchema = z.object({
  name: z.string().trim().min(1).max(100),
  isPrivate: z.boolean().optional(),
  /** Cargos que podem ver a categoria privada. */
  roleIds: z.array(z.string()).max(250).optional(),
});

export const sendMessageSchema = z
  .object({
    content: z.string().trim().max(4000).default(''),
    attachmentIds: z.array(z.string()).max(10).default([]),
  })
  .refine((m) => m.content.length > 0 || m.attachmentIds.length > 0, 'Mensagem vazia');

export const createThreadSchema = z.object({
  name: z.string().trim().min(1).max(100),
  messageId: z.string().optional(),
});

export const createDmSchema = z.object({
  /** Usernames ou ids dos participantes (além de você). 1 = DM, 2+ = grupo. */
  userIds: z.array(z.string()).min(1).max(9),
  name: z.string().trim().max(100).optional(),
});

export const friendRequestSchema = z.object({
  username: usernameSchema,
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;
export type CreateServerInput = z.infer<typeof createServerSchema>;
export type UpdateServerInput = z.infer<typeof updateServerSchema>;
export type CreateChannelInput = z.input<typeof createChannelSchema>;
export type UpdateChannelInput = z.input<typeof updateChannelSchema>;
export type CreateDmInput = z.infer<typeof createDmSchema>;
