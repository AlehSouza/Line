'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, configureApi } from '@/lib/api';
import { authenticate, authenticateWithGoogle, savedServerUrl } from '@/lib/session';
import { Eye, EyeOff } from 'lucide-react';
import { Button, ErrorText, Field, Input, Logo } from './ui';
import { toast } from './Dialogs';

export function AuthScreen() {
  // Link do email de recuperação: .../app/?reset=TOKEN abre direto a tela de nova senha.
  const [resetToken] = useState(() =>
    typeof window === 'undefined' ? '' : new URLSearchParams(window.location.search).get('reset') ?? '',
  );
  const [mode, setMode] = useState<'login' | 'register' | 'forgot' | 'reset'>(resetToken ? 'reset' : 'login');
  const serverUrl = savedServerUrl();
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [siteKey, setSiteKey] = useState<string | null>(null);
  const [captcha, setCaptcha] = useState('');
  const [captchaRun, setCaptchaRun] = useState(0);
  const [resetEnabled, setResetEnabled] = useState(false);
  const [sent, setSent] = useState(false);
  const [googleEnabled, setGoogleEnabled] = useState(false);

  useEffect(() => {
    configureApi({ baseUrl: serverUrl });
    api
      .authConfig()
      .then((c) => {
        setSiteKey(c.turnstileSiteKey);
        setResetEnabled(!!c.passwordReset);
        setGoogleEnabled(!!c.google);
      })
      .catch(() => {});
  }, [serverUrl]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Volta do Google no app web: .../app/?google=CODIGO (ou ?googleError=mensagem).
  useEffect(() => {
    const qs = new URLSearchParams(window.location.search);
    const code = qs.get('google');
    const fail = qs.get('googleError');
    if (!code && !fail) return;
    window.history.replaceState(null, '', window.location.pathname);
    if (fail) return setError(fail);
    setBusy(true);
    authenticateWithGoogle(serverUrl, code!)
      .catch((err) => setError((err as Error).message))
      .finally(() => setBusy(false));
  }, [serverUrl]);

  async function google() {
    setError('');
    const base = serverUrl.replace(/\/+$/, '');
    const tauri = (window as unknown as { __TAURI_INTERNALS__?: { invoke: (c: string, a?: unknown) => Promise<string> } })
      .__TAURI_INTERNALS__;
    if (!tauri) {
      window.location.href = `${base}/api/auth/google/start`;
      return;
    }
    // Desktop: o Google não deixa logar dentro do app, então abre o navegador e espera voltar.
    setBusy(true);
    try {
      const code = await tauri.invoke('google_login', { serverUrl: base });
      await authenticateWithGoogle(serverUrl, code);
    } catch (err) {
      setError(typeof err === 'string' ? err : (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function go(next: typeof mode) {
    setMode(next);
    setError('');
    setSent(false);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (mode === 'forgot') {
      setBusy(true);
      try {
        await api.forgotPassword(email.trim());
        setSent(true);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(false);
      }
      return;
    }
    if (mode === 'reset') {
      if (password !== confirm) return setError('As senhas não são iguais.');
      setBusy(true);
      try {
        const { username: name } = await api.resetPassword(resetToken, password);
        // Tira o token da barra de endereço para não reaparecer ao recarregar.
        window.history.replaceState(null, '', window.location.pathname);
        setUsername(name);
        setPassword('');
        setConfirm('');
        go('login');
        toast('Senha alterada! Agora é só entrar com a nova senha.');
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy(false);
      }
      return;
    }
    if (mode === 'register' && password !== confirm) {
      setError('As senhas não são iguais.');
      return;
    }
    if (mode === 'register' && siteKey && !captcha) {
      setError('Confirme que você não é um robô.');
      return;
    }
    setBusy(true);
    try {
      await authenticate(mode, serverUrl, username, password, displayName || undefined, mode === 'register' ? email.trim() : undefined, mode === 'register' ? captcha || undefined : undefined);
    } catch (err) {
      setError((err as Error).message);
      // Cada token do captcha vale uma vez só: gera outro para a próxima tentativa.
      if (mode === 'register' && siteKey) {
        setCaptcha('');
        setCaptchaRun((n) => n + 1);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="glow relative flex h-full items-center justify-center overflow-hidden bg-rail p-6">
      {/* Fundo: linhas onduladas discretas + brilho violeta no topo */}
      <svg className="pointer-events-none absolute inset-0 h-full w-full opacity-[0.04]" aria-hidden>
        <defs>
          <pattern id="waves" width="160" height="60" patternUnits="userSpaceOnUse">
            <path d="M0 30c20-20 40-20 60 0s40 20 60 0 40-20 40 0" stroke="#8b8b96" strokeWidth="3" fill="none" />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#waves)" />
      </svg>

      <form
        onSubmit={submit}
        className="relative w-full max-w-sm space-y-5 rounded-2xl border border-edge bg-side p-8 shadow-2xl"
      >
        <div className="flex flex-col items-center gap-3 text-center">
          <Logo size={48} />
          <div>
            <h1 className="text-2xl font-bold">{TITLES[mode][0]}</h1>
            <p className="mt-1 text-sm text-muted">{TITLES[mode][1]}</p>
          </div>
        </div>

        {mode === 'forgot' && (sent ? (
          <p className="rounded-xl border border-edge bg-rail/60 p-4 text-sm leading-relaxed">
            Se existir uma conta com <b>{email.trim()}</b>, mandamos um link para criar uma senha nova. Ele vale por 30
            minutos. Não chegou? Dá uma olhada no spam.
          </p>
        ) : (
          <Field label="Email da conta">
            <Input autoFocus required type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="voce@exemplo.com" autoComplete="email" />
          </Field>
        ))}

        {(mode === 'login' || mode === 'register') && (
        <Field label="Nome de usuário">
          <Input
            autoFocus
            required
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="ex: joao_silva"
            autoComplete="username"
          />
        </Field>
        )}

        {mode === 'register' && (
          <Field label="Email">
            <Input required type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="voce@exemplo.com" autoComplete="email" />
          </Field>
        )}

        {mode === 'register' && (
          <Field label="Nome de exibição" hint="Como os outros vão te ver. Dá pra mudar depois.">
            <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="João" />
          </Field>
        )}

        {mode !== 'forgot' && (
          <Field label={mode === 'reset' ? 'Nova senha' : 'Senha'}>
            <PasswordInput
              value={password}
              onChange={setPassword}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            />
            {mode === 'login' && resetEnabled && (
              <button type="button" className="mt-1.5 text-xs font-semibold text-accent hover:underline" onClick={() => go('forgot')}>
                Esqueci minha senha
              </button>
            )}
          </Field>
        )}

        {(mode === 'register' || mode === 'reset') && (
          <Field label="Confirmar senha">
            <PasswordInput value={confirm} onChange={setConfirm} autoComplete="new-password" />
            {confirm && confirm !== password && <p className="mt-1 text-xs text-red-400">As senhas não são iguais.</p>}
          </Field>
        )}


        {mode === 'register' && siteKey && (
          // No app desktop a origem é tauri.localhost, que a Cloudflare recusa ("Não foi possível
          // conectar ao site"): o widget roda numa página do próprio servidor, dentro de um iframe.
          sameOrigin(serverUrl) ? (
            <Turnstile key={captchaRun} siteKey={siteKey} onToken={setCaptcha} />
          ) : (
            <CaptchaFrame key={captchaRun} serverUrl={serverUrl} onToken={setCaptcha} />
          )
        )}

        <ErrorText>{error}</ErrorText>

        {!(mode === 'forgot' && sent) && (
          <Button type="submit" disabled={busy} className="w-full py-2.5">
            {busy ? 'Aguarde…' : SUBMIT[mode]}
          </Button>
        )}

        {(mode === 'login' || mode === 'register') && googleEnabled && (
          <>
            <div className="flex items-center gap-3 text-xs text-muted">
              <span className="h-px flex-1 bg-edge" />
              ou
              <span className="h-px flex-1 bg-edge" />
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={google}
              className="flex w-full items-center justify-center gap-2.5 rounded-lg border border-edge bg-rail/60 py-2.5 text-sm font-semibold transition hover:bg-rail disabled:opacity-60"
            >
              <GoogleIcon />
              {mode === 'login' ? 'Entrar com Google' : 'Cadastrar com Google'}
            </button>
          </>
        )}

        {(mode === 'forgot' || mode === 'reset') ? (
          <p className="text-center text-sm text-muted">
            <button type="button" className="font-semibold text-accent hover:underline" onClick={() => go('login')}>
              Voltar para o login
            </button>
          </p>
        ) : (
        <p className="text-center text-sm text-muted">
          {mode === 'login' ? 'Ainda não tem conta? ' : 'Já tem conta? '}
          <button
            type="button"
            className="font-semibold text-accent hover:underline"
            onClick={() => go(mode === 'login' ? 'register' : 'login')}
          >
            {mode === 'login' ? 'Cadastre-se' : 'Entrar'}
          </button>
        </p>
        )}
      </form>
    </div>
  );
}

const TITLES = {
  login: ['E aí, bora entrar?', 'Que bom te ver de novo no Line.'],
  register: ['Crie sua conta', 'Leva menos de um minuto.'],
  forgot: ['Esqueceu a senha?', 'Digite o email da sua conta que a gente te manda um link.'],
  reset: ['Crie uma senha nova', 'Escolha uma senha com pelo menos 6 caracteres.'],
} as const;

const SUBMIT = { login: 'Entrar', register: 'Criar conta', forgot: 'Enviar link', reset: 'Salvar nova senha' } as const;

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden>
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}

/** Campo de senha com o botão de olho para mostrar ou esconder o que foi digitado. */
function PasswordInput({ value, onChange, autoComplete }: { value: string; onChange: (v: string) => void; autoComplete: string }) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <Input
        required
        type={visible ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoComplete={autoComplete}
        className="pr-10"
      />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        title={visible ? 'Esconder senha' : 'Mostrar senha'}
        aria-label={visible ? 'Esconder senha' : 'Mostrar senha'}
        className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-muted hover:text-fg"
      >
        {visible ? <EyeOff size={18} /> : <Eye size={18} />}
      </button>
    </div>
  );
}

declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, opts: Record<string, unknown>) => string;
      remove: (id: string) => void;
    };
  }
}

let turnstileScript: Promise<void> | null = null;
function loadTurnstile() {
  turnstileScript ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => {
      turnstileScript = null;
      reject(new Error('captcha'));
    };
    document.head.appendChild(s);
  });
  return turnstileScript;
}

