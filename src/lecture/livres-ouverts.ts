// Memoire courte des LIVRES ouverts.
//
// Meme raison d'etre que `sommaires.ts` pour les CBZ, et meme lecon, payee deux fois.
//
// MESURE DU 2026-08-25, sur un EPUB Telegram de 700 Ko, par chapitre :
//
//     ouvrir (HEAD)          54 ms
//     lister les entrees    590 ms   <- refait a chaque chapitre
//     lire le manifeste     450 ms   <- refait a chaque chapitre
//     LE CHAPITRE           220 ms
//                          -------
//     total               1 320 ms
//
// Onze cents millisecondes sur treize cents etaient du travail deja fait. Et sur une
// release debridee c'est pire : « ouvrir » y enchaine un depot, une liste de fichiers et
// un deverrouillage de lien — trois allers-retours a AllDebrid avant de lire un octet.
//
// En retenant le livre ouvert, tourner un chapitre coute UNE requete de plage.
//
// EN MEMOIRE, PAS SUR DISQUE : le projet tient l'invariant « rien de ce qui vient d'une
// release ne s'ecrit ». Perdre cette table au redemarrage ne coute qu'une relecture.

import type { FichierDistant } from './plages';
import type { EntreeZip } from './zip';
import type { LivreEpub } from './epub';

const TTL_MS = 30 * 60 * 1000;
/** Plafond : un livre ouvert pese quelques dizaines de Ko d'entrees. */
const MAX_ENTREES = 200;

export interface LivreOuvert {
  distant: FichierDistant;
  entrees: EntreeZip[];
  livre: LivreEpub;
  /** Titres de chapitre, calcules a la premiere demande du sommaire. Les recalculer
   *  coute une lecture d'entete PAR CHAPITRE — 105 pour « Sac d'os ». */
  titres?: string[];
}

interface Entree { ouvert: LivreOuvert; expire: number }

const table = new Map<string, Entree>();

const cle = (userId: number, identite: string) => `${userId}:${identite}`;

function purger(): void {
  const maintenant = Date.now();
  for (const [k, v] of table) if (v.expire < maintenant) table.delete(k);
  if (table.size <= MAX_ENTREES) return;
  const parAnciennete = [...table.entries()].sort((a, b) => a[1].expire - b[1].expire);
  for (const [k] of parAnciennete.slice(0, table.size - MAX_ENTREES)) table.delete(k);
}

export function poserLivre(userId: number, identite: string, ouvert: LivreOuvert): void {
  purger();
  table.set(cle(userId, identite), { ouvert, expire: Date.now() + TTL_MS });
}

export function livreMemorise(userId: number, identite: string): LivreOuvert | undefined {
  const e = table.get(cle(userId, identite));
  if (!e) return undefined;
  if (e.expire < Date.now()) { table.delete(cle(userId, identite)); return undefined; }
  // Relire prolonge : un livre qu'on lit ne doit pas expirer sous le lecteur.
  e.expire = Date.now() + TTL_MS;
  return e.ouvert;
}
