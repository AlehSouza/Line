'use client';

import { useState, type FormEvent } from 'react';
import { authenticate, savedServerUrl } from '@/lib/session';
import { Button, ErrorText, Field, Input, Logo } from './ui';

export function AuthScreen() {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const serverUrl = savedServerUrl();
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (mode === 'register' && password !== confirm) {
      setError('As senhas não são iguais.');
      return;
    }
    setBusy(true);
    try {
      await authenticate(mode, serverUrl, username, password, displayName || undefined, mode === 'register' ? email.trim() : undefined);
    } catch (err) {
      setError((err as Error).message);
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
        {visible ? <EyeOff /> : <Eye />}
      </button>
    </div>
  );
}

function Eye() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function EyeOff() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M10.6 5.1A10.4 10.4 0 0 1 12 5c6.5 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.2M6.6 6.6A17.5 17.5 0 0 0 2 12s3.5 7 10 7a9.7 9.7 0 0 0 5.4-1.6" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
      <path d="M2 2l20 20" />
    </svg>
  );
}
