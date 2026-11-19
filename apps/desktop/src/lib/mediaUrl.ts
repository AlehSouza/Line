'use client';

import type { Attachment } from '@line/shared';
import { useEffect, useState } from 'react';
import { api, fileUrl } from './api';

/**
 * Mídia com conteúdo sensível não tem link aberto: o servidor só entrega com um link
 * assinado (6 h), pedido em GET /attachments/{id}/access e só para quem tem 18 anos ou mais.
 * Assim, enquanto ela está coberta, nem o endereço real chega ao navegador.
 */
const cache = new Map<string, { url: string; exp: number }>();
const pending = new Map<string, Promise<string | null>>();

/** Link para abrir a mídia (assinado quando é sensível); null se o servidor recusar. */
export function mediaUrlOf(id: string, plainUrl: string, nsfw?: boolean): Promise<string | null> {
  if (!nsfw) return Promise.resolve(fileUrl(plainUrl));
  const hit = cache.get(id);
  if (hit && hit.exp * 1000 - Date.now() > 10 * 60 * 1000) return Promise.resolve(hit.url);
  let p = pending.get(id);
  if (!p) {
    p = api
      .attachmentAccess(id)
      .then((r) => {
        const url = fileUrl(r.url);
        cache.set(id, { url, exp: r.expires ?? Date.now() / 1000 + 3600 });
        return url;
      })
      .catch(() => null)
      .finally(() => pending.delete(id));
    pending.set(id, p);
  }
  return p;
}

/** Já resolvido (sem esperar): para quem precisa do link na hora, como o menu de contexto. */
export function cachedMediaUrl(a: Attachment): string | null {
  return a.nsfw ? cache.get(a.id)?.url ?? null : fileUrl(a.url);
}

/** Hook: link da mídia; null enquanto o link assinado não chega. */
export function useMediaUrl(a: Pick<Attachment, 'id' | 'url' | 'nsfw'> | null | undefined): string | null {
  const id = a?.id;
  const plain = a?.url;
  const nsfw = !!a?.nsfw;
  const [url, setUrl] = useState<string | null>(() => (a ? (nsfw ? cache.get(a.id)?.url ?? null : fileUrl(a.url)) : null));
  useEffect(() => {
    if (!id || !plain) return setUrl(null);
    let alive = true;
    void mediaUrlOf(id, plain, nsfw).then((u) => alive && setUrl(u));
    return () => {
      alive = false;
    };
  }, [id, plain, nsfw]);
  return url;
}
