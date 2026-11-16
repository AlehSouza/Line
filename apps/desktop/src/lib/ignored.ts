import { create } from 'zustand';
import { api } from './api';

/** Pessoas que eu ignorei: as mensagens delas ficam recolhidas no chat. */
export const useIgnored = create<{ ids: string[]; loaded: boolean }>(() => ({ ids: [], loaded: false }));

export function loadIgnored() {
  api
    .ignored()
    .then((ids) => useIgnored.setState({ ids, loaded: true }))
    .catch(() => {});
}

export async function setIgnored(userId: string, on: boolean) {
  if (on) await api.ignore(userId);
  else await api.unignore(userId);
  useIgnored.setState((s) => ({ ids: on ? [...new Set([...s.ids, userId])] : s.ids.filter((id) => id !== userId) }));
}
