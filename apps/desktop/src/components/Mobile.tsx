'use client';

import { mobile } from '@/lib/mobile';
import { Icons } from './ui';

/** Seta de voltar para a lista de canais; só aparece no celular. */
export function MobileBack() {
  return (
    <button
      title="Voltar"
      onClick={mobile.showNav}
      className="-ml-2 mr-1 rounded-md p-1.5 text-soft hover:bg-hover hover:text-fg md:hidden"
    >
      <Icons.ArrowLeft size={22} />
    </button>
  );
}

/** Abre a gaveta de membros; só aparece quando a coluna da direita está escondida. */
export function MobileMembersButton() {
  return (
    <button title="Membros" onClick={mobile.openMembers} className="ml-auto rounded-md p-1.5 text-soft hover:bg-hover hover:text-fg lg:hidden">
      <Icons.Users size={20} />
    </button>
  );
}
