'use client';

import { hasPerm, Perm, PERMISSION_GROUPS, type Role } from '@line/shared';
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { actions, displayNameIn, permsOf, topPosition, useLine } from '@/lib/store';
import { ServerOverview } from './Modals';
import { Avatar, Button, channelIcon, cx, ErrorText, Icons, Input, Modal } from './ui';
import { ColorPicker } from './ColorPicker';
import { EmojiInput } from './EmojiField';
import { confirmDialog } from './Dialogs';
import { AgentCommands, MusicSettings, SmartReplies } from './AgentSettings';
import { ServerTagSettings } from './ServerTag';
import { SoundboardSettings } from './Soundboard';

type Section = 'overview' | 'tag' | 'roles' | 'members' | 'notes' | 'sounds' | 'music' | 'replies' | 'commands';

const ROLE_COLORS = [
  '#1abc9c', '#2ecc71', '#3498db', '#9b59b6', '#e91e63', '#f1c40f', '#e67e22', '#e74c3c', '#95a5a6', '#607d8b',
  '#11806a', '#1f8b4c', '#206694', '#71368a', '#ad1457', '#c27c0e', '#a84300', '#992d22', '#979c9f', '#546e7a',
];
const DEFAULT_ROLE_COLOR = '#99aab5';

function useErr() {
  const [error, setError] = useState('');
  const run = async (fn: () => Promise<unknown>) => {
    setError('');
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return { error, run, setError };
}

/** Configurações do servidor em tela cheia: Visão geral, Cargos e Membros. */
export function ServerSettings({ serverId, initial, onClose }: { serverId: string; initial?: 'overview' | 'roles'; onClose: () => void }) {
  const server = useLine((s) => s.servers[serverId]);
  const perms = useLine((s) => permsOf(s, serverId, s.me?.id));
  const canServer = hasPerm(perms, Perm.ManageServer);
  const isOwner = useLine((s) => s.me?.id === s.servers[serverId]?.ownerId);
  const canSounds = hasPerm(perms, Perm.ManageSoundboard);
  const canAgent = hasPerm(perms, Perm.ManageAgent);
  const canRoles = hasPerm(perms, Perm.ManageRoles);
  const canMembers = canRoles || hasPerm(perms, Perm.KickMembers) || hasPerm(perms, Perm.ManageNicknames);
  const nav: { id: Section; label: string; show: boolean }[] = [
    { id: 'overview', label: 'Perfil do servidor', show: canServer },
    { id: 'tag', label: 'Tag do servidor', show: canServer },
    { id: 'roles', label: 'Cargos', show: canRoles },
    { id: 'members', label: 'Membros', show: canMembers },
    { id: 'notes', label: 'Notas e Atualizações', show: canServer },
    { id: 'sounds', label: 'Painel de efeitos sonoros', show: canSounds },
    { id: 'music', label: 'Personalizar', show: canAgent },
    { id: 'replies', label: 'Respostas inteligentes', show: canAgent },
    { id: 'commands', label: 'Comandos', show: canAgent },
  ];
  const visible = nav.filter((n) => n.show);
  const [section, setSection] = useState<Section>(initial && visible.some((n) => n.id === initial) ? initial : (visible[0]?.id ?? 'members'));
  const [editing, setEditing] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !(e.target as HTMLElement).closest?.('input,textarea') && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!server) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-label="Configurações do servidor"
        onMouseDown={(e) => e.stopPropagation()}
        className="relative flex h-full max-h-[880px] w-full max-w-[1280px] overflow-hidden rounded-2xl border border-edge bg-main shadow-2xl"
      >
        <aside className="w-60 shrink-0 overflow-y-auto border-r border-edge bg-side p-3">
          <p className="truncate px-3 pt-2 pb-1 text-xs font-bold tracking-wide text-muted uppercase">{server.name}</p>
          <nav className="flex flex-col gap-0.5">
            {visible.map((n) => (
              <Fragment key={n.id}>
              {n.id === 'sounds' && <p className="px-3 pt-4 pb-1 text-xs font-bold tracking-wide text-muted uppercase">Expressões</p>}
              {n.id === 'music' && <p className="px-3 pt-4 pb-1 text-xs font-bold tracking-wide text-muted uppercase">Agente</p>}
              <button
                onClick={() => {
                  setSection(n.id);
                  setEditing(null);
                }}
                className={cx(
                  'rounded-lg px-3 py-2 text-left text-sm font-medium',
                  section === n.id ? 'bg-hover text-fg' : 'text-soft hover:bg-hover/60 hover:text-fg',
                )}
              >
                {n.label}
              </button>
              </Fragment>
            ))}
          </nav>
          {visible.length === 0 && <p className="px-3 py-2 text-sm text-muted">Você não tem permissão para mudar nada aqui.</p>}
        </aside>

        <main className="min-w-0 flex-1 overflow-y-auto px-10 py-8">
          {isOwner && server.isPublic && !server.rating && (
            <div className="mb-6 flex max-w-2xl items-center gap-4 rounded-xl border border-amber-400/40 bg-amber-400/10 p-4 max-md:flex-col max-md:items-start">
              <Icons.Warning size={22} className="shrink-0 text-amber-400" />
              <div className="min-w-0 flex-1 text-sm">
                <p className="font-semibold">Seu servidor está sem classificação indicativa</p>
                <p className="mt-0.5 text-soft">
                  Servidores públicos sem classificação indicativa não aparecem em Explorar. Escolha uma para a comunidade encontrar o seu servidor.
                </p>
              </div>
              <Button
                className="shrink-0"
                onClick={() => {
                  setSection('overview');
                  setEditing(null);
                  setTimeout(() => document.getElementById('server-rating')?.scrollIntoView({ behavior: 'smooth', block: 'center' }), 50);
                }}
              >
                Configurar
              </Button>
            </div>
          )}
          {section === 'overview' && canServer && (
            <div className="max-w-2xl">
              <h2 className="mb-5 text-xl font-bold">Perfil do servidor</h2>
              <ServerOverview serverId={serverId} onClose={onClose} />
            </div>
          )}
          {section === 'tag' && canServer && <ServerTagSettings serverId={serverId} />}
          {section === 'roles' && canRoles && !editing && <RolesList serverId={serverId} onEdit={setEditing} />}
          {section === 'roles' && canRoles && editing && (
            <RoleEditor serverId={serverId} roleId={editing} onSelect={setEditing} onBack={() => setEditing(null)} />
          )}
          {section === 'members' && canMembers && <MembersSection serverId={serverId} />}
          {section === 'notes' && canServer && <NotesSettings serverId={serverId} />}
          {section === 'sounds' && canSounds && <SoundboardSettings serverId={serverId} />}
          {section === 'music' && canAgent && <MusicSettings serverId={serverId} />}
          {section === 'replies' && canAgent && <SmartReplies serverId={serverId} />}
          {section === 'commands' && canAgent && <AgentCommands serverId={serverId} />}
        </main>

        <button
          onClick={onClose}
          title="Fechar (Esc)"
          className="absolute top-5 right-5 flex h-9 w-9 items-center justify-center rounded-full border border-edge text-muted hover:text-fg"
        >
          <Icons.X size={18} />
        </button>
      </div>
    </div>
  );
}

