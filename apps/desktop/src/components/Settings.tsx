'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { logout, replaceToken } from '@/lib/session';
import { actions, useLine } from '@/lib/store';
import { ProfileEditor } from './ProfileEditor';
import { Avatar, Button, cx, ErrorText, Field, Icons, Input, Modal, Select } from './ui';
import { ageOf } from '@/lib/age';
import { VoiceSettingsPage } from './VoiceSettings';
import { ActivityPrivacySection, GamesSection } from './Activity';
import { NotificationsSection } from './Notifications';
import { showError, toast } from './Dialogs';
import { forgetVoiceForUpdate, keepVoiceForUpdate } from '@/lib/voice';
import {
  CUSTOM_FIELDS,
  DEFAULT_CUSTOM,
  getCustomColors,
  getTheme,
  setCustomColors,
  setTheme,
  THEMES,
  type CustomColors,
  type ThemeId,
} from '@/lib/theme';
import { ColorPicker } from '@/components/ColorPicker';

type Section = 'account' | 'profile' | 'appearance' | 'voice' | 'notifications' | 'app' | 'blocked' | 'games' | 'activity';

const NAV: { id: Section; label: string; icon: ReactNode; keywords: string }[] = [
  { id: 'account', label: 'Minha conta', icon: <Icons.User size={18} />, keywords: 'conta usuário email senha segurança' },
  { id: 'profile', label: 'Perfil', icon: <Icons.Edit size={18} />, keywords: 'perfil nome exibição status bio cor avatar' },
  { id: 'appearance', label: 'Aparência', icon: <Icons.Palette size={18} />, keywords: 'aparência tema cores claro escuro carmesim pink rosa daltônico' },
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
                  // Guarda a chamada para voltar nela quando o app reabrir na versão nova.
                  keepVoiceForUpdate();
                  await updates.run?.();
                  forgetVoiceForUpdate();
                } catch (e) {
                  forgetVoiceForUpdate();
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
          <div className={cx('min-h-0 flex-1 overflow-y-auto scroll-smooth', section === 'profile' && '[container-type:size]')}>
            <div className={cx('mx-auto px-6', section === 'profile' ? 'max-w-[1000px] py-5' : 'max-w-[700px] py-10')}>
              {section === 'account' && <AccountSection />}
              {section === 'profile' && <ProfileEditor />}
              {section === 'appearance' && <AppearanceSection />}
              {section === 'voice' && <VoiceSettingsPage />}
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
  const [birthOpen, setBirthOpen] = useState(false);

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
        <Row
          label="Data de nascimento"
          value={me.birthDate ? formatBirth(me.birthDate) : <span className="text-muted">Não informada (mídias +18 ficam bloqueadas)</span>}
          onEdit={() => setBirthOpen(true)}
          action={me.birthDate ? 'Editar' : 'Informar'}
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
      {birthOpen && <BirthDateDialog onClose={() => setBirthOpen(false)} />}

      {editing === 'reset-link' ? (
        <ResetLinkDialog onClose={() => setEditing(null)} />
      ) : (
        editing && <EditAccountDialog field={editing} onClose={() => setEditing(null)} onForgot={() => setEditing('reset-link')} />
      )}
    </div>
  );
}

const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

function formatBirth(date: string) {
  const [y, m, d] = date.split('-').map(Number);
  const age = ageOf(date);
  return `${d} de ${MONTHS[(m ?? 1) - 1]} de ${y}${age !== null ? ` (${age} anos)` : ''}`;
}

