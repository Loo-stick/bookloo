// Le NOM d'un numero de presse : sa date de parution.
//
// Un periodique ne se numerote pas en tomes — voir `familles/table.ts`, `compteEnTomes`.
// Ce module donne a la bibliotheque le libelle qu'elle affiche a la place, et il le tire
// du MEME parseur que le kiosque (`separerTitreDate`) : deux lecteurs de date auraient
// diverge, et c'est exactement la faute qui a produit « Tome 26 » pour un numero 4611.

import { separerTitreDate, MOIS } from './titre-date';
import { compteEnTomes, familleParId } from '../familles/table';

/**
 * La date de parution, telle qu'elle s'ecrit.
 *
 * `2026-08-26` rend « 26 aout 2026 », `2026-09` rend « septembre 2026 » — une parution
 * mensuelle n'a pas de quantieme, et lui en inventer un serait faux.
 *
 * LE PREMIER DU MOIS PORTE SON ORDINAL : en francais le premier ne s'ecrit jamais « 1 ».
 * Meme regle que dans le parseur, ou elle est arrivee par un defaut vu au deploiement.
 */
export function libelleParution(date: string): string | null {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(String(date || ''));
  if (!m) return null;
  const mois = MOIS[Number(m[2]) - 1];
  if (!mois) return null;
  if (!m[3]) return `${mois} ${m[1]}`;
  const jour = Number(m[3]);
  if (!jour || jour > 31) return `${mois} ${m[1]}`;
  return `${jour === 1 ? '1er' : jour} ${mois} ${m[1]}`;
}

/**
 * La parution que porte une IDENTITE de tome, ou `null`.
 *
 * Seul `f:<nom de fichier>` peut en porter une : `t12` est un numero d'ordre, et un
 * `epub:` designe un ouvrage. Rendre `null` laisse l'affichage retomber sur ce qu'il
 * faisait avant — un numero mal nomme reste visible, ce qui vaut mieux qu'une date
 * devinee.
 *
 * LES POINTS DEVIENNENT DES ESPACES. Les releases nomment leurs fichiers
 * « Le.Journal.De.Spirou.N°4611.26.Août.2026.pdf » aussi souvent qu'avec des espaces, et
 * le parseur du kiosque lit des titres de site, ou le separateur est l'espace. On plie
 * donc ici, sans toucher a un parseur teste sur les formes reelles des trois sites.
 */
export function parutionDuNom(nom: string): { date: string; libelle: string } | null {
  const { date } = separerTitreDate(String(nom || '').replace(/[._]+/g, ' '));
  if (!date) return null;
  const libelle = libelleParution(date);
  return libelle ? { date, libelle } : null;
}

export function parutionDuTome(tomeId: string): string | null {
  const id = String(tomeId || '');
  if (!id.startsWith('f:')) return null;
  return parutionDuNom(id.slice(2))?.libelle ?? null;
}

/**
 * Les parutions d'une liste d'identites, celles qui en portent une.
 *
 * LA DATE VOYAGE A COTE DU LIBELLE parce que seule la date se TRIE : « 2 septembre 2026 »
 * passerait avant « 26 aout 2026 » dans l'ordre alphabetique, soit l'inverse du vrai. Le
 * libelle s'affiche, la date range.
 */
export function parutionsDesTomes(
  identites: string[],
): Record<string, { date: string; libelle: string }> {
  const table: Record<string, { date: string; libelle: string }> = {};
  for (const id of identites) {
    if (typeof id !== 'string' || table[id]) continue;
    if (!id.startsWith('f:')) continue;
    const p = parutionDuNom(id.slice(2));
    if (p) table[id] = p;
  }
  return table;
}

interface EntreeDatable {
  famille: string | null;
  positions: { tome: string }[];
  tomes: string[];
  appoints: { tomes: string[] }[];
}

/**
 * La bibliotheque, augmentee des parutions de ses periodiques.
 *
 * LA TABLE EST PRESENTE, MEME VIDE, POUR UNE FAMILLE QUI NE COMPTE PAS EN TOMES : c'est
 * elle qui dit a l'ecran de parler en NUMEROS plutot qu'en tomes. Un numero dont le nom
 * ne porte pas de date reste alors sans libelle propre, mais il est toujours compte pour
 * ce qu'il est. L'absence de table veut dire « cette oeuvre a des tomes ».
 *
 * LE CRITERE VIENT DE LA TABLE DES FAMILLES, pas d'un `=== 'presse'` ecrit ici. Une
 * seconde liste des familles datees aurait diverge de la premiere le jour ou une famille
 * s'ajoute.
 */
export function avecParutions<T extends EntreeDatable>(
  entrees: T[],
): (T & { parutions?: Record<string, string> })[] {
  return entrees.map((e) => {
    const famille = e.famille ? familleParId(e.famille) : null;
    if (!famille || compteEnTomes(famille)) return e;
    const identites = [
      ...e.positions.map((p) => p.tome),
      ...e.tomes,
      ...e.appoints.flatMap((a) => a.tomes),
    ];
    return { ...e, parutions: parutionsDesTomes(identites) };
  });
}
