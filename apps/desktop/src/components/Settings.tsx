'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { logout, replaceToken } from '@/lib/session';
import { actions, useLine } from '@/lib/store';
import { ProfileEditor } from './ProfileEditor';
import { Avatar, Button, cx, ErrorText, Field, Icons, Input } from './ui';
import { VoiceSettingsPanel } from './Voice';
import { ActivityPrivacySection, GamesSection } from './Activity';
import { NotificationsSection } from './Notifications';
import { showError, toast } from './Dialogs';
import { getTheme, setTheme, THEMES, type ThemeId } from '@/lib/theme';

type Section = 'account' | 'profile' | 'appearance' | 'voice' | 'notifications' | 'app' | 'blocked' | 'games' | 'activity';

const NAV: { id: Section; label: string; icon: ReactNode; keywords: string }[] = [
  { id: 'account', label: 'Minha conta', icon: <Icons.User size={18} />, keywords: 'conta usuário email senha segurança' },
  { id: 'profile', label: 'Perfil', icon: <Icons.Edit size={18} />, keywords: 'perfil nome exibição status bio cor avatar' },
  { id: 'appearance', label: 'Aparência', icon: <Icons.Palette size={18} />, keywords: 'aparência tema cores claro escuro carmesim daltônico' },
  { id: 'voice', label: 'Voz e vídeo', icon: <Icons.Mic size={18} />, keywords: 'voz vídeo microfone áudio saída ruído' },
  { id: 'notifications', label: 'Notificações', icon: <Icons.Bell size={18} />, keywords: 'notificações som sons silenciar menções badge área de trabalho não perturbe ocupado' },
  { id: 'app', label: 'Aplicativo', icon: <Icons.Monitor size={18} />, keywords: 'aplicativo iniciar inicialização computador ligar sistema abrir junto minimizado bandeja windows' },
  { id: 'blocked', label: 'Bloqueados', icon: <Icons.Ban size={18} />, keywords: 'bloqueados bloquear desbloquear usuários privacidade' },
  { id: 'games', label: 'Jogos registrados', icon: <Icons.Gamepad size={18} />, keywords: 'jogos apps registrados jogo atual adicionados atividade' },
  { id: 'activity', label: 'Privacidade nas atividades', icon: <Icons.Users size={18} />, keywords: 'jogos apps atividade privacidade compartilhar servidores' },
];

