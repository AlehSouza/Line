'use client';

import { useEffect } from 'react';
import { ensureServerLoaded } from '@/lib/session';
import { actions, firstTextChannel, useLine } from '@/lib/store';
import { ChannelSidebar } from './ChannelSidebar';
import { ChatView } from './ChatView';
import { DiscoverView } from './DiscoverView';
import { DmSidebar } from './DmSidebar';
import { FriendsView } from './FriendsView';
import { MemberList } from './MemberList';
import { Modals } from './Modals';
import { ServerRail } from './ServerRail';
import { UserPanel } from './UserPanel';
import { IncomingCall, VoiceBar, VoiceStage } from './Voice';

export function AppShell() {
  const view = useLine((s) => s.view);
  const connection = useLine((s) => s.connection);
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
    <div className="flex h-screen flex-col">
      {connection === 'disconnected' && (
        <div className="bg-sun px-4 py-1 text-center text-xs font-semibold text-rail">
          Sem conexão com o servidor. Tentando reconectar…
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <ServerRail />
        <aside className="flex w-60 shrink-0 flex-col bg-side">
          <div className="min-h-0 flex-1">
            {view.kind === 'server' ? <ChannelSidebar serverId={view.serverId} /> : <DmSidebar />}
          </div>
          <VoiceBar />
          <UserPanel />
        </aside>
        <main className="flex min-w-0 flex-1 flex-col bg-main">{main}</main>
        {view.kind === 'server' && channel?.type === 'text' && <MemberList serverId={view.serverId} />}
      </div>
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
