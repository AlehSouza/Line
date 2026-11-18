'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type LinkEmbed } from '@/lib/api';
import { Icons } from './ui';

const cache = new Map<string, Promise<LinkEmbed | null>>();

function loadEmbed(url: string) {
  let p = cache.get(url);
  if (!p) {
    p = api.embed(url).catch(() => null);
    cache.set(url, p);
  }
  return p;
}

/** Links da mensagem que ganham preview (fora de blocos de código; no máximo 3). */
export function linksFromContent(content: string): string[] {
  const text = content.replace(/```[\s\S]*?```/g, ' ').replace(/`[^`\n]+`/g, ' ');
  const found = text.match(/https?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]/g) ?? [];
  return [...new Set(found)].slice(0, 3);
}

export function LinkPreviews({ content }: { content: string }) {
  const links = linksFromContent(content);
  if (!links.length) return null;
  return (
    <>
      {links.map((u) => (
        <LinkPreview key={u} url={u} />
      ))}
    </>
  );
}

type Social = { kind: 'instagram' | 'tiktok' | 'x' | 'facebook' | 'reddit'; src: string; label: string; width: number; height: number };

/** Links de Instagram, TikTok, X, Facebook (vídeos) e Reddit viram o player oficial de cada plataforma (nada é baixado). */
function socialEmbed(raw: string): Social | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^(www\.|m\.|mobile\.)/, '');
  const seg = u.pathname.split('/').filter(Boolean);
  if (host === 'instagram.com') {
    const i = seg.findIndex((s) => s === 'p' || s === 'reel' || s === 'reels' || s === 'tv');
    const code = i >= 0 ? seg[i + 1] : undefined;
    if (!code || !/^[\w-]{5,40}$/.test(code)) return null;
    const type = seg[i] === 'p' ? 'p' : seg[i] === 'tv' ? 'tv' : 'reel';
    return { kind: 'instagram', src: `https://www.instagram.com/${type}/${code}/embed/`, label: 'Instagram', width: 340, height: 620 };
  }
  if (host === 'tiktok.com') {
    const i = seg.indexOf('video');
    const id = i >= 0 ? seg[i + 1] : undefined;
    if (!id || !/^\d{8,25}$/.test(id)) return null;
    return {
      kind: 'tiktok',
      src: `https://www.tiktok.com/embed/v2/${id}?lang=pt-BR`,
      label: 'TikTok',
      width: 325,
      height: 740,
    };
  }
  if (host === 'twitter.com' || host === 'x.com') {
    const i = seg.indexOf('status');
    const id = i >= 0 ? seg[i + 1] : undefined;
    if (!id || !/^\d{5,25}$/.test(id)) return null;
    const t = document.documentElement.dataset.theme ?? '';
    const dark = !['claro', 'pink', 'azul-pastel', 'verde-pastel'].includes(t);
    return {
      kind: 'x',
      src: `https://platform.twitter.com/embed/Tweet.html?id=${id}&embedId=line-x-${id}&theme=${dark ? 'dark' : 'light'}&dnt=true&lang=pt`,
      label: 'X',
      width: 400,
      height: 640,
    };
  }
  if (host === 'facebook.com' || host === 'fb.watch' || host === 'web.facebook.com') {
    const reel = seg[0] === 'reel' || (seg[0] === 'share' && seg[1] === 'r');
    const video =
      reel ||
      host === 'fb.watch' ||
      seg.includes('videos') ||
      (seg[0] === 'watch' && u.searchParams.has('v')) ||
      (seg[0] === 'share' && seg[1] === 'v');
    if (!video) return null;
    const href = encodeURIComponent(raw);
    return reel
      ? {
          kind: 'facebook',
          src: `https://www.facebook.com/plugins/video.php?href=${href}&show_text=false&width=300&height=533&locale=pt_BR`,
          label: 'Facebook',
          width: 300,
          height: 533,
        }
      : {
          kind: 'facebook',
          src: `https://www.facebook.com/plugins/video.php?href=${href}&show_text=false&width=432&locale=pt_BR`,
          label: 'Facebook',
          width: 432,
          height: 243,
        };
  }
  if (host === 'reddit.com' || host === 'old.reddit.com' || host === 'new.reddit.com') {
    const i = seg.indexOf('comments');
    if (seg[0] !== 'r' || i < 0 || !/^\w{3,12}$/.test(seg[i + 1] ?? '')) return null;
    const path = seg.slice(0, i + 3).join('/');
    const t = document.documentElement.dataset.theme ?? '';
    const dark = !['claro', 'pink', 'azul-pastel', 'verde-pastel'].includes(t);
    return {
      kind: 'reddit',
      src: `https://embed.reddit.com/${path}/?embed=true&theme=${dark ? 'dark' : 'light'}&showmedia=true&showmore=false`,
      label: 'Reddit',
      width: 432,
      height: 520,
    };
  }
  return null;
}

