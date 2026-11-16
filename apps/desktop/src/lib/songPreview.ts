'use client';

import { create } from 'zustand';
import { loadApi } from './music';

/** Prévia da música favorita do perfil: um player escondido só para isso, toca até 30 s. */
export const useSongPreview = create<{ videoId: string | null; loading: boolean }>(() => ({ videoId: null, loading: false }));

/* eslint-disable @typescript-eslint/no-explicit-any */
let player: any = null;
let stopTimer: number | undefined;

async function ensure(): Promise<any> {
  if (player) return player;
  const YT = await loadApi();
  if (player) return player;
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;left:-10000px;bottom:0;width:200px;height:120px;pointer-events:none;opacity:0;';
  const host = document.createElement('div');
  host.id = 'line-song-preview';
  box.appendChild(host);
  document.body.appendChild(box);
  await new Promise<void>((resolve) => {
    player = new YT.Player('line-song-preview', {
      width: 200,
      height: 120,
      playerVars: { autoplay: 1, controls: 0, disablekb: 1, playsinline: 1, rel: 0, fs: 0, iv_load_policy: 3 },
      events: {
        onReady: () => resolve(),
        onStateChange: (e: any) => {
          if (e.data === 1) useSongPreview.setState({ loading: false });
          if (e.data === 0) stopSong();
        },
        onError: () => stopSong(),
      },
    });
  });
  return player;
}

export function stopSong() {
  window.clearTimeout(stopTimer);
  try {
    player?.stopVideo?.();
  } catch {}
  useSongPreview.setState({ videoId: null, loading: false });
}

export async function toggleSong(videoId: string) {
  if (useSongPreview.getState().videoId === videoId) return stopSong();
  useSongPreview.setState({ videoId, loading: true });
  try {
    const p = await ensure();
    if (useSongPreview.getState().videoId !== videoId) return;
    p.setVolume?.(60);
    p.loadVideoById({ videoId, startSeconds: 30 });
    window.clearTimeout(stopTimer);
    stopTimer = window.setTimeout(() => useSongPreview.getState().videoId === videoId && stopSong(), 60_000);
  } catch {
    stopSong();
  }
}
