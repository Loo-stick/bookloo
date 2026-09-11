// De quelle rubrique releve un titre, quand la recherche traverse les deux.
//
// UNE RECHERCHE NE SAIT PAS OU ELLE CHERCHE. Les rubriques sont des pages distinctes, mais
// une recherche rend les deux d'un coup — et, chez Wawacity, aussi des livres et des BD
// qui n'ont rien a faire dans un kiosque. Il faut donc lire la rubrique DANS le resultat,
// et ecarter ce qui n'en porte aucune.

import type { Rubrique } from './types';

/**
 * La rubrique annoncee par le suffixe d'un titre Wawacity.
 *
 * Le site marque chaque fiche : « … [Magazines] », « … [Journaux] », mais aussi
 * « [Livres] », « [BD] », « [Mangas] ». Rendre `null` sur ces derniers est ce qui empeche
 * un roman d'apparaitre dans le kiosque.
 */
export function rubriqueDuSuffixe(brut: string): Rubrique | null {
  const m = /\[([^\]]+)\]\s*$/.exec(String(brut || ''));
  if (!m) return null;
  const t = m[1].trim().toLowerCase();
  if (t === 'journaux') return 'journaux';
  if (t === 'magazines') return 'magazines';
  return null;
}

/** La rubrique portee par un chemin d'URL — zone-ebook et bookys la mettent la. */
export function rubriqueDuChemin(chemin: string): Rubrique | null {
  if (/\/journaux\//.test(chemin)) return 'journaux';
  if (/\/magazines\//.test(chemin)) return 'magazines';
  return null;
}
