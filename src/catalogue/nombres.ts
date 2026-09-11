/**
 * Le compte de tomes d'une serie, lu chez les catalogues.
 *
 * Son propre fichier plutot que `types.ts` : celui-ci importe `Oeuvre` depuis `mangadex`,
 * qui a son tour aurait importe la fonction — un cycle a l'execution, pour une seule
 * fonction de trois lignes.
 */

/**
 * Un compte de tomes utilisable, ou `undefined`.
 *
 * Zero, vide, non entier et negatif valent tous « on ne sait pas » — et c'est un etat de
 * plein droit : la grille des tomes s'arrete alors au plus grand tome connu, plutot que
 * d'afficher des pastilles pour des tomes dont rien ne dit qu'ils existent.
 *
 * Mesure du 2026-08-28 : MangaDex rend `lastVolume` « 3 » sur une serie terminee et « »
 * sur une serie en cours. Les deux passent ici.
 */
export function nombreDeTomes(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').trim());
  return Number.isInteger(n) && n > 0 ? n : undefined;
}
