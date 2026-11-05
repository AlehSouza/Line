'use client';

import { useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { AuthScreen } from '@/components/AuthScreen';
import { Logo } from '@/components/ui';
import { restoreSession } from '@/lib/session';
import { useLine } from '@/lib/store';

export default function Home() {
  const [booting, setBooting] = useState(true);
  const token = useLine((s) => s.token);

  useEffect(() => {
    restoreSession().finally(() => setBooting(false));
  }, []);

  if (booting) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-4 bg-rail">
        <div className="animate-pulse">
          <Logo size={56} />
        </div>
        <p className="text-sm text-muted">Conectando…</p>
      </div>
    );
  }

  return token ? <AppShell /> : <AuthScreen />;
}
