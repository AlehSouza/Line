'use client';

import { useState, type FormEvent } from 'react';
import { authenticate, savedServerUrl } from '@/lib/session';
import { Button, ErrorText, Field, Input, Logo } from './ui';

export function AuthScreen() {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const serverUrl = savedServerUrl();
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await authenticate(mode, serverUrl, username, password, displayName || undefined);
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
          <Field label="Nome de exibição" hint="Como os outros vão te ver. Dá pra mudar depois.">
            <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="João" />
          </Field>
        )}

        <Field label="Senha">
          <Input
            required
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
          />
        </Field>


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
