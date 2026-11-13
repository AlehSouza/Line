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
});

export const createServerSchema = z.object({
  name: z.string().trim().min(2).max(100),
  description: z.string().max(300).optional(),
  isPublic: z.boolean().optional(),
});

export const updateServerSchema = createServerSchema.partial().extend({
  iconColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
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
});

export const updateChannelSchema = z.object({
  name: channelNameSchema.optional(),
  topic: z.string().max(1024).optional(),
  categoryId: z.string().nullable().optional(),
  position: z.number().int().min(0).optional(),
});

export const createCategorySchema = z.object({
  name: z.string().trim().min(1).max(100),
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
