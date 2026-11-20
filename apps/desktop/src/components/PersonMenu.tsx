'use client';

import type { Server } from '@line/shared';
import { useEffect, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { api } from '@/lib/api';
import { dmPrefs, MAX_PINNED, useDmPrefs } from '@/lib/dmPrefs';
import { setIgnored, useIgnored } from '@/lib/ignored';
import { isChannelMuted, muteChannel, unmuteChannel } from '@/lib/notify';
import { actions, useLine } from '@/lib/store';
import { joinVoice } from '@/lib/voice';
import { closeContextMenu, type MenuEntry } from './ContextMenu';
import { confirmDialog, showError, toast } from './Dialogs';
import { MuteSubmenu } from './Notifications';
import { Button, Icons, Modal } from './ui';

const copy = async (text: string, what: string) => {
  await navigator.clipboard.writeText(text).catch(() => {});
  toast(`${what} copiado.`);
};

const subItem = 'flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left font-medium text-soft hover:bg-hover hover:text-fg';

function InviteSubmenu({ userId }: { userId: string }) {
  const servers = useLine(useShallow((s) => s.serverOrder.map((id) => s.servers[id]).filter((sv): sv is Server => !!sv && !sv.suspended)));
  const name = useLine((s) => s.users[userId]?.displayName ?? '');
  if (!servers.length) return <p className="px-2.5 py-1.5 text-sm text-muted">Você não está em nenhum servidor.</p>;
  return (
    <>
      {servers.map((sv) => (
        <button
          key={sv.id}
          className={subItem}
          onClick={() => {
            closeContextMenu();
            void (async () => {
              const dm = await api.openDm([userId]);
              actions.upsertChannel(dm);
              await api.sendMessage(dm.id, `Entra no servidor ${sv.name} comigo! Código de convite: ${sv.inviteCode}`, []);
              toast(`Convite de ${sv.name} enviado para ${name}.`);
            })().catch(showError);
          }}
        >
          <span className="truncate">{sv.name}</span>
        </button>
      ))}
    </>
  );
}

/** "Fixar"/"Desafixar" de uma conversa direta ou grupo (até 5). */
export function pinEntry(dm: string): MenuEntry {
  const pinned = useDmPrefs.getState().pinned.includes(dm);
  return {
    label: pinned ? 'Desafixar' : 'Fixar',
    icon: <Icons.Pin size={15} />,
    onClick: () => {
      if (!dmPrefs.togglePinned(dm)) toast(`Você pode fixar no máximo ${MAX_PINNED} conversas.`);
    },
  };
}

/** Menu de uma pessoa na lista de conversas diretas ou de amigos. */
export function personMenu(userId: string, dmId?: string): MenuEntry[] {
  const s = useLine.getState();
  const user = s.users[userId];
  if (!user) return [];
  const prefs = useDmPrefs.getState();
  const dm = dmId ?? Object.values(s.channels).find((c) => c.type === 'dm' && c.recipients?.some((r) => r.id === userId))?.id;
  const friend = s.friends[userId]?.state;
  const ignored = useIgnored.getState().ids.includes(userId);
  const openDm = async () => {
    const ch = await api.openDm([userId]);
    actions.upsertChannel(ch);
    actions.goHome(ch.id);
    return ch;
  };
  return [
    dm && {
      label: 'Marcar como lida',
      disabled: !s.unread[dm] && !s.mentionCounts[dm],
      onClick: () => actions.markRead(dm),
    },
    dm && 'sep',
    dm && pinEntry(dm),
    dm && {
      label: prefs.favorites.includes(dm) ? 'Remover dos favoritos' : 'Adicionar aos favoritos',
      icon: <Icons.Star size={15} />,
      onClick: () => dmPrefs.toggleFavorite(dm),
    },
    dm && 'sep',
    { label: 'Perfil', onClick: () => actions.openModal({ kind: 'full-profile', userId }) },
    friend !== 'blocked' && { label: 'Iniciar chamada', onClick: async () => joinVoice((await openDm()).id) },
    { label: 'Adicionar nota', onClick: () => actions.openModal({ kind: 'user-note', userId }) },
    friend === 'friends' && {
      label: prefs.nicks[userId] ? 'Alterar apelido de amigo' : 'Adicionar apelido de amigo',
      onClick: () => actions.openModal({ kind: 'friend-nick', userId }),
    },
    dm && {
      label: 'Fechar mensagem direta',
      onClick: () => {
        dmPrefs.close(dm);
        const v = useLine.getState().view;
        if (v.kind === 'home' && v.dmId === dm) actions.goHome(null);
      },
    },
    'sep',
    friend !== 'blocked' && { label: 'Convidar para o servidor', onClick: () => {}, submenu: () => <InviteSubmenu userId={userId} /> },
    friend === 'friends' && {
      label: 'Desfazer amizade',
      onClick: async () => {
        if (await confirmDialog({ title: 'Desfazer amizade', message: `Tirar ${user.displayName} dos seus amigos?`, confirmLabel: 'Desfazer amizade', danger: true }))
          await api.removeFriend(userId).catch(showError);
      },
    },
    {
      label: ignored ? 'Deixar de ignorar' : 'Ignorar',
      onClick: async () => {
        await setIgnored(userId, !ignored).catch(showError);
        toast(ignored ? `Você parou de ignorar ${user.displayName}.` : `Mensagens de ${user.displayName} vão ficar recolhidas.`);
      },
    },
    friend === 'blocked'
      ? {
          label: 'Desbloquear',
          onClick: async () => {
            await api.unblockUser(userId).catch(showError);
            actions.removeFriend(userId);
          },
        }
      : {
          label: 'Bloquear',
          danger: true,
          onClick: async () => {
            if (
              await confirmDialog({
                title: `Bloquear ${user.displayName}`,
                message: 'A pessoa não vai poder te mandar pedidos nem mensagens diretas.',
                confirmLabel: 'Bloquear',
                danger: true,
              })
            )
              await api.blockUser(userId).catch(showError);
          },
        },
    dm && 'sep',
    dm &&
      (isChannelMuted(s, dm)
        ? { label: `Reativar @${user.displayName}`, icon: <Icons.Bell size={15} />, onClick: () => unmuteChannel(dm) }
        : { label: `Silenciar @${user.displayName}`, onClick: () => {}, submenu: () => <MuteSubmenu onPick={(m) => muteChannel(dm, m)} /> }),
    'sep',
    { label: 'Copiar ID do usuário', icon: <Icons.Copy size={15} />, onClick: () => copy(userId, 'ID do usuário') },
    dm && { label: 'Copiar ID do canal', icon: <Icons.Copy size={15} />, onClick: () => copy(dm, 'ID do canal') },
  ];
}

/** "Adicionar nota": nota só minha sobre a pessoa. */
export function UserNoteModal({ userId, onClose }: { userId: string; onClose: () => void }) {
  const name = useLine((s) => s.users[userId]?.displayName ?? '');
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.profile(userId).then(
      (p) => setNote(p.note ?? ''),
      () => setNote(''),
    );
  }, [userId]);
  return (
    <Modal
      title="Adicionar nota"
      subtitle={`Sobre ${name}. Visível apenas para você.`}
      onClose={onClose}
      footer={
        <Button
          disabled={busy || note === null}
          onClick={async () => {
            setBusy(true);
            try {
              await api.setNote(userId, (note ?? '').trim());
              onClose();
            } catch (e) {
              showError(e);
            } finally {
              setBusy(false);
            }
          }}
        >
          Salvar
        </Button>
      }
    >
      <textarea
        autoFocus
        value={note ?? ''}
        disabled={note === null}
        onChange={(e) => setNote(e.target.value)}
        maxLength={256}
        rows={4}
        placeholder="Clique para adicionar uma nota"
        className="w-full resize-none rounded-lg border border-edge bg-rail px-3 py-2 text-sm outline-none placeholder:text-muted focus:border-accent"
      />
    </Modal>
  );
}

/** Apelido de amigo: só eu vejo, nas conversas diretas e na lista de amigos. */
export function FriendNickModal({ userId, onClose }: { userId: string; onClose: () => void }) {
  const user = useLine((s) => s.users[userId]);
  const [nick, setNick] = useState(() => useDmPrefs.getState().nicks[userId] ?? '');
  const done = () => {
    dmPrefs.setNick(userId, nick);
    onClose();
  };
  return (
    <Modal
      title="Apelido de amigo"
      subtitle={`Só você vê esse apelido no lugar de ${user?.displayName ?? 'o nome'}.`}
      onClose={onClose}
      footer={<Button onClick={done}>Salvar</Button>}
    >
      <input
        autoFocus
        value={nick}
        onChange={(e) => setNick(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && done()}
        maxLength={32}
        placeholder={user?.displayName}
        className="w-full rounded-lg border border-edge bg-rail px-3 py-2 text-sm outline-none placeholder:text-muted focus:border-accent"
      />
    </Modal>
  );
}
