import type { VoiceState } from '@line/shared';

interface Entry {
  state: VoiceState;
  /** A conexão (janela) que está na voz. Cada usuário fica em um canal por vez. */
  socketId: string;
}

/** Quem está em qual canal de voz. Fica só em memória: reiniciar o servidor derruba as chamadas. */
export class VoiceRegistry {
  private byUser = new Map<string, Entry>();

  get(userId: string): Entry | undefined {
    return this.byUser.get(userId);
  }

  join(userId: string, socketId: string, channelId: string, serverId: string | null, opts: { muted?: boolean; deafened?: boolean }) {
    const state: VoiceState = {
      userId,
      channelId,
      serverId,
      muted: !!opts.muted,
      deafened: !!opts.deafened,
      cameraStreamId: null,
      screenStreamId: null,
      joinedAt: new Date().toISOString(),
    };
    this.byUser.set(userId, { state, socketId });
    return state;
  }

  update(userId: string, patch: Partial<Pick<VoiceState, 'muted' | 'deafened' | 'cameraStreamId' | 'screenStreamId'>>) {
    const entry = this.byUser.get(userId);
    if (!entry) return undefined;
    const clean: Partial<VoiceState> = {};
    if (typeof patch.muted === 'boolean') clean.muted = patch.muted;
    if (typeof patch.deafened === 'boolean') clean.deafened = patch.deafened;
    if (patch.cameraStreamId === null || typeof patch.cameraStreamId === 'string') clean.cameraStreamId = patch.cameraStreamId?.slice(0, 100) ?? null;
    if (patch.screenStreamId === null || typeof patch.screenStreamId === 'string') clean.screenStreamId = patch.screenStreamId?.slice(0, 100) ?? null;
    entry.state = { ...entry.state, ...clean };
    return entry.state;
  }

  leave(userId: string): VoiceState | undefined {
    const entry = this.byUser.get(userId);
    this.byUser.delete(userId);
    return entry?.state;
  }

  inChannel(channelId: string): VoiceState[] {
    return [...this.byUser.values()].filter((e) => e.state.channelId === channelId).map((e) => e.state);
  }

  all(): VoiceState[] {
    return [...this.byUser.values()].map((e) => e.state);
  }
}
