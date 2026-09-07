// Le registre des kiosques.
//
// L'ORDRE COMPTE, mais pas comme dans un repli : ils sont tous interroges. Il decide de
// l'ordre d'apparition des pastilles, et les deux sites rapides viennent d'abord parce
// qu'ils repondent en moins d'une seconde — bookys en demande quinze.

import { bookys } from './bookys';
import { wawacity } from './wawacity';
import { zoneEbook } from './zone-ebook';
import type { Kiosque } from './types';

export const KIOSQUES: Kiosque[] = [wawacity, zoneEbook, bookys];

/** Rend `null` sur un site inconnu : jamais de site par defaut. */
export function kiosqueParId(id: string): Kiosque | null {
  return KIOSQUES.find((k) => k.id === id) ?? null;
}
