'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { logout } from '@/lib/session';
import { actions, useLine } from '@/lib/store';
import { ProfileEditor } from './ProfileEditor';
import { Avatar, Button, cx, ErrorText, Field, Icons, Input } from './ui';
import { VoiceSettingsPanel } from './Voice';

type Section = 'account' | 'profile' | 'voice';

const NAV: { id: Section; label: string; icon: ReactNode; keywords: string }[] = [
  { id: 'account', label: 'Minha conta', icon: <Icons.User size={18} />, keywords: 'conta usuário email senha segurança' },
  { id: 'profile', label: 'Perfil', icon: <Icons.Edit size={18} />, keywords: 'perfil nome exibição status bio cor avatar' },
  { id: 'voice', label: 'Voz e vídeo', icon: <Icons.Mic size={18} />, keywords: 'voz vídeo microfone áudio saída ruído' },
];

/** Configurações do usuário em tela cheia: navegação à esquerda, conteúdo à direita. */
export function SettingsModal({ onClose }: { onClose: () => void }) {
  const me = useLine((s) => s.me);
  const [section, setSection] = useState<Section>('account');
  const [query, setQuery] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!me) return null;
  const q = query.trim().toLowerCase();
  const nav = q ? NAV.filter((n) => `${n.label} ${n.keywords}`.toLowerCase().includes(q)) : NAV;
  const title = NAV.find((n) => n.id === section)!.label;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-label="Configurações"
        onMouseDown={(e) => e.stopPropagation()}
        className="flex h-full max-h-[860px] w-full max-w-[1280px] overflow-hidden rounded-2xl border border-edge bg-main shadow-2xl"
      >
        <aside className="flex w-64 shrink-0 flex-col gap-3 overflow-y-auto border-r border-edge bg-side p-3">
          <button onClick={() => setSection('profile')} className="flex items-center gap-3 rounded-lg p-2 text-left hover:bg-hover">
            <Avatar name={me.displayName} color={me.avatarColor} src={me.avatarUrl} size={44} />
            <div className="min-w-0">
              <p className="truncate font-semibold">{me.displayName}</p>
              <p className="flex items-center gap-1 text-xs text-muted">
                Editar perfil <Icons.Edit size={12} />
              </p>
            </div>
          </button>

          <label className="flex items-center gap-2 rounded-lg border border-edge bg-rail px-3 py-2 text-sm text-muted focus-within:border-accent">
            <Icons.Search size={16} />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar"
              className="min-w-0 flex-1 bg-transparent text-fg outline-none placeholder:text-muted"
            />
          </label>

          <nav className="flex flex-col gap-0.5">
            {nav.map((n) => (
              <div key={n.id}>
                <button
                  onClick={() => setSection(n.id)}
                  className={cx(
                    'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium',
                    section === n.id ? 'bg-hover text-fg' : 'text-soft hover:bg-hover/60 hover:text-fg',
                  )}
                >
                  {n.icon}
                  {n.label}
                </button>
                {n.id === 'account' && section === 'account' && (
                  <div className="my-1 ml-5 border-l border-edge pl-3 text-sm">
                    <a href="#conta-info" className="block py-1 text-soft hover:text-fg">
                      Informações da conta
                    </a>
                    <a href="#conta-senha" className="block py-1 text-soft hover:text-fg">
                      Senha e segurança
                    </a>
                  </div>
                )}
              </div>
            ))}
            {nav.length === 0 && <p className="px-3 py-2 text-sm text-muted">Nada encontrado.</p>}
          </nav>

          <div className="mt-auto border-t border-edge pt-2">
            <button
              onClick={() => {
                onClose();
                logout();
              }}
              className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-danger hover:bg-danger/10"
            >
              <Icons.Logout size={18} />
              Sair
            </button>
          </div>
        </aside>

        <section className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-14 shrink-0 items-center justify-between border-b border-edge px-6">
            <h1 className="font-semibold">{title}</h1>
            <button onClick={onClose} title="Fechar (Esc)" className="rounded-md p-1.5 text-muted hover:bg-hover hover:text-fg">
              <Icons.X size={20} />
            </button>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto scroll-smooth">
            <div className={cx('mx-auto px-6 py-10', section === 'profile' ? 'max-w-[1000px]' : 'max-w-[700px]')}>
              {section === 'account' && <AccountSection />}
              {section === 'profile' && <ProfileEditor />}
              {section === 'voice' && <VoiceSettingsPanel />}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function maskEmail(email: string) {
  const [user, host] = email.split('@');
  return `${'*'.repeat(Math.max(4, user?.length ?? 0))}@${host ?? ''}`;
}

