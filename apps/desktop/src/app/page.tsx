'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { AuthScreen } from '@/components/AuthScreen';
import { ContextMenuHost } from '@/components/ContextMenu';
import { TitleBar } from '@/components/TitleBar';
import { UpdateBanner } from '@/components/UpdateBanner';
import { Logo } from '@/components/ui';
import { restoreSession } from '@/lib/session';
import { useLine } from '@/lib/store';

export default function Home() {
  const [booting, setBooting] = useState(true);
  const token = useLine((s) => s.token);

  useEffect(() => {
    restoreSession().finally(() => setBooting(false));
  }, []);

  return (
    <div className="flex h-screen flex-col">
      <TitleBar />
      <UpdateBanner />
      <div className="min-h-0 flex-1">{booting ? <Booting /> : token ? <AppShell /> : <AuthScreen />}</div>
      <ContextMenuHost />
    </div>
  );
}

function Booting() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 bg-rail">
      <div className="animate-pulse">
        <Logo size={56} />
      </div>
      <div className="relative h-1 w-40 overflow-hidden rounded-full bg-raise">
        <div
          className="absolute inset-y-0 w-2/5 rounded-full"
          style={{
            background: 'linear-gradient(90deg, transparent, var(--color-accent), transparent)',
            animation: 'line-progress 1.2s ease-in-out infinite',
          }}
        />
      </div>
      <p className="text-sm text-muted">Conectando…</p>
    </div>
  );
}
