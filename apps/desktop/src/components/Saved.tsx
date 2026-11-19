'use client';

import { useEffect, useState } from 'react';
import type { Message, SavedMessage } from '@line/shared';
import { api, fileUrl } from '@/lib/api';
import { renderMarkdown } from '@/lib/markdown';
import { ensureServerLoaded, jumpToMessage } from '@/lib/session';
import { actions, dmTitle, useLine } from '@/lib/store';
import { showError, toast } from './Dialogs';
import { MobileBack } from './Mobile';
import { hidden, summary } from './Pins';
import { Avatar, Icons } from './ui';

/** Salva ou tira a mensagem dos Salvos, com snackbar. */
export function toggleSaved(message: Pick<Message, 'id'>) {
  const saved = !!useLine.getState().saved[message.id];
  actions.setSaved(message.id, !saved);
  (saved ? api.unsaveMessage(message.id) : api.saveMessage(message.id))
    .then(() => toast(saved ? 'Removida dos Salvos' : 'Mensagem salva em Salvos'))
    .catch((e) => {
      actions.setSaved(message.id, saved);
      showError(e);
    });
}

export function useIsSaved(id: string) {
  return useLine((s) => !!s.saved[id]);
}

/** Página "Salvos": todas as mensagens que salvei, da mais recente para a mais antiga. */
export function SavedView() {
  const [items, setItems] = useState<SavedMessage[] | null>(null);
  const saved = useLine((s) => s.saved);
  const channels = useLine((s) => s.channels);
  const servers = useLine((s) => s.servers);
  const users = useLine((s) => s.users);
  const me = useLine((s) => s.me);
  const savedKey = Object.keys(saved).sort().join(',');

  // Recarrega quando algo é salvo/removido (aqui ou em outro aparelho).
  useEffect(() => {
    let alive = true;
    api
      .saved()
      .then((list) => alive && setItems(list))
      .catch((e) => {
        showError(e);
        if (alive) setItems([]);
      });
    return () => {
      alive = false;
    };
  }, [savedKey]);

  const remove = (id: string) => {
    setItems((cur) => (cur ?? []).filter((x) => x.messageId !== id));
    actions.setSaved(id, false);
    api.unsaveMessage(id).catch(showError);
  };

  // Apagada enquanto a página está aberta: vira "Essa mensagem foi apagada" na hora.
  useEffect(() => {
    const onDelete = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      setItems((cur) => cur && cur.map((x) => (x.messageId === id ? { ...x, message: null } : x)));
    };
    window.addEventListener('line:message-deleted', onDelete);
    return () => window.removeEventListener('line:message-deleted', onDelete);
  }, []);
  const live = useLine((s) => s.messages);
  const isGone = (it: SavedMessage) => !it.message || !!live[it.channelId]?.items.find((x) => x.id === it.messageId)?.deleted;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-4 border-b border-rail px-4 shadow-sm max-md:gap-2">
        <MobileBack />
        <span className="flex shrink-0 items-center gap-2 font-bold">
          <Icons.Bookmark className="text-muted" /> Salvos
        </span>
        {!!items?.length && <span className="text-sm text-muted">({items.length})</span>}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-2 p-4">
          {items === null && <p className="p-6 text-center text-sm text-muted">Carregando…</p>}
          {items?.length === 0 && (
            <div className="py-16 text-center text-sm text-muted">
              <Icons.Bookmark size={40} className="mx-auto mb-3 opacity-60" />
              <p className="font-semibold text-soft">Nenhuma mensagem salva ainda</p>
              <p className="mt-1">Passe o mouse numa mensagem e clique no marcador para guardar ela aqui.</p>
            </div>
          )}
          {items?.map((it) => {
            const m = it.message;
            if (!m || isGone(it)) {
              return (
                <div key={it.messageId} className="flex items-center gap-3 rounded-lg border border-edge bg-main/60 p-3">
                  <Icons.Trash size={18} className="shrink-0 text-muted" />
                  <p className="flex-1 text-sm text-muted italic">Essa mensagem foi apagada</p>
                  <button
                    onClick={() => remove(it.messageId)}
                    className="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium text-soft hover:bg-hover hover:text-danger"
                  >
                    <Icons.BookmarkX size={15} /> Remover dos salvos
                  </button>
                </div>
              );
            }
            const ch = channels[it.channelId];
            const isDm = !it.serverId;
            const place = isDm ? (ch ? dmTitle(ch, me?.id, users) : 'Mensagem direta') : (ch?.name ?? it.channelName ?? 'canal');
            const serverName = it.serverId ? (servers[it.serverId]?.name ?? it.serverName) : null;
            const a = users[m.author.id] ?? m.author;
            const first = m.attachments[0];
            return (
              <div
                key={it.messageId}
                role="button"
                onClick={async () => {
                  if (it.serverId) await ensureServerLoaded(it.serverId).catch(() => {});
                  await jumpToMessage(m);
                }}
                className="group block w-full cursor-pointer rounded-lg border border-edge bg-main/60 p-3 text-left hover:border-accent/50 hover:bg-hover"
              >
                <div className="mb-1.5 flex items-center gap-1 text-xs font-semibold text-muted">
                  {isDm ? <Icons.Users size={12} /> : ch?.type === 'thread' ? <Icons.Thread size={12} /> : <Icons.Hash size={12} />}
                  <span className="truncate">{place}</span>
                  {serverName && <span className="truncate font-normal">· {serverName}</span>}
                  <span className="flex-1" />
                  <button
                    title="Remover dos salvos"
                    onClick={(e) => {
                      e.stopPropagation();
                      remove(it.messageId);
                    }}
                    className="rounded p-1 text-accent opacity-0 group-hover:opacity-100 hover:text-danger max-md:opacity-100"
                  >
                    <Icons.BookmarkX size={15} />
                  </button>
                </div>
                <div className="flex gap-3">
                  <Avatar name={a.displayName} color={a.avatarColor} src={a.avatarUrl} size={36} />
                  <div className="min-w-0 flex-1">
                    <p className="flex items-baseline gap-2">
                      <span className="truncate text-sm font-semibold text-fg">{a.displayName}</span>
                      <span className="shrink-0 text-[11px] text-muted">
                        {new Date(m.createdAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </p>
                    {m.content ? (
                      <div className="line-clamp-6 text-sm break-words whitespace-pre-wrap text-soft">{renderMarkdown(m.content, me?.username ?? '')}</div>
                    ) : (
                      !(first?.contentType.startsWith('image/') && !hidden(m)) && <p className="text-sm text-soft">{summary(m, it.serverId)}</p>
                    )}
                    {first?.contentType.startsWith('image/') && !hidden(m) && !first.nsfw && !first.spoiler && (
                      <img src={fileUrl(first.url)} alt="" className="mt-1.5 max-h-48 max-w-full rounded-md object-cover" />
                    )}
                    {m.content && first && !first.contentType.startsWith('image/') && <p className="mt-1 text-xs text-muted">{summary({ ...m, content: '' }, it.serverId)}</p>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
