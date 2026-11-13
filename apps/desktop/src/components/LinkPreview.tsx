'use client';

import { useEffect, useState } from 'react';
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

function LinkPreview({ url }: { url: string }) {
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
