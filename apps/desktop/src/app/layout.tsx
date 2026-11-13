import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { DialogHost } from '@/components/Dialogs';

export const metadata: Metadata = {
  title: 'Line',
  description: 'Converse com sua galera: servidores, canais e mensagens privadas.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>
        {children}
        <DialogHost />
      </body>
    </html>
  );
}