// ---------- lista de cargos ----------

function RoleBadge({ color, size = 20 }: { color: string | null; size?: number }) {
  return (
    <span className="flex shrink-0" style={{ color: color ?? DEFAULT_ROLE_COLOR }}>
      <Icons.Shield size={size} />
    </span>
  );
}

function RolesList({ serverId, onEdit }: { serverId: string; onEdit: (id: string) => void }) {
  const roles = useLine((s) => s.roles[serverId]) ?? [];
  const myTop = useLine((s) => topPosition(s, serverId, s.me?.id));
  const [query, setQuery] = useState('');
  const [menu, setMenu] = useState<string | null>(null);
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const { error, run } = useErr();

  const everyone = roles.find((r) => r.id === serverId);
  const list = roles.filter((r) => r.id !== serverId);
  const q = query.trim().toLowerCase();
  const shown = q ? list.filter((r) => r.name.toLowerCase().includes(q)) : list;

  const create = () =>
    run(async () => {
      const role = await api.createRole(serverId, { name: 'novo cargo' });
      onEdit(role.id);
    });

  const drop = (targetId: string) => {
    if (!drag || drag === targetId) return;
    const ids = list.map((r) => r.id);
    const from = ids.indexOf(drag);
    const to = ids.indexOf(targetId);
    ids.splice(from, 1);
    ids.splice(to, 0, drag);
    // Mostra a nova ordem na hora; o servidor confirma com roles:update.
    const byId = Object.fromEntries(list.map((r) => [r.id, r]));
    actions.setRoles(serverId, [...ids.map((id, i) => ({ ...byId[id]!, position: ids.length - i })), ...(everyone ? [everyone] : [])]);
    void run(() => api.reorderRoles(serverId, ids)).then(() => {
      /* em caso de erro o servidor manda a ordem certa de volta no próximo evento */
    });
  };

  return (
    <div className="max-w-3xl">
      <h2 className="text-xl font-bold">Cargos</h2>
      <p className="mt-1 text-sm text-soft">Use cargos para agrupar os membros do servidor e dar permissões.</p>

      {everyone && (
        <button
          onClick={() => onEdit(everyone.id)}
          className="mt-5 flex w-full items-center gap-3 rounded-xl border border-edge bg-side px-4 py-3.5 text-left hover:bg-hover"
        >
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-rail">
            <Icons.Users size={18} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block font-semibold">Permissões padrão</span>
            <span className="block text-xs text-muted">@todos · vale para todos os membros do servidor (mencione @todos para notificar todos)</span>
          </span>
          <Icons.Chevron size={18} className="-rotate-90 text-muted" />
        </button>
      )}

      <div className="mt-6 flex gap-3">
        <label className="flex flex-1 items-center gap-2 rounded-lg border border-edge bg-rail px-3 focus-within:border-accent">
          <Icons.Search size={16} className="text-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar cargos"
            className="h-10 min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted"
          />
        </label>
        <Button onClick={() => void create()}>Criar cargo</Button>
      </div>
      <p className="mt-2 text-xs text-muted">
        Os membros usam a cor do cargo mais alto que eles têm nesta lista. Arraste os cargos para reordenar.
      </p>
      <ErrorText>{error}</ErrorText>

      <div className="mt-6 flex items-center border-b border-edge pb-2 text-xs font-bold text-muted uppercase">
        <span className="flex-1">Cargos · {list.length}</span>
        <span className="w-28 text-center">Membros</span>
        <span className="w-24" />
      </div>
      {shown.length === 0 && (
        <p className="py-6 text-center text-sm text-muted">{q ? 'Nenhum cargo encontrado.' : 'Ainda não há cargos. Crie o primeiro!'}</p>
      )}
      {shown.map((r) => {
        const locked = r.position >= myTop;
        return (
          <div
            key={r.id}
            draggable={!locked && !q}
            onDragStart={() => setDrag(r.id)}
            onDragEnd={() => {
              setDrag(null);
              setOver(null);
            }}
            onDragOver={(e) => {
              if (!drag || locked) return;
              e.preventDefault();
              setOver(r.id);
            }}
            onDrop={(e) => {
              e.preventDefault();
              drop(r.id);
              setOver(null);
            }}
            className={cx(
              'group relative flex items-center border-b border-edge py-2.5',
              over === r.id && drag !== r.id && 'border-t-2 border-t-accent',
              drag === r.id && 'opacity-50',
            )}
          >
            <span className={cx('w-6 text-muted', locked || q ? 'invisible' : 'cursor-grab opacity-0 group-hover:opacity-100')}>
              <Icons.Grip size={16} />
            </span>
            <span className="flex min-w-0 flex-1 items-center gap-2.5">
              <RoleBadge color={r.color} />
              <span className="truncate font-medium">{r.name}</span>
              {locked && <Icons.Lock size={13} className="shrink-0 text-muted" />}
            </span>
            <span className="flex w-28 items-center justify-center gap-1 text-sm text-soft">
              {r.memberCount} <Icons.User size={14} className="text-muted" />
            </span>
            <span className="flex w-24 justify-end gap-2">
              <button
                disabled={locked}
                title={locked ? 'Esse cargo está acima do seu' : 'Editar cargo'}
                onClick={() => onEdit(r.id)}
                className="flex h-9 w-9 items-center justify-center rounded-lg border border-edge bg-side text-soft hover:text-fg disabled:opacity-40"
              >
                <Icons.Edit size={15} />
              </button>
              <span className="relative">
                <button
                  disabled={locked}
                  onClick={() => setMenu(menu === r.id ? null : r.id)}
                  className="flex h-9 w-9 items-center justify-center rounded-lg border border-edge bg-side text-soft hover:text-fg disabled:opacity-40"
                >
                  <Icons.More size={15} />
                </button>
                {menu === r.id && (
                  <RoleMenu
                    role={r}
                    onClose={() => setMenu(null)}
                    onEdit={() => onEdit(r.id)}
                    onError={(m) => void run(async () => Promise.reject(new Error(m)))}
                  />
                )}
              </span>
            </span>
          </div>
        );
      })}
    </div>
  );
}