function sameOrigin(url: string) {
  try {
    return new URL(url, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}

/** Captcha carregado de {servidor}/api/auth/captcha; o token chega por postMessage. */
function CaptchaFrame({ serverUrl, onToken }: { serverUrl: string; onToken: (t: string) => void }) {
  const origin = new URL(serverUrl, window.location.href).origin;
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      if (e.origin !== origin || e.data?.type !== 'line-captcha') return;
      onToken(typeof e.data.token === 'string' ? e.data.token : '');
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, [origin, onToken]);
  return (
    <iframe
      src={`${serverUrl.replace(/\/+$/, '')}/api/auth/captcha`}
      title="Captcha"
      className="mx-auto block h-[70px] w-[310px] border-0"
    />
  );
}

/** Captcha da Cloudflare (Turnstile): na maioria das vezes passa sozinho, sem clicar em nada. */
function Turnstile({ siteKey, onToken }: { siteKey: string; onToken: (t: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let id: string | null = null;
    let alive = true;
    loadTurnstile()
      .then(() => {
        if (!alive || !ref.current || !window.turnstile) return;
        id = window.turnstile.render(ref.current, {
          sitekey: siteKey,
          theme: 'dark',
          language: 'pt-br',
          callback: (t: string) => onToken(t),
          'expired-callback': () => onToken(''),
          'error-callback': () => onToken(''),
        });
      })
      .catch(() => {});
    return () => {
      alive = false;
      if (id) window.turnstile?.remove(id);
    };
  }, [siteKey, onToken]);
  return <div ref={ref} className="flex min-h-[65px] justify-center" />;
}