/** Instagram e X avisam a altura do conteúdo por postMessage; o iframe acompanha. */
function useFrameHeight(frame: React.RefObject<HTMLIFrameElement | null>, initial: number) {
  const [h, setH] = useState(initial);
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow) return;
      let d: unknown = e.data;
      if (typeof d === 'string') {
        try {
          d = JSON.parse(d);
        } catch {
          return;
        }
      }
      const o = d as {
        type?: string;
        details?: { height?: number };
        'twttr.embed'?: { method?: string; params?: { height?: number }[] };
      };
      let next: number | undefined;
      if (o?.type === 'MEASURE') next = o.details?.height;
      if (o?.type === 'resize.embed') next = Number((o as { data?: unknown }).data);
      const tw = o?.['twttr.embed'];
      if (tw?.method === 'twttr.private.resize') next = tw.params?.[0]?.height;
      if (typeof next === 'number' && next > 80 && next < 2000) setH(Math.ceil(next));
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [frame]);
  return h;
}

function SocialPlayer({ url, s }: { url: string; s: Social }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const height = useFrameHeight(frame, s.height);
  return (
    <div className="mt-1.5 max-w-full overflow-hidden rounded-lg border border-edge bg-side" style={{ width: s.width }}>
      <iframe
        ref={frame}
        src={s.src}
        title={s.label}
        loading="lazy"
        allow="autoplay; encrypted-media; picture-in-picture; fullscreen; clipboard-write"
        allowFullScreen
        referrerPolicy="strict-origin-when-cross-origin"
        scrolling="no"
        className="block w-full border-0 bg-transparent"
        style={{ height: s.kind === 'tiktok' || s.kind === 'facebook' ? s.height : height, colorScheme: 'normal' }}
      />
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="block border-t border-edge px-3 py-1.5 text-xs text-muted hover:text-accent hover:underline"
      >
        Abrir no {s.label}
      </a>
    </div>
  );
}

function LinkPreview({ url }: { url: string }) {
  const social = useMemo(() => socialEmbed(url), [url]);
  if (social) return <SocialPlayer url={url} s={social} />;
  return <CardPreview url={url} />;
}

function CardPreview({ url }: { url: string }) {
  const [embed, setEmbed] = useState<LinkEmbed | null>(null);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    let alive = true;
    void loadEmbed(url).then((e) => alive && setEmbed(e));
    return () => {
      alive = false;
    };
  }, [url]);

  if (!embed) return null;
  const yt = embed.youtubeId;

  return (
    <div className="mt-1.5 max-w-[min(100%,432px)] overflow-hidden rounded-lg border border-edge border-l-4 border-l-accent bg-side">
      <div className="px-3 pt-2.5 pb-3">
        {embed.siteName && <p className="mb-0.5 text-xs text-muted">{embed.siteName}</p>}
        {embed.title && (
          <a href={url} target="_blank" rel="noreferrer" className="line-clamp-2 font-semibold text-accent hover:underline">
            {embed.title}
          </a>
        )}
        {embed.description && <p className="mt-1 line-clamp-3 text-sm text-soft">{embed.description}</p>}
        {yt ? (
          <div className="relative mt-2 aspect-video w-full overflow-hidden rounded-md bg-black">
            {playing ? (
              <iframe
                src={`https://www.youtube-nocookie.com/embed/${yt}?autoplay=1&rel=0`}
                title={embed.title ?? 'YouTube'}
                allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
                allowFullScreen
                referrerPolicy="strict-origin-when-cross-origin"
                className="absolute inset-0 h-full w-full"
              />
            ) : (
              <button onClick={() => setPlaying(true)} className="group/yt absolute inset-0" title="Assistir aqui">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                {embed.image && <img src={embed.image} alt="" loading="lazy" className="h-full w-full object-cover" />}
                <span className="absolute inset-0 flex items-center justify-center bg-black/20 group-hover/yt:bg-black/35">
                  <span className="flex h-14 w-14 items-center justify-center rounded-full bg-black/70 text-white transition group-hover/yt:scale-110 group-hover/yt:bg-accent">
                    <Icons.Play size={26} className="ml-1" />
                  </span>
                </span>
              </button>
            )}
          </div>
        ) : (
          embed.image && (
            <a href={url} target="_blank" rel="noreferrer" className="mt-2 block">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={embed.image}
                alt=""
                loading="lazy"
                onError={(e) => (e.currentTarget.style.display = 'none')}
                className="max-h-60 w-full rounded-md object-cover"
              />
            </a>
          )
        )}
      </div>
    </div>
  );
}