function AccountSection() {
  const me = useLine((s) => s.me)!;
  const [showEmail, setShowEmail] = useState(false);
  const [editing, setEditing] = useState<'username' | 'email' | 'password' | null>(null);

  return (
    <div className="space-y-10">
      <div id="conta-info" className="space-y-1">
        <h2 className="mb-4 text-xl font-bold">Informações da conta</h2>
        <Row label="Nome de usuário" value={me.username} onEdit={() => setEditing('username')} />
        <Row
          label="E-mail"
          value={
            me.email ? (
              <>
                {showEmail ? me.email : maskEmail(me.email)}{' '}
                <button onClick={() => setShowEmail((v) => !v)} className="text-accent hover:underline">
                  {showEmail ? 'Esconder' : 'Mostrar'}
                </button>
              </>
            ) : (
              <span className="text-muted">Nenhum email</span>
            )
          }
          onEdit={() => setEditing('email')}
        />
      </div>

      <hr className="border-edge" />

      <div id="conta-senha" className="space-y-1">
        <h2 className="mb-4 text-xl font-bold">Senha e segurança</h2>
        <Row label="Senha" value={<span className="text-muted">••••••••</span>} onEdit={() => setEditing('password')} />
      </div>

      {editing && <EditAccountDialog field={editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

function Row({ label, value, onEdit }: { label: string; value: ReactNode; onEdit: () => void }) {
  return (
    <div className="flex items-center gap-4 py-2.5">
      <span className="font-medium">{label}</span>
      <span className="ml-auto truncate text-sm text-soft">{value}</span>
      <Button variant="ghost" onClick={onEdit} className="shrink-0 border border-edge px-4">
        Editar
      </Button>
    </div>
  );
}

/** Troca nome de usuário, email ou senha. Sempre pede a senha atual. */
function EditAccountDialog({ field, onClose }: { field: 'username' | 'email' | 'password'; onClose: () => void }) {
  const me = useLine((s) => s.me)!;
  const [value, setValue] = useState(field === 'username' ? me.username : field === 'email' ? (me.email ?? '') : '');
  const [confirm, setConfirm] = useState('');
  const [current, setCurrent] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const title = field === 'username' ? 'Alterar nome de usuário' : field === 'email' ? 'Alterar email' : 'Alterar senha';

  async function save() {
    setError('');
    if (field === 'password' && value !== confirm) return setError('As senhas não são iguais.');
    setBusy(true);
    try {
      if (field === 'password') {
        await api.changePassword(current, value);
        setDone(true);
      } else {
        const patch = field === 'username' ? { username: value.trim() } : { email: value.trim() || null };
        actions.setMe(await api.updateAccount({ ...patch, currentPassword: current }));
        onClose();
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4" onMouseDown={onClose}>
      <form
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        className="w-full max-w-sm space-y-4 rounded-xl border border-edge bg-side p-6 shadow-2xl"
      >
        <h3 className="text-lg font-bold">{title}</h3>
        {done ? (
          <>
            <p className="text-sm text-soft">Senha alterada.</p>
            <div className="flex justify-end">
              <Button type="button" onClick={onClose}>
                Fechar
              </Button>
            </div>
          </>
        ) : (
          <>
            {field === 'password' ? (
              <>
                <Field label="Nova senha">
                  <Input required type="password" value={value} onChange={(e) => setValue(e.target.value)} autoComplete="new-password" />
                </Field>
                <Field label="Confirmar nova senha">
                  <Input required type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" />
                </Field>
              </>
            ) : (
              <Field label={field === 'username' ? 'Nome de usuário' : 'Email'}>
                <Input
                  autoFocus
                  required={field === 'username'}
                  type={field === 'email' ? 'email' : 'text'}
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                />
              </Field>
            )}
            <Field label="Senha atual">
              <Input required type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
            </Field>
            <ErrorText>{error}</ErrorText>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={onClose}>
                Cancelar
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? 'Salvando…' : 'Salvar'}
              </Button>
            </div>
          </>
        )}
      </form>
    </div>
  );
}
