'use client';

import type { UserStatus } from '@line/shared';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { logout } from '@/lib/session';
import { actions, useLine } from '@/lib/store';
import { listAudioDevices, setInputDevice, setNoiseSuppression, setOutputDevice, toggleDeafen, toggleMute, useVoice } from '@/lib/voice';
import { Avatar, cx, Icons, PresenceDot } from './ui';

export function UserPanel() {
  const me = useLine((s) => s.me);
  const muted = useVoice((v) => v.muted);
  const deafened = useVoice((v) => v.deafened);
  const [menu, setMenu] = useState<'input' | 'output' | null>(null);
  if (!me) return null;

  const shownPresence = me.status === 'invisible' ? 'offline' : me.presence === 'offline' ? 'online' : me.presence;

  return (
    <div
      className="relative flex h-[58px] items-center gap-1 rounded-b-xl px-2 first:rounded-t-xl"
      style={{ background: `linear-gradient(100deg, color-mix(in srgb, ${me.avatarColor} 28%, transparent), transparent 75%)` }}
    >
      {menu && <DeviceMenu kind={menu} onClose={() => setMenu(null)} />}
      <button
        title="Ver meu perfil"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          actions.openModal({ kind: 'user', userId: me.id, at: { x: r.left - 4, y: r.top - 4, above: true } });
        }}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1 text-left hover:bg-hover"
      >
        <Avatar name={me.displayName} color={me.avatarColor} src={me.avatarUrl} size={32} presence={shownPresence} ring="rail" />
        <span className="min-w-0">
          <span className="block truncate text-sm font-semibold">{me.displayName}</span>
          <span className="block truncate text-xs text-muted">{me.customStatus || `@${me.username}`}</span>
        </span>
      </button>
      <SplitButton
        title={muted ? 'Ativar microfone' : 'Silenciar microfone'}
        active={muted || deafened}
        onClick={toggleMute}
        onMenu={() => setMenu((m) => (m === 'input' ? null : 'input'))}
      >
        {muted || deafened ? <Icons.MicOff size={18} /> : <Icons.Mic size={18} />}
      </SplitButton>
      <SplitButton
        title={deafened ? 'Voltar a ouvir' : 'Ensurdecer'}
        active={deafened}
        onClick={toggleDeafen}
        onMenu={() => setMenu((m) => (m === 'output' ? null : 'output'))}
      >
        {deafened ? <Icons.HeadphonesOff size={18} /> : <Icons.Headphones size={18} />}
      </SplitButton>
      <button title="Configurações" onClick={() => actions.openModal({ kind: 'settings' })} className="rounded-md p-1.5 text-soft hover:bg-hover hover:text-fg">
        <Icons.Settings size={18} />
      </button>
    </div>
  );
}

/** Botão com ação principal (mutar/ensurdecer) e uma setinha que abre o menu de dispositivos. */
function SplitButton({
  title,
  active,
  onClick,
  onMenu,
  children,
}: {
  title: string;
  active: boolean;
  onClick: () => void;
  onMenu: () => void;
  children: React.ReactNode;
}) {
  return (
    <span className={cx('flex items-center rounded-md', active ? 'bg-danger/15 text-danger' : 'text-soft')}>
      <button title={title} onClick={onClick} className="rounded-l-md py-1.5 pr-0.5 pl-1.5 hover:bg-hover hover:text-fg">
        {children}
      </button>
      <button title="Dispositivos" onClick={onMenu} className="rounded-r-md px-0.5 py-1.5 hover:bg-hover hover:text-fg">
        <Icons.Chevron size={12} />
      </button>
    </span>
  );
}

/** Escolher microfone (com o supressor de ruído) ou saída de áudio, direto do painel. */
function DeviceMenu({ kind, onClose }: { kind: 'input' | 'output'; onClose: () => void }) {
  const inputId = useVoice((v) => v.inputId);
  const outputId = useVoice((v) => v.outputId);
  const noise = useVoice((v) => v.noiseSuppression);
  const [list, setList] = useState<{ id: string; label: string }[] | null>(null);
  useEffect(() => {
    listAudioDevices()
      .then((d) => setList(kind === 'input' ? d.inputs : d.outputs))
      .catch(() => setList([]));
  }, [kind]);
  const current = kind === 'input' ? inputId : outputId;
  const pick = (id: string | null) => {
    if (kind === 'input') void setInputDevice(id);
    else setOutputDevice(id);
    onClose();
  };
  const item = (active: boolean) =>
    cx('flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-hover', active && 'text-accent');

  return (
    <div className="absolute bottom-full left-2 right-2 z-30 mb-2 rounded-lg border border-edge bg-rail p-1.5 shadow-xl" onMouseLeave={onClose}>
      <p className="px-2.5 pt-1 pb-1.5 text-[11px] font-bold tracking-wide text-muted uppercase">
        {kind === 'input' ? 'Microfone' : 'Saída de áudio'}
      </p>
      <button onClick={() => pick(null)} className={item(!current)}>
        <span className="flex-1 truncate">Padrão do sistema</span>
        {!current && <Icons.Check size={14} />}
      </button>
      {list?.map((d) => (
        <button key={d.id} onClick={() => pick(d.id)} className={item(current === d.id)}>
          <span className="flex-1 truncate">{d.label}</span>
          {current === d.id && <Icons.Check size={14} />}
        </button>
      ))}
      {kind === 'input' && (
        <>
          <div className="my-1 h-px bg-edge" />
          <button onClick={() => void setNoiseSuppression(!noise)} className={item(false)}>
            <Icons.Waves size={16} className={noise ? 'text-accent' : 'text-muted'} />
            <span className="flex-1">Supressor de ruído</span>
            <span className={cx('text-xs font-semibold', noise ? 'text-accent' : 'text-muted')}>{noise ? 'Ligado' : 'Desligado'}</span>
          </button>
        </>
      )}
    </div>
  );
}