/** Configurações do usuário em tela cheia: navegação à esquerda, conteúdo à direita. */
export function SettingsModal({ onClose, initial }: { onClose: () => void; initial?: Section }) {
  const me = useLine((s) => s.me);
  const [section, setSection] = useState<Section>(initial ?? 'account');
  const [query, setQuery] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (!me) return null;
  const q = query.trim().toLowerCase();
  // "Aplicativo" só existe no app desktop (no navegador não há o que configurar ali).
  const all = typeof window !== 'undefined' && window.line?.startup ? NAV : NAV.filter((n) => n.id !== 'app');
  const nav = q ? all.filter((n) => `${n.label} ${n.keywords}`.toLowerCase().includes(q)) : all;
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
                {n.id === 'games' && <p className="mt-3 mb-1 px-3 text-xs font-bold tracking-wide text-muted uppercase">Jogos e apps</p>}
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

          <div className="mt-auto flex items-center gap-2 border-t border-edge pt-2">
            <button
              onClick={() => {
                onClose();
                logout();
              }}
              className="flex flex-1 items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-danger hover:bg-danger/10"
            >
              <Icons.Logout size={18} />
              Sair
            </button>
            <span className="shrink-0 px-2 text-xs text-muted" title="Versão do Line">
              {appVersion()}
            </span>
          </div>
          {typeof window !== 'undefined' && window.line?.updates?.run && (
            <button
              onClick={async () => {
                const updates = window.line?.updates;
                if (!updates) return;
                try {
                  // Só abre a janelinha de download se houver versão nova; senão, só avisa no topo.
                  if (!(await updates.check())) return toast('Você já está na versão mais nova.');
                  await updates.run?.();
                } catch (e) {
                  showError(e);
                }
              }}
              className="mt-1 flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-soft hover:bg-hover/60 hover:text-fg"
            >
              Procurar atualizações
            </button>
          )}
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
              {section === 'appearance' && <AppearanceSection />}
              {section === 'voice' && <VoiceSettingsPanel />}
              {section === 'notifications' && <NotificationsSection />}
              {section === 'app' && <AppSection />}
              {section === 'blocked' && <BlockedSection />}
              {section === 'games' && <GamesSection />}
              {section === 'activity' && <ActivityPrivacySection />}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function Toggle({ on, onChange, label, disabled }: { on: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={cx('relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50', on ? 'bg-accent' : 'bg-raise')}
    >
      <span className={cx('absolute top-1 h-4 w-4 rounded-full bg-white transition-all', on ? 'left-6' : 'left-1')} />
    </button>
  );
}

/** Configurações → Aplicativo: abrir o Line junto com o computador. */
function AppSection() {
  const [s, setS] = useState<{ enabled: boolean; minimized: boolean } | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const mac = typeof window !== 'undefined' && window.line?.platform === 'darwin';
  const linux = typeof window !== 'undefined' && window.line?.platform === 'linux';

  useEffect(() => {
    window.line?.startup?.get().then(setS, () => setS(null));
  }, []);

  const save = async (next: { enabled: boolean; minimized: boolean }) => {
    const prev = s;
    setS(next);
    setBusy(true);
    try {
      await window.line?.startup?.set(next.enabled, next.minimized);
    } catch (e) {
      setS(prev);
      showError(e);
    } finally {
      setBusy(false);
    }
  };

  if (s === undefined) return <p className="text-sm text-muted">Carregando…</p>;
  if (s === null)
    return (
      <div>
        <h2 className="mb-4 text-xl font-bold">Inicialização</h2>
        <p className="text-sm text-muted">
          Nesta versão do Line, quem cuida disso é o Windows: abra Configurações do Windows → Aplicativos → Inicialização e ligue o Line.
        </p>
      </div>
    );

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-bold">Inicialização</h2>
      <div className="flex items-start gap-6">
        <div className="flex-1">
          <p className="font-medium">Abrir o Line ao ligar o computador</p>
          <p className="text-sm text-muted">O Line abre sozinho quando você entra no {mac ? 'Mac' : linux ? 'computador' : 'Windows'}, e você já fica online.</p>
        </div>
        <Toggle on={s.enabled} disabled={busy} label="Abrir o Line ao ligar o computador" onChange={(v) => void save({ ...s, enabled: v })} />
      </div>
      <div className={cx('flex items-start gap-6', !s.enabled && 'pointer-events-none opacity-50')}>
        <div className="flex-1">
          <p className="font-medium">Começar minimizado</p>
          <p className="text-sm text-muted">
            {linux
              ? 'A janela abre minimizada, sem aparecer na sua frente.'
              : `A janela não aparece: o Line fica quietinho no ícone da ${mac ? 'barra de menus' : 'bandeja'}. Clique nele para abrir.`}
          </p>
        </div>
        <Toggle on={s.minimized} disabled={busy || !s.enabled} label="Começar minimizado" onChange={(v) => void save({ ...s, minimized: v })} />
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
  const [editing, setEditing] = useState<'username' | 'email' | 'password' | 'reset-link' | null>(null);
  const [danger, setDanger] = useState<'deactivate' | 'delete' | null>(null);

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
        <Row
          label="Senha"
          value={<span className="text-muted">{me.hasPassword === false ? 'Nenhuma senha (entra pelo Google)' : '••••••••'}</span>}
          onEdit={() => setEditing(me.hasPassword === false ? 'reset-link' : 'password')}
          action={me.hasPassword === false ? 'Redefinir senha' : 'Editar'}
        />
      </div>

      <hr className="border-edge" />

      <div id="conta-perigo" className="space-y-1">
        <h2 className="mb-4 text-xl font-bold">Zona perigosa</h2>
        <div className="flex items-center gap-4 py-2.5">
          <div className="min-w-0">
            <div className="font-medium">Desative sua conta</div>
            <div className="text-sm text-muted">Desative temporariamente sua conta.</div>
          </div>
          <Button variant="ghost" onClick={() => setDanger('deactivate')} className="ml-auto shrink-0 border border-edge px-4 text-danger hover:text-danger">
            Desativar conta
          </Button>
        </div>
        <div className="flex items-center gap-4 py-2.5">
          <div className="min-w-0">
            <div className="font-medium">Encerrar sua conta</div>
            <div className="text-sm text-muted">Encerre sua conta permanentemente.</div>
          </div>
          <Button variant="danger" onClick={() => setDanger('delete')} className="ml-auto shrink-0 px-4">
            Excluir conta
          </Button>
        </div>
      </div>

      {danger && <DangerDialog kind={danger} onClose={() => setDanger(null)} />}

      {editing === 'reset-link' ? (
        <ResetLinkDialog onClose={() => setEditing(null)} />
      ) : (
        editing && <EditAccountDialog field={editing} onClose={() => setEditing(null)} onForgot={() => setEditing('reset-link')} />
      )}
    </div>
  );
}

