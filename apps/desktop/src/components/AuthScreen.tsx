'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, configureApi } from '@/lib/api';
import { authenticate, savedServerUrl } from '@/lib/session';
import { Eye, EyeOff } from 'lucide-react';
import { Button, ErrorText, Field, Input, Logo } from './ui';

export function AuthScreen() {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const serverUrl = savedServerUrl();
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [siteKey, setSiteKey] = useState<string | null>(null);
  const [captcha, setCaptcha] = useState('');
  const [captchaRun, setCaptchaRun] = useState(0);

  useEffect(() => {
    configureApi({ baseUrl: serverUrl });
    api.authConfig().then((c) => setSiteKey(c.turnstileSiteKey)).catch(() => {});
  }, [serverUrl]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
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
            <h1 className="text-2xl font-bold">{mode === 'login' ? 'E aí, bora entrar?' : 'Crie sua conta'}</h1>
            <p className="mt-1 text-sm text-muted">
              {mode === 'login' ? 'Que bom te ver de novo no Line.' : 'Leva menos de um minuto.'}
            </p>
          </div>
        </div>

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

        <Field label="Senha">
          <PasswordInput
            value={password}
            onChange={setPassword}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          />
        </Field>

        {mode === 'register' && (
          <Field label="Confirmar senha">
            <PasswordInput value={confirm} onChange={setConfirm} autoComplete="new-password" />
            {confirm && confirm !== password && <p className="mt-1 text-xs text-red-400">As senhas não são iguais.</p>}
          </Field>
        )}


        {mode === 'register' && siteKey && <Turnstile key={captchaRun} siteKey={siteKey} onToken={setCaptcha} />}

        <ErrorText>{error}</ErrorText>

        <Button type="submit" disabled={busy} className="w-full py-2.5">
          {busy ? 'Aguarde…' : mode === 'login' ? 'Entrar' : 'Criar conta'}
        </Button>

        <p className="text-center text-sm text-muted">
          {mode === 'login' ? 'Ainda não tem conta? ' : 'Já tem conta? '}
          <button
            type="button"
            className="font-semibold text-accent hover:underline"
            onClick={() => {
              setMode(mode === 'login' ? 'register' : 'login');
              setError('');
            }}
          >
            {mode === 'login' ? 'Cadastre-se' : 'Entrar'}
          </button>
        </p>
      </form>
    </div>
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