/** Dia, mês e ano de nascimento. A idade libera (ou não) as mídias +18 do chat. */
function BirthDateDialog({ onClose }: { onClose: () => void }) {
  const me = useLine((s) => s.me)!;
  const [y0, m0, d0] = (me.birthDate ?? '').split('-');
  const [day, setDay] = useState(d0 ? String(Number(d0)) : '');
  const [month, setMonth] = useState(m0 ? String(Number(m0)) : '');
  const [year, setYear] = useState(y0 ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const thisYear = new Date().getFullYear();
  const days = month && year ? new Date(Number(year), Number(month), 0).getDate() : 31;
  const iso = day && month && year ? `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}` : '';
  const age = iso ? ageOf(iso) : null;

  async function save(value: string | null) {
    setError('');
    setBusy(true);
    try {
      actions.setMe(await api.setBirthDate(value));
      toast(value ? 'Data de nascimento salva.' : 'Data de nascimento apagada.');
      onClose();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <Modal
      title="Data de nascimento"
      subtitle="Usada só para liberar mídias marcadas como +18. Ninguém mais vê."
      onClose={onClose}
      footer={
        <>
          {me.birthDate && (
            <Button variant="ghost" disabled={busy} onClick={() => save(null)} className="mr-auto text-danger hover:text-danger">
              Apagar
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button disabled={busy || !iso || Number(day) > days} onClick={() => save(iso)}>
            Salvar
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-[1fr_1.6fr_1.2fr] gap-2">
        <Field label="Dia" group>
          <Select
            value={day}
            onChange={setDay}
            options={[{ value: '', label: 'Dia' }, ...Array.from({ length: days }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))]}
          />
        </Field>
        <Field label="Mês" group>
          <Select
            value={month}
            onChange={setMonth}
            options={[{ value: '', label: 'Mês' }, ...MONTHS.map((m, i) => ({ value: String(i + 1), label: m[0]!.toUpperCase() + m.slice(1) }))]}
          />
        </Field>
        <Field label="Ano" group>
          <Select
            value={year}
            onChange={setYear}
            options={[{ value: '', label: 'Ano' }, ...Array.from({ length: 101 }, (_, i) => ({ value: String(thisYear - i), label: String(thisYear - i) }))]}
          />
        </Field>
      </div>
      {age !== null && (
        <p className={cx('mt-3 text-sm', age >= 18 ? 'text-soft' : 'text-muted')}>
          {age >= 18 ? `${age} anos: as mídias +18 ficam liberadas.` : `${Math.max(age, 0)} anos: as mídias +18 continuam bloqueadas.`}
        </p>
      )}
      {error && <div className="mt-3"><ErrorText>{error}</ErrorText></div>}
    </Modal>
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
  const [custom, setCustom] = useState<CustomColors>(DEFAULT_CUSTOM);
  useEffect(() => {
    setCurrent(getTheme());
    setCustom(getCustomColors());
  }, []);
  const changeCustom = (c: CustomColors) => {
    setCustom(c);
    setCustomColors(c);
  };
  return (
    <div>
      <h3 className="pb-1 text-xs font-bold tracking-wide text-muted uppercase">Tema</h3>
      <p className="mb-4 text-sm text-muted">Vale só para este aparelho.</p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {THEMES.map((t) => {
          const active = t.id === theme;
          const colors = t.id === 'personalizado' ? [custom.rail, custom.main, custom.raise, custom.accent] : t.colors;
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
              <div className="flex h-16 overflow-hidden rounded-lg" style={{ background: colors[1] }}>
                <div className="w-4" style={{ background: colors[0] }} />
                <div className="flex flex-1 flex-col justify-center gap-1.5 px-2">
                  <div className="h-2 w-3/4 rounded-full" style={{ background: colors[2] }} />
                  <div className="h-2 w-1/2 rounded-full" style={{ background: colors[3] }} />
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
      {theme === 'personalizado' && <CustomThemeEditor colors={custom} onChange={changeCustom} />}
    </div>
  );
}

/** Editor do tema Personalizado: cada troca já vale no app inteiro (prévia ao vivo). */
function CustomThemeEditor({ colors, onChange }: { colors: CustomColors; onChange: (c: CustomColors) => void }) {
  const c = colors;
  return (
    <div className="mt-6">
      <div className="flex items-center justify-between pb-1">
        <h3 className="text-xs font-bold tracking-wide text-muted uppercase">Cores do Personalizado</h3>
        <Button type="button" variant="ghost" onClick={() => onChange({ ...DEFAULT_CUSTOM })}>
          Restaurar padrão
        </Button>
      </div>
      <p className="mb-3 text-sm text-muted">As mudanças aparecem na hora e ficam salvas neste aparelho.</p>

      <div className="mb-4 flex h-28 overflow-hidden rounded-xl border" style={{ borderColor: c.edge, background: c.main }}>
        <div className="flex w-10 flex-col items-center gap-1.5 py-2" style={{ background: c.rail }}>
          <div className="h-6 w-6 rounded-lg" style={{ background: c.accent }} />
          <div className="h-6 w-6 rounded-full" style={{ background: c.raise }} />
        </div>
        <div className="flex w-28 flex-col gap-1 p-2 text-[11px]" style={{ background: c.side, color: c.soft }}>
          <span className="font-semibold" style={{ color: c.fg }}># geral</span>
          <span># jogos</span>
          <span style={{ color: c.muted }}># avisos</span>
        </div>
        <div className="flex flex-1 flex-col justify-between p-2 text-xs">
          <div>
            <span className="font-semibold" style={{ color: c.fg }}>
              Ana <span className="inline-block h-2 w-2 rounded-full" style={{ background: c.online }} />
            </span>{' '}
            <span style={{ color: c.muted }}>hoje 21:04</span>
            <p style={{ color: c.soft }}>Bora jogar mais tarde?</p>
          </div>
          <div className="flex gap-1.5">
            <span className="rounded-md px-2 py-1 font-semibold" style={{ background: c.accent, color: c['on-accent'] }}>
              Entrar
            </span>
            <span className="rounded-md px-2 py-1" style={{ background: c.raise, color: c.fg }}>
              Depois
            </span>
            <span className="rounded-md px-2 py-1" style={{ color: c.danger }}>
              Sair
            </span>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {CUSTOM_FIELDS.map((f) => (
          <div key={f.key} className="flex items-center gap-3 rounded-lg border border-edge bg-raise px-3 py-2">
            <ColorPicker
              value={c[f.key]}
              onChange={(hex) => onChange({ ...c, [f.key]: hex })}
              title={`Escolher cor: ${f.label}`}
              className="h-8 w-8 shrink-0 rounded-lg border border-edge"
              style={{ background: c[f.key] }}
            />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold">{f.label}</div>
              <div className="truncate text-xs text-muted">{f.hint}</div>
            </div>
            <span className="font-mono text-xs text-soft uppercase">{c[f.key]}</span>
          </div>
        ))}
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