/** Desativar (volta ao entrar de novo) ou excluir a conta. Confirma com a senha ou com código do email. */
function DangerDialog({ kind, onClose }: { kind: 'deactivate' | 'delete'; onClose: () => void }) {
  const me = useLine((s) => s.me)!;
  const noPassword = me.hasPassword === false;
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [sending, setSending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const del = kind === 'delete';

  async function sendCode() {
    setError('');
    setSending(true);
    try {
      await api.sendEmailCode();
      setCodeSent(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  }

  async function go() {
    setError('');
    setBusy(true);
    try {
      const proof = noPassword ? { code: code.trim() } : { password };
      if (del) await api.deleteAccount(proof);
      else await api.deactivateAccount(proof);
      onClose();
      logout();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4" onMouseDown={onClose}>
      <form
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          void go();
        }}
        className="w-full max-w-sm space-y-4 rounded-2xl border border-edge bg-side p-6 shadow-2xl"
      >
        <h3 className="text-xl font-bold">{del ? 'Excluir conta' : 'Desativar conta'}</h3>
        <p className="text-sm text-soft">
          {del
            ? 'Sua conta será apagada para sempre: perfil, amigos e acesso aos servidores. Isso não dá para desfazer.'
            : 'Você sai de todos os aparelhos e some como offline. Para reativar, é só entrar de novo com sua conta.'}
        </p>
        {noPassword ? (
          <div className="space-y-2">
            <p className="text-sm text-soft">
              {codeSent
                ? `Enviamos um código para ${me.email ? maskEmail(me.email) : 'seu email'}. Ele vale por 15 minutos.`
                : 'Para confirmar que é você, vamos mandar um código para o seu email.'}
            </p>
            {codeSent && (
              <Field label="Código do email">
                <Input
                  required
                  autoFocus
                  value={code}
                  maxLength={6}
                  onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
                  autoComplete="one-time-code"
                  className="font-mono tracking-[0.3em] uppercase"
                />
              </Field>
            )}
            <button type="button" onClick={() => void sendCode()} disabled={sending} className="text-sm text-accent hover:underline disabled:opacity-60">
              {sending ? 'Enviando…' : codeSent ? 'Reenviar código' : 'Enviar código'}
            </button>
          </div>
        ) : (
          <Field label="Senha">
            <Input required autoFocus type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
          </Field>
        )}
        {error && <p className="rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button type="submit" variant="danger" disabled={busy || (noPassword && !code.trim())}>
            {busy ? 'Aguarde…' : del ? 'Excluir conta' : 'Desativar conta'}
          </Button>
        </div>
      </form>
    </div>
  );
}

function Row({ label, value, onEdit, action = 'Editar' }: { label: string; value: ReactNode; onEdit: () => void; action?: string }) {
  return (
    <div className="flex items-center gap-4 py-2.5">
      <span className="font-medium">{label}</span>
      <span className="ml-auto truncate text-sm text-soft">{value}</span>
      <Button variant="ghost" onClick={onEdit} className="shrink-0 border border-edge px-4">
        {action}
      </Button>
    </div>
  );
}

/** Troca nome de usuário, email ou senha. Pede a senha atual ou um código enviado por email
 * (conta do Google sem senha só tem o código). */
/** Manda o link de redefinir senha para o email da conta (funciona também em conta do Google). */
function ResetLinkDialog({ onClose }: { onClose: () => void }) {
  const me = useLine((s) => s.me)!;
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  async function send() {
    setError('');
    setBusy(true);
    try {
      await api.sendResetLink();
      setSent(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4" onMouseDown={onClose}>
      <div onMouseDown={(e) => e.stopPropagation()} className="w-full max-w-sm space-y-4 rounded-2xl border border-edge bg-side p-6 shadow-2xl">
        <h3 className="text-xl font-bold">Redefinir senha</h3>
        {!me.email ? (
          <p className="text-sm text-soft">Sua conta não tem email. Adicione um email primeiro.</p>
        ) : sent ? (
          <p className="text-sm text-soft">
            Mandamos um link para <b>{maskEmail(me.email)}</b>. Abra o email e escolha a senha nova. O link vale por 30 minutos; se não
            chegar, olhe o spam.
          </p>
        ) : (
          <p className="text-sm text-soft">
            Vamos mandar um link para <b>{maskEmail(me.email)}</b> para você {me.hasPassword === false ? 'criar' : 'escolher'} uma senha
            {me.hasPassword === false ? ' (sua conta entra pelo Google e ainda não tem uma)' : ' nova'}.
          </p>
        )}
        <ErrorText>{error}</ErrorText>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>
            {sent ? 'Fechar' : 'Cancelar'}
          </Button>
          {!sent && me.email && (
            <Button type="button" disabled={busy} onClick={() => void send()}>
              {busy ? 'Enviando…' : 'Enviar link'}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function EditAccountDialog({
  field,
  onClose,
  onForgot,
}: {
  field: 'username' | 'email' | 'password';
  onClose: () => void;
  onForgot: () => void;
}) {
  const me = useLine((s) => s.me)!;
  const [value, setValue] = useState(field === 'username' ? me.username : field === 'email' ? (me.email ?? '') : '');
  const [confirm, setConfirm] = useState('');
  const [current, setCurrent] = useState('');
  const noPassword = me.hasPassword === false;
  const [useCode, setUseCode] = useState(noPassword);
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [sending, setSending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const title =
    field === 'username'
      ? 'Alterar nome de usuário'
      : field === 'email'
        ? 'Alterar email'
        : noPassword
          ? 'Definir senha'
          : 'Alterar senha';
  const proof = useCode ? { code: code.trim() } : { currentPassword: current };

  async function sendCode() {
    setError('');
    setSending(true);
    try {
      await api.sendEmailCode();
      setCodeSent(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSending(false);
    }
  }

  async function save() {
    setError('');
    if (field === 'password' && value !== confirm) return setError('As senhas não são iguais.');
    setBusy(true);
    try {
      if (field === 'password') {
        const { token } = await api.changePassword(proof, value);
        replaceToken(token);
        setDone(true);
      } else {
        const patch = field === 'username' ? { username: value.trim() } : { email: value.trim() || null };
        actions.setMe(await api.updateAccount({ ...patch, ...proof }));
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
        className="w-full max-w-sm space-y-4 rounded-2xl border border-edge bg-side p-6 shadow-2xl"
      >
        <h3 className="text-xl font-bold">{title}</h3>
        {done ? (
          <>
            <p className="text-sm text-soft">{noPassword ? 'Senha definida. Agora você também entra com ela.' : 'Senha alterada.'}</p>
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
            {useCode ? (
              <div className="space-y-2">
                <p className="text-sm text-soft">
                  {codeSent
                    ? `Enviamos um código de 6 caracteres para ${me.email ? maskEmail(me.email) : 'seu email'}. Ele vale por 15 minutos.`
                    : 'Para confirmar que é você, vamos mandar um código de 6 caracteres para o seu email.'}
                </p>
                {codeSent && (
                  <Field label="Código do email">
                    <Input
                      required
                      autoFocus
                      value={code}
                      maxLength={6}
                      onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
                      autoComplete="one-time-code"
                      className="font-mono tracking-[0.3em] uppercase"
                    />
                  </Field>
                )}
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                  <button type="button" onClick={() => void sendCode()} disabled={sending} className="text-accent hover:underline disabled:opacity-60">
                    {sending ? 'Enviando…' : codeSent ? 'Reenviar código' : 'Enviar código'}
                  </button>
                  {!noPassword && (
                    <button type="button" onClick={() => setUseCode(false)} className="text-soft hover:underline">
                      Usar a senha atual
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <div className="space-y-1">
                <Field label="Senha atual">
                  <Input required type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
                </Field>
                {me.email && (
                  <button
                    type="button"
                    onClick={() => (field === 'password' ? onForgot() : setUseCode(true))}
                    className="text-sm text-accent hover:underline"
                  >
                    {field === 'password' ? 'Esqueceu a senha? Receber link por email' : 'Esqueceu a senha? Receber código por email'}
                  </button>
                )}
              </div>
            )}
            <ErrorText>{error}</ErrorText>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={onClose}>
                Cancelar
              </Button>
              <Button type="submit" disabled={busy || (useCode && code.trim().length !== 6)}>
                {busy ? 'Salvando…' : 'Salvar'}
              </Button>
            </div>
          </>
        )}
      </form>
    </div>
  );
}

/** Versão do app desktop; no navegador mostra que é a versão web. */
function appVersion() {
  const v = typeof window !== 'undefined' ? window.line?.version : undefined;
  return v && !v.startsWith('__') ? `v${v}` : 'Web';
}

function AppearanceSection() {
  const [theme, setCurrent] = useState<ThemeId>('padrao');
  useEffect(() => setCurrent(getTheme()), []);
  return (
    <div>
      <h3 className="pb-1 text-xs font-bold tracking-wide text-muted uppercase">Tema</h3>
      <p className="mb-4 text-sm text-muted">Vale só para este aparelho.</p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {THEMES.map((t) => {
          const active = t.id === theme;
          return (
            <button
              key={t.id}
              onClick={() => {
                setTheme(t.id);
                setCurrent(t.id);
              }}
              className={cx(
                'rounded-xl border-2 p-2 text-left transition-colors',
                active ? 'border-accent bg-raise' : 'border-edge hover:border-muted',
              )}
            >
              <div className="flex h-16 overflow-hidden rounded-lg" style={{ background: t.colors[1] }}>
                <div className="w-4" style={{ background: t.colors[0] }} />
                <div className="flex flex-1 flex-col justify-center gap-1.5 px-2">
                  <div className="h-2 w-3/4 rounded-full" style={{ background: t.colors[2] }} />
                  <div className="h-2 w-1/2 rounded-full" style={{ background: t.colors[3] }} />
                </div>
              </div>
              <div className="mt-2 flex items-center gap-1.5 px-1">
                <span className="font-semibold">{t.label}</span>
                {active && <Icons.Check size={14} className="text-accent" />}
              </div>
              <p className="px-1 text-xs text-muted">{t.hint}</p>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function BlockedSection() {
  const friends = useLine((s) => s.friends);
  const users = useLine((s) => s.users);
  const blocked = Object.values(friends)
    .filter((f) => f.state === 'blocked')
    .map((f) => users[f.user.id] ?? f.user)
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

  return (
    <div>
      <p className="mb-4 text-sm text-muted">
        Quem está aqui não pode te mandar pedidos de amizade nem mensagens diretas.
      </p>
      <h3 className="pb-2 text-xs font-bold tracking-wide text-muted uppercase">Usuários bloqueados — {blocked.length}</h3>
      {blocked.length === 0 && <p className="py-10 text-center text-muted">Você não bloqueou ninguém.</p>}
      {blocked.map((u) => (
        <div key={u.id} className="flex items-center gap-3 rounded-lg border-t border-edge px-2 py-2.5 hover:bg-hover">
          <Avatar name={u.displayName} color={u.avatarColor} src={u.avatarUrl} size={36} />
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold">{u.displayName}</p>
            <p className="truncate text-sm text-muted">@{u.username}</p>
          </div>
          <Button variant="subtle" onClick={() => api.unblockUser(u.id).catch(showError)}>
            Desbloquear
          </Button>
        </div>
      ))}
    </div>
  );
}
