// Memoire courte des CBZ OUVERTS.
//
// On retient le sommaire ET le fichier distant deja ouvert. La distinction n'est pas
// theorique : mesure du 2026-08-20, ne memoriser que le sommaire laissait chaque planche
// refaire le depot, la liste des fichiers, le deverrouillage du lien et un HEAD — quatre
// allers-retours avant meme de lire les octets, soit trois a quatre secondes par page.
//
// En retenant le fichier ouvert, tourner une page coute UNE requete de plage.
//
// L'objet retenu porte sa propre logique de re-resolution : un lien expire se renouvelle
// tout seul, sans que cette table ait a le savoir.
//
// EN MEMOIRE, PAS SUR DISQUE — meme raison que pour les liens .torrent et la DEK des
// sessions : le projet tient l'invariant « rien de ce qui vient d'une release ne
// s'ecrit ». Perdre cette table au redemarrage ne coute qu'une relecture de 64 Ko.

import type { FichierDistant } from './plages';
import type { SommaireCbz } from './zip';

const TTL_MS = 30 * 60 * 1000;
/** Plafond : un sommaire de 200 planches pese quelques dizaines de Ko. */
const MAX_ENTREES = 500;

export interface CbzOuvert {
  sommaire: SommaireCbz;
  distant: FichierDistant;
}

interface Entree {
  ouvert: CbzOuvert;
  expire: number;
}

const table = new Map<string, Entree>();

function cle(userId: number, hash: string, fichier: string): string {
  return `${userId}:${hash.toLowerCase()}:${fichier}`;
}

function purger(): void {
  const maintenant = Date.now();
  for (const [k, v] of table) if (v.expire < maintenant) table.delete(k);
  if (table.size <= MAX_ENTREES) return;
  const parAnciennete = [...table.entries()].sort((a, b) => a[1].expire - b[1].expire);
  for (const [k] of parAnciennete.slice(0, table.size - MAX_ENTREES)) table.delete(k);
}

export function poserSommaire(
  userId: number,
  hash: string,
  fichier: string,
  ouvert: CbzOuvert,
): void {
  purger();
  table.set(cle(userId, hash, fichier), { ouvert, expire: Date.now() + TTL_MS });
}

export function sommaireMemorise(
  userId: number,
  hash: string,
  fichier: string,
): CbzOuvert | undefined {
  const e = table.get(cle(userId, hash, fichier));
  if (!e) return undefined;
  if (e.expire < Date.now()) {
    table.delete(cle(userId, hash, fichier));
    return undefined;
  }
  return e.ouvert;
}

/** Exportee pour les tests. */
export function viderSommaires(): void {
  table.clear();
}
