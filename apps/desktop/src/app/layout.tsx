import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { DialogHost } from '@/components/Dialogs';
import { TooltipHost } from '@/components/Tooltip';
import { themeBootScript } from '@/lib/theme';

export const metadata: Metadata = {
  title: 'Line',
  description: 'Converse com sua galera: servidores, canais e mensagens privadas.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
      </head>
      <body>
        {children}
        <DialogHost />
        <TooltipHost />
      </body>
    </html>
  );
}
