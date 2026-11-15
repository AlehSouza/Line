'use client';

import type { PublicUser } from '@line/shared';
import { fileUrl } from '@/lib/api';
import { useLine } from '@/lib/store';
import { DefaultServerIcon } from './ui';

/** Tag de servidor ao lado do nome (estilo tag de clã). Usa a versão mais nova da pessoa no store. */
export function UserTagBadge({ user }: { user: Pick<PublicUser, 'id' | 'tag'> }) {
  const live = useLine((s) => s.users[user.id]?.tag);
  const tag = live === undefined ? user.tag : live;
  const server = useLine((s) => (tag ? s.servers[tag.serverId] : undefined));
  if (!tag) return null;
  return (
    <span
      title={server ? `Tag do servidor ${server.name}` : 'Tag de servidor'}
      className="inline-flex shrink-0 items-center gap-1 self-center rounded-md bg-raise px-1 py-px text-[11px] leading-4 font-bold text-soft"
    >
      <span className="h-3 w-3 shrink-0 overflow-hidden rounded-[4px]">
        {server?.iconUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={fileUrl(server.iconUrl)} alt="" className="h-full w-full object-cover" />
        ) : (
          <DefaultServerIcon />
        )}
      </span>
      {tag.text}
    </span>
  );
}
