'use client';

import { useEffect } from 'react';
import { mobile, useMobile } from '@/lib/mobile';
import { ensureServerLoaded } from '@/lib/session';
import { actions, firstTextChannel, useLine } from '@/lib/store';
import { ChannelSidebar } from './ChannelSidebar';
import { ChatView, ThreadPanel } from './ChatView';
import { DiscoverView } from './DiscoverView';
import { DmSidebar } from './DmSidebar';
import { FriendsView } from './FriendsView';
import { MembersDrawer, ServerSidePanel } from './MemberList';
import { Modals } from './Modals';
import { ServerRail } from './ServerRail';
import { UserPanel } from './UserPanel';
import { cx } from './ui';
import { IncomingCall, VoiceBar, VoiceStage } from './Voice';

export function AppShell() {
  const view = useLine((s) => s.view);
  const connection = useLine((s) => s.connection);
  const thread = useLine((s) =>
    s.threadId ? s.channels[s.threadId] : s.threadDraft && s.view.kind === 'server' && s.view.channelId === s.threadDraft.parentId ? s.threadDraft : undefined,
  );
  const unreadTotal = useLine((s) => Object.values(s.unread).reduce((a, b) => a + b, 0));
  const channel = useLine((s) =>
    view.kind === 'server' && view.channelId ? s.channels[view.channelId] : view.kind === 'home' && view.dmId ? s.channels[view.dmId] : undefined,
  );

  useEffect(() => {
    if (view.kind !== 'server') return;
    const { serverId, channelId } = view;
    ensureServerLoaded(serverId)
      .then(() => {
        const s = useLine.getState();
        const valid = channelId && s.channels[channelId];
        if (!valid) {
          const first = firstTextChannel(s, serverId);
          if (first) actions.goServer(serverId, first);
        }
      })
      .catch(() => {});
  }, [view]);

  // No celular, abrir uma conversa (de onde for) mostra o chat em tela cheia.
  const dmId = view.kind === 'home' ? view.dmId : null;
  useEffect(() => {
    if (dmId) mobile.showMain();
  }, [dmId]);
  const pane = useMobile((m) => m.pane);
  const membersOpen = useMobile((m) => m.members);

  useEffect(() => {
    window.line?.setBadge(unreadTotal);
    document.title = unreadTotal ? `(${unreadTotal}) Line` : 'Line';
  }, [unreadTotal]);

  let main;
  if (view.kind === 'discover') main = <DiscoverView />;
  else if (view.kind === 'home' && !view.dmId) main = <FriendsView />;
  else if (channel?.type === 'voice') main = <VoiceStage channel={channel} />;
  else if (channel) main = <ChatView channel={channel} />;
  else main = <EmptyServer />;

  return (
    <div className="flex h-full flex-col">
      {connection === 'disconnected' && (
        <div className="bg-sun px-4 py-1 text-center text-xs font-semibold text-rail">
          Sem conexão com o servidor. Tentando reconectar…
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        {/* Coluna da esquerda: servidores + canais, com a caixa do usuário embaixo ocupando as duas. */}
        {/* No celular só uma coluna aparece por vez: a lista (pane "nav") ou o conteúdo (pane "main"). */}
        <div
          className={cx('flex w-full shrink-0 flex-col md:w-[312px]', pane === 'main' && 'max-md:hidden')}
          style={{ background: 'linear-gradient(to right, var(--color-rail) 72px, var(--color-side) 72px)' }}
        >
          <div className="flex min-h-0 flex-1">
            <ServerRail />
            <aside className="flex min-w-0 flex-1 flex-col bg-side md:w-60 md:flex-none">
              <div className="min-h-0 flex-1">
                {view.kind === 'server' ? <ChannelSidebar serverId={view.serverId} /> : <DmSidebar />}
              </div>
            </aside>
          </div>
          <div className="m-2 mt-1 rounded-xl border border-edge bg-rail shadow-lg">
            <VoiceBar />
            <UserPanel />
          </div>
        </div>
        <main className={cx('glow flex min-w-0 flex-1 flex-col bg-main', pane === 'nav' && 'max-md:hidden')}>{main}</main>
        {thread && channel?.type === 'text' ? (
          <ThreadPanel thread={thread} />
        ) : (
          view.kind === 'server' && channel?.type === 'text' && <ServerSidePanel key={view.serverId} serverId={view.serverId} />
        )}
      </div>
      {membersOpen && view.kind === 'server' && channel?.type === 'text' && <MembersDrawer serverId={view.serverId} onClose={mobile.closeMembers} />}
      <Modals />
      <IncomingCall />
    </div>
  );
}

function EmptyServer() {
  return (
    <div className="flex flex-1 items-center justify-center text-sm text-muted">
      Escolha um canal na barra lateral.
    </div>
  );
}