function RoleMenu({ role, onClose, onEdit, onError }: { role: Role; onClose: () => void; onEdit: () => void; onError: (m: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const off = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && onClose();
    window.addEventListener('mousedown', off);
    return () => window.removeEventListener('mousedown', off);
  }, [onClose]);
  return (
    <div ref={ref} className="absolute top-full right-0 z-20 mt-1 w-48 rounded-lg border border-edge bg-rail p-1.5 shadow-2xl">
      <button onClick={onEdit} className="w-full rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-hover">
        Editar cargo
      </button>
      <button
        onClick={async () => {
          onClose();
          if (!(await confirmDialog({ title: `Excluir o cargo ${role.name}`, message: 'Quem tem esse cargo perde as permissões dele.', confirmLabel: 'Excluir', danger: true }))) return;
          api.deleteRole(role.id).catch((e: Error) => onError(e.message));
        }}
        className="w-full rounded-md px-2.5 py-1.5 text-left text-sm text-danger hover:bg-danger hover:text-white"
      >
        Excluir cargo
      </button>
    </div>
  );
}

// ---------- edição de um cargo ----------

type Tab = 'display' | 'perms' | 'members';

function Toggle({ on, onChange, disabled }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={cx('relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-40', on ? 'bg-accent' : 'bg-edge')}
    >
      <span className={cx('absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all', on ? 'left-[22px]' : 'left-0.5')} />
    </button>
  );
}

function RoleEditor({ serverId, roleId, onSelect, onBack }: { serverId: string; roleId: string; onSelect: (id: string) => void; onBack: () => void }) {
  const roles = useLine((s) => s.roles[serverId]) ?? [];
  const myPerms = useLine((s) => permsOf(s, serverId, s.me?.id));
  const myTop = useLine((s) => topPosition(s, serverId, s.me?.id));
  const role = roles.find((r) => r.id === roleId);
  const isEveryone = roleId === serverId;
  const [tab, setTab] = useState<Tab>(isEveryone ? 'perms' : 'display');
  const [draft, setDraft] = useState(() => ({
    name: role?.name ?? '',
    color: role?.color ?? null,
    permissions: role?.permissions ?? 0,
    mentionable: role?.mentionable ?? false,
    hoist: role?.hoist ?? false,
  }));
  const [saving, setSaving] = useState(false);
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const { error, run } = useErr();

  /** Arrastou um cargo na coluna da esquerda: grava a nova ordem (é a ordem da lista de membros). */
  const dropOn = (targetId: string) => {
    if (!drag || drag === targetId) return;
    const everyone = roles.find((r) => r.id === serverId);
    const list = roles.filter((r) => r.id !== serverId);
    const ids = list.map((r) => r.id);
    ids.splice(ids.indexOf(drag), 1);
    ids.splice(ids.indexOf(targetId) + (list.findIndex((r) => r.id === targetId) > list.findIndex((r) => r.id === drag) ? 1 : 0), 0, drag);
    const byId = Object.fromEntries(list.map((r) => [r.id, r]));
    actions.setRoles(serverId, [...ids.map((id, i) => ({ ...byId[id]!, position: ids.length - i })), ...(everyone ? [everyone] : [])]);
    void run(() => api.reorderRoles(serverId, ids));
  };

  // Trocou de cargo na coluna da esquerda: recomeça o rascunho.
  useEffect(() => {
    const r = useLine.getState().roles[serverId]?.find((x) => x.id === roleId);
    setDraft({ name: r?.name ?? '', color: r?.color ?? null, permissions: r?.permissions ?? 0, mentionable: r?.mentionable ?? false, hoist: r?.hoist ?? false });
    setTab(roleId === serverId ? 'perms' : (t) => (t === 'perms' || t === 'members' ? t : 'display'));
  }, [roleId, serverId]);

  if (!role) {
    return (
      <div>
        <button onClick={onBack} className="flex items-center gap-2 font-semibold text-soft hover:text-fg">
          <Icons.ArrowLeft size={18} /> Voltar
        </button>
        <p className="mt-6 text-sm text-muted">Esse cargo não existe mais.</p>
      </div>
    );
  }

  const dirty =
    draft.name !== role.name || draft.color !== role.color || draft.permissions !== role.permissions || draft.mentionable !== role.mentionable || draft.hoist !== (role.hoist ?? false);

  const save = () =>
    run(async () => {
      setSaving(true);
      try {
        await api.updateRole(
          role.id,
          isEveryone
            ? { permissions: draft.permissions }
            : { name: draft.name.trim(), color: draft.color, permissions: draft.permissions, mentionable: draft.mentionable, hoist: draft.hoist },
        );
      } finally {
        setSaving(false);
      }
    });

  const reset = () => setDraft({ name: role.name, color: role.color, permissions: role.permissions, mentionable: role.mentionable, hoist: role.hoist ?? false });

  const tabs: { id: Tab; label: string }[] = isEveryone
    ? [{ id: 'perms', label: 'Permissões' }]
    : [
        { id: 'display', label: 'Exibição' },
        { id: 'perms', label: 'Permissões' },
        { id: 'members', label: `Gerenciar membros (${role.memberCount})` },
      ];

  return (
    <div className="-my-8 -ml-10 flex min-h-full">
      {/* coluna com os cargos */}
      <div className="w-56 shrink-0 border-r border-edge py-8 pr-3 pl-6">
        <div className="mb-4 flex items-center justify-between">
          <button onClick={onBack} className="flex items-center gap-2 font-semibold text-soft hover:text-fg">
            <Icons.ArrowLeft size={18} /> Voltar
          </button>
          <button
            title="Criar cargo"
            onClick={() => void run(async () => onSelect((await api.createRole(serverId, { name: 'novo cargo' })).id))}
            className="text-muted hover:text-fg"
          >
            <Icons.Plus size={18} />
          </button>
        </div>
        <div className="space-y-0.5">
          {roles.map((r) => {
            const movable = r.id !== serverId && r.position < myTop;
            return (
            <button
              key={r.id}
              disabled={r.id !== serverId && r.position >= myTop}
              onClick={() => onSelect(r.id)}
              draggable={movable}
              onDragStart={() => setDrag(r.id)}
              onDragEnd={() => {
                setDrag(null);
                setOver(null);
              }}
              onDragOver={(e) => {
                if (!drag || !movable) return;
                e.preventDefault();
                setOver(r.id);
              }}
              onDrop={(e) => {
                e.preventDefault();
                dropOn(r.id);
                setDrag(null);
                setOver(null);
              }}
              className={cx(
                'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm disabled:opacity-50',
                r.id === roleId ? 'bg-hover text-fg' : 'text-soft hover:bg-hover/60',
                movable && 'cursor-grab active:cursor-grabbing',
                over === r.id && drag !== r.id && 'ring-1 ring-accent',
                drag === r.id && 'opacity-40',
              )}
            >
              <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: r.color ?? DEFAULT_ROLE_COLOR }} />
              <span className="truncate">{r.name}</span>
            </button>
            );
          })}
        </div>
        <p className="mt-3 px-2 text-xs text-muted">Arraste para reordenar. A ordem vale para a lista de membros.</p>
      </div>

      <div className="min-w-0 flex-1 py-8 pr-16 pl-8">
        <h2 className="truncate text-lg font-bold">Editar cargo · {isEveryone ? '@todos' : role.name}</h2>
        <div className="mt-5 flex gap-6 border-b border-edge">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={cx(
                '-mb-px border-b-2 pb-2.5 text-sm font-medium',
                tab === t.id ? 'border-accent text-accent' : 'border-transparent text-soft hover:text-fg',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="max-w-2xl pt-6 pb-24">
          {tab === 'display' && !isEveryone && (
            <div className="space-y-6">
              <label className="block">
                <span className="mb-2 block text-sm font-semibold">
                  Nome do cargo <span className="text-danger">*</span>
                </span>
                <EmojiInput value={draft.name} maxLength={100} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
              </label>
              <div className="border-t border-edge pt-6">
                <p className="text-sm font-semibold">
                  Cor do cargo <span className="text-danger">*</span>
                </p>
                <p className="mt-1 text-sm text-muted">Os membros usam a cor do cargo mais alto que possuem na lista de cargos.</p>
                <div className="mt-3 flex gap-3">
                  <button
                    title="Sem cor"
                    onClick={() => setDraft({ ...draft, color: null })}
                    className={cx(
                      'flex h-14 w-16 items-center justify-center rounded-lg',
                      draft.color === null && 'ring-2 ring-fg',
                    )}
                    style={{ background: DEFAULT_ROLE_COLOR }}
                  >
                    {draft.color === null && <Icons.Check size={22} className="text-white" />}
                  </button>
                  <ColorPicker
                    title="Cor personalizada"
                    className={cx(
                      'relative flex h-14 w-16 cursor-pointer items-start justify-end rounded-lg border border-edge p-1',
                      draft.color && !ROLE_COLORS.includes(draft.color) && 'ring-2 ring-fg',
                    )}
                    style={{ background: draft.color && !ROLE_COLORS.includes(draft.color) ? draft.color : 'var(--color-rail)' }}
                    value={draft.color ?? '#ffffff'}
                    onChange={(c) => setDraft({ ...draft, color: c })}
                  >
                    <Icons.Edit size={12} className="text-white mix-blend-difference" />
                  </ColorPicker>
                  <div className="grid grid-cols-10 gap-1.5">
                    {ROLE_COLORS.map((c) => (
                      <button
                        key={c}
                        title={c}
                        onClick={() => setDraft({ ...draft, color: c })}
                        className={cx('h-6 w-6 rounded', draft.color === c && 'ring-2 ring-fg ring-offset-1 ring-offset-main')}
                        style={{ background: c }}
                      />
                    ))}
                  </div>
                </div>
              </div>
              <div className="flex items-start justify-between gap-6 border-t border-edge pt-6">
                <div>
                  <p className="font-semibold">Permitir que qualquer um @mencione este cargo</p>
                  <p className="mt-1 text-sm text-muted">
                    Quem tem a permissão “Mencionar @todos, @aqui e todos os cargos” sempre consegue mencionar este cargo.
                  </p>
                </div>
                <Toggle on={draft.mentionable} onChange={(v) => setDraft({ ...draft, mentionable: v })} />
              </div>
              <div className="flex items-start justify-between gap-6 border-t border-edge pt-6">
                <div>
                  <p className="font-semibold">Exibir membros do cargo separadamente dos membros online</p>
                  <p className="mt-1 text-sm text-muted">
                    Quem tem este cargo aparece numa seção própria na lista de membros, na ordem dos cargos do servidor.
                  </p>
                </div>
                <Toggle on={draft.hoist} onChange={(v) => setDraft({ ...draft, hoist: v })} />
              </div>
              <div className="rounded-xl border border-edge bg-side p-4">
                <p className="mb-2 text-xs font-bold text-muted uppercase">Prévia</p>
                <p className="font-semibold" style={{ color: draft.color ?? undefined }}>
                  {draft.name || 'novo cargo'}
                </p>
                <p className="text-sm text-soft">Assim fica o nome de quem tem este como cargo mais alto.</p>
              </div>
            </div>
          )}

          {tab === 'perms' && (
            <PermissionsTab
              value={draft.permissions}
              mine={myPerms}
              onChange={(permissions) => setDraft({ ...draft, permissions })}
            />
          )}

          {tab === 'members' && !isEveryone && <RoleMembers serverId={serverId} role={role} />}
          <ErrorText>{error}</ErrorText>
        </div>

        {dirty && (
          <div className="sticky bottom-6 flex max-w-2xl items-center gap-3 rounded-xl border border-edge bg-rail px-4 py-3 shadow-2xl">
            <span className="flex-1 text-sm font-medium">Cuidado, você tem alterações que não foram salvas!</span>
            <Button variant="ghost" onClick={reset}>
              Redefinir
            </Button>
            <Button disabled={saving || (!isEveryone && !draft.name.trim())} onClick={() => void save()}>
              {saving ? 'Salvando…' : 'Salvar alterações'}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function PermissionsTab({ value, mine, onChange }: { value: number; mine: number; onChange: (v: number) => void }) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const groups = PERMISSION_GROUPS.map((g) => ({
    ...g,
    items: q ? g.items.filter((i) => `${i.name} ${i.hint}`.toLowerCase().includes(q)) : g.items,
  })).filter((g) => g.items.length);

  return (
    <div>
      <label className="flex items-center gap-2 rounded-lg border border-edge bg-rail px-3 focus-within:border-accent">
        <Icons.Search size={16} className="text-muted" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar permissões"
          className="h-10 min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted"
        />
      </label>
      {groups.map((g, gi) => (
        <section key={g.title} className="mt-7">
          <div className="mb-1 flex items-baseline justify-between">
            <h3 className="text-lg font-bold">{g.title}</h3>
            {gi === 0 && (
              <button
                onClick={() => onChange(value & ~mine)}
                className="text-sm font-medium text-accent hover:underline"
              >
                Limpar permissões
              </button>
            )}
          </div>
          {g.items.map((item) => {
            const on = hasPerm(value, item.flag);
            const allowed = hasPerm(mine, item.flag);
            return (
              <div key={item.flag} className="flex items-start justify-between gap-6 border-b border-edge py-4">
                <div>
                  <p className="font-semibold">{item.name}</p>
                  <p className="mt-1 text-sm text-muted">{item.hint}</p>
                  {!allowed && <p className="mt-1 text-xs text-sun">Você não tem esta permissão, então não pode mudá-la.</p>}
                </div>
                <Toggle on={on} disabled={!allowed} onChange={(v) => onChange(v ? value | item.flag : value & ~item.flag)} />
              </div>
            );
          })}
        </section>
      ))}
      {groups.length === 0 && <p className="mt-6 text-sm text-muted">Nenhuma permissão encontrada.</p>}
    </div>
  );
}

function RoleMembers({ serverId, role }: { serverId: string; role: Role }) {
  const members = useLine((s) => s.members[serverId]);
  const users = useLine((s) => s.users);
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);
  const { error, run } = useErr();
  const all = Object.values(members ?? {});
  const withRole = all.filter((m) => m.roleIds.includes(role.id));
  const without = all.filter((m) => !m.roleIds.includes(role.id));
  const q = query.trim().toLowerCase();
  const name = (id: string) => displayNameIn(useLine.getState(), serverId, id);
  const filter = (list: typeof all) =>
    q ? list.filter((m) => `${name(m.userId)} ${users[m.userId]?.username ?? ''}`.toLowerCase().includes(q)) : list;

  const row = (userId: string, action: ReactNode) => {
    const u = users[userId];
    if (!u) return null;
    return (
      <div key={userId} className="flex items-center gap-3 rounded-md px-2 py-2 hover:bg-hover">
        <Avatar name={u.displayName} color={u.avatarColor} src={u.avatarUrl} size={32} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold">{name(userId)}</span>
          <span className="block truncate text-xs text-muted">{u.bot ? 'Agente' : u.username}</span>
        </span>
        {action}
      </div>
    );
  };

  return (
    <div>
      <div className="flex gap-3">
        <label className="flex flex-1 items-center gap-2 rounded-lg border border-edge bg-rail px-3 focus-within:border-accent">
          <Icons.Search size={16} className="text-muted" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={adding ? 'Buscar membros para adicionar' : 'Buscar membros'}
            className="h-10 min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted"
          />
        </label>
        <Button variant={adding ? 'ghost' : undefined} onClick={() => setAdding((v) => !v)}>
          {adding ? 'Concluir' : 'Adicionar membros'}
        </Button>
      </div>
      <ErrorText>{error}</ErrorText>
      <div className="mt-4 space-y-0.5">
        {adding
          ? filter(without).map((m) =>
              row(
                m.userId,
                <Button onClick={() => void run(() => api.setMemberRole(serverId, m.userId, role.id, true))}>Adicionar</Button>,
              ),
            )
          : filter(withRole).map((m) =>
              row(
                m.userId,
                <button
                  title="Remover do cargo"
                  onClick={() => void run(() => api.setMemberRole(serverId, m.userId, role.id, false))}
                  className="flex h-8 w-8 items-center justify-center rounded-full text-muted hover:bg-danger hover:text-white"
                >
                  <Icons.X size={16} />
                </button>,
              ),
            )}
        {!adding && withRole.length === 0 && (
          <p className="py-6 text-center text-sm text-muted">Ninguém tem este cargo ainda. Use “Adicionar membros”.</p>
        )}
        {adding && without.length === 0 && <p className="py-6 text-center text-sm text-muted">Todos os membros já têm este cargo.</p>}
      </div>
    </div>
  );
}

// ---------- membros ----------

function MembersSection({ serverId }: { serverId: string }) {
  const server = useLine((s) => s.servers[serverId]);
  const members = useLine((s) => s.members[serverId]);
  const users = useLine((s) => s.users);
  const roles = useLine((s) => s.roles[serverId]) ?? [];
  const meId = useLine((s) => s.me?.id);
  const perms = useLine((s) => permsOf(s, serverId, s.me?.id));
  const myTop = useLine((s) => topPosition(s, serverId, s.me?.id));
  const [query, setQuery] = useState('');
  const [picker, setPicker] = useState<string | null>(null);
  const [nick, setNick] = useState<string | null>(null);
  const { error, run } = useErr();

  const canRoles = hasPerm(perms, Perm.ManageRoles);
  const canKick = hasPerm(perms, Perm.KickMembers);
  const canNick = hasPerm(perms, Perm.ManageNicknames);
  const roleById = useMemo(() => Object.fromEntries(roles.map((r) => [r.id, r])), [roles]);
  const all = Object.values(members ?? {});
  const q = query.trim().toLowerCase();
  const st = useLine.getState();
  const shown = all
    .filter((m) => users[m.userId])
    .filter((m) => !q || `${displayNameIn(st, serverId, m.userId)} ${users[m.userId]!.username}`.toLowerCase().includes(q))
    .sort((a, b) => displayNameIn(st, serverId, a.userId).localeCompare(displayNameIn(st, serverId, b.userId)));

  if (!server) return null;

  return (
    <div className="max-w-3xl">
      <h2 className="text-xl font-bold">Membros</h2>
      <p className="mt-1 text-sm text-soft">{all.length} membros neste servidor.</p>
      <label className="mt-5 flex items-center gap-2 rounded-lg border border-edge bg-rail px-3 focus-within:border-accent">
        <Icons.Search size={16} className="text-muted" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Buscar membros"
          className="h-10 min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted"
        />
      </label>
      <ErrorText>{error}</ErrorText>
      {nick && <NicknameDialog serverId={serverId} userId={nick} onClose={() => setNick(null)} />}
      <div className="mt-4">
        {shown.map((m) => {
          const u = users[m.userId]!;
          const isOwner = m.userId === server.ownerId;
          const below = !isOwner && topPosition(st, serverId, m.userId) < myTop;
          const assignable = roles.filter((r) => r.id !== serverId && r.position < myTop && !m.roleIds.includes(r.id));
          return (
            <div key={m.userId} className="flex items-start gap-3 border-b border-edge py-3">
              <Avatar name={u.displayName} color={u.avatarColor} src={u.avatarUrl} size={36} />
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-1.5 truncate font-semibold">
                  {displayNameIn(st, serverId, m.userId)}
                  {isOwner && <span className="rounded bg-sun/20 px-1.5 text-[10px] font-bold text-sun uppercase">Dono</span>}
                  <span className="text-xs font-normal text-muted">{u.bot ? 'Agente' : u.username}</span>
                </p>
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  {m.roleIds.map((rid) => {
                    const r = roleById[rid];
                    if (!r) return null;
                    const removable = canRoles && r.position < myTop;
                    return (
                      <span key={rid} className="flex items-center gap-1 rounded-full border border-edge bg-side py-0.5 pr-2 pl-1.5 text-xs">
                        <span className="h-2.5 w-2.5 rounded-full" style={{ background: r.color ?? DEFAULT_ROLE_COLOR }} />
                        {r.name}
                        {removable && (
                          <button
                            title="Tirar cargo"
                            onClick={() => void run(() => api.setMemberRole(serverId, m.userId, rid, false))}
                            className="text-muted hover:text-danger"
                          >
                            <Icons.X size={12} />
                          </button>
                        )}
                      </span>
                    );
                  })}
                  {canRoles && assignable.length > 0 && (
                    <span className="relative">
                      <button
                        title="Dar cargo"
                        onClick={() => setPicker(picker === m.userId ? null : m.userId)}
                        className="flex h-6 w-6 items-center justify-center rounded-full border border-edge bg-side text-muted hover:text-fg"
                      >
                        <Icons.Plus size={13} />
                      </button>
                      {picker === m.userId && (
                        <div className="absolute top-full left-0 z-20 mt-1 max-h-60 w-52 overflow-y-auto rounded-lg border border-edge bg-rail p-1.5 shadow-2xl">
                          {assignable.map((r) => (
                            <button
                              key={r.id}
                              onClick={() => {
                                setPicker(null);
                                void run(() => api.setMemberRole(serverId, m.userId, r.id, true));
                              }}
                              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-hover"
                            >
                              <span className="h-3 w-3 rounded-full" style={{ background: r.color ?? DEFAULT_ROLE_COLOR }} />
                              <span className="truncate">{r.name}</span>
                            </button>
                          ))}
                        </div>
                      )}
                    </span>
                  )}
                </div>
              </div>
              <div className="flex shrink-0 gap-2">
                {(m.userId === meId || (canNick && below)) && (
                  <button
                    onClick={() => setNick(m.userId)}
                    className="rounded-md border border-edge px-2.5 py-1 text-xs text-soft hover:text-fg"
                  >
                    Apelido
                  </button>
                )}
                {canKick && below && m.userId !== meId && (
                  <button
                    onClick={async () => {
                      if (await confirmDialog({ title: `Expulsar ${displayNameIn(st, serverId, m.userId)}`, message: 'A pessoa sai do servidor, mas pode voltar com um convite.', confirmLabel: 'Expulsar', danger: true })) void run(() => api.kick(serverId, m.userId));
                    }}
                    className="rounded-md border border-edge px-2.5 py-1 text-xs text-danger hover:bg-danger hover:text-white"
                  >
                    Expulsar
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Apelido no servidor: vale só aqui; vazio volta para o nome de exibição. */
export function NicknameDialog({ serverId, userId, onClose }: { serverId: string; userId: string; onClose: () => void }) {
  const current = useLine((s) => s.members[serverId]?.[userId]?.nickname ?? '');
  const user = useLine((s) => s.users[userId]);
  const isMe = useLine((s) => s.me?.id === userId);
  const [value, setValue] = useState(current);
  const [busy, setBusy] = useState(false);
  const { error, run } = useErr();
  const save = (nickname: string | null) =>
    run(async () => {
      setBusy(true);
      try {
        await api.setNickname(serverId, userId, nickname);
        onClose();
      } finally {
        setBusy(false);
      }
    });
  return (
    <Modal
      title={isMe ? 'Alterar apelido' : `Apelido de ${user?.displayName ?? 'membro'}`}
      subtitle="O apelido aparece só neste servidor: no chat, na lista de membros, na voz e nas menções."
      onClose={onClose}
      footer={
        <>
          {current && (
            <Button variant="ghost" className="mr-auto" disabled={busy} onClick={() => void save(null)}>
              Redefinir apelido
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button disabled={busy} onClick={() => void save(value.trim() || null)}>
            Salvar
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save(value.trim() || null);
        }}
      >
        <label className="mb-2 block text-sm font-semibold">Apelido</label>
        <EmojiInput autoFocus value={value} maxLength={32} placeholder={user?.displayName} onChange={(e) => setValue(e.target.value)} />
        <ErrorText>{error}</ErrorText>
      </form>
    </Modal>
  );
}

// ---------- Notas e Atualizações ----------

const NOTES_HINTS: Record<string, string> = {
  rules: 'As regras do servidor. Só quem pode publicar escreve; os outros leem e reagem.',
  announcements: 'Novidades e avisos importantes para todo mundo.',
  events: 'O que vem por aí: encontros, campeonatos, lives.',
  activity: 'Quem está jogando agora e o que rolou nas últimas 24 horas.',
};

/** Mostrar/esconder a categoria base e cada canal dela. Escondido = só dono e administradores veem. */
function NotesSettings({ serverId }: { serverId: string }) {
  const category = useLine((s) => Object.values(s.categories).find((c) => c.serverId === serverId && c.base));
  const allChannels = useLine((s) => s.channels);
  const channels = useMemo(
    () =>
      Object.values(allChannels)
        .filter((c) => c.serverId === serverId && c.base)
        .sort((a, b) => a.position - b.position),
    [allChannels, serverId],
  );
  const [error, setError] = useState('');
  const save = (body: { categoryVisible?: boolean; channels?: Record<string, boolean> }) => {
    setError('');
    api.setNotes(serverId, body).catch((e: Error) => setError(e.message));
  };

  return (
    <div className="max-w-2xl">
      <h2 className="text-xl font-bold">Notas e Atualizações</h2>
      <p className="mt-1 mb-6 text-sm text-muted">
        Canais fixos do servidor. Por padrão todo mundo vê, mas só você e quem tem a permissão <strong className="text-soft">Publicar em Notas e Atualizações</strong>{' '}
        escreve neles. Escondido, só você e os administradores enxergam.
      </p>
      {!category ? (
        <p className="text-sm text-muted">Carregando…</p>
      ) : (
        <>
          <div className="flex items-center gap-4 rounded-xl border border-edge bg-rail/60 p-4">
            <Icons.Folder size={20} className="shrink-0 text-muted" />
            <div className="min-w-0 flex-1">
              <p className="font-semibold">Mostrar a categoria “{category.name}”</p>
              <p className="text-sm text-muted">Desligada, a categoria inteira some da lista de canais dos membros.</p>
            </div>
            <Toggle on={!category.isPrivate} onChange={(v) => save({ categoryVisible: v })} />
          </div>
          <div className={cx('mt-3 space-y-2', category.isPrivate && 'opacity-50')}>
            {channels.map((c) => {
              const I = channelIcon(c);
              return (
                <div key={c.id} className="flex items-center gap-4 rounded-xl border border-edge p-4">
                  <I size={20} className="shrink-0 text-muted" />
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">{c.name}</p>
                    <p className="text-sm text-muted">{NOTES_HINTS[c.base!]}</p>
                  </div>
                  <Toggle on={!c.isPrivate} onChange={(v) => save({ channels: { [c.id]: v } })} />
                </div>
              );
            })}
          </div>
          <p className="mt-4 text-xs text-muted">
            Para dar a permissão de publicar, vá em Cargos e ligue <strong>Publicar em Notas e Atualizações</strong> no cargo que quiser.
          </p>
        </>
      )}
      <ErrorText>{error}</ErrorText>
    </div>
  );
}
