// Designer UN fichier dans la liste rendue par un debrideur.
//
// LE CHEMIN COMPLET D'ABORD, le nom de base seulement s'il ne prete pas a confusion.
//
// L'appariement se faisait sur le seul nom de base : « Tome1/x.cbz » et « Tome2/x.cbz » se
// confondaient, le premier masquant le second sans erreur ni signal. On affichait alors le
// mauvais tome, et la progression s'enregistrait sur le mauvais contenu. Signale par une
// revue de code le 2026-08-29.

/** Un fichier tel que le debrideur le nomme. Seul `nom` compte pour la designation. */
export interface FichierNomme {
  nom: string;
}

const base = (c: string): string => c.split('/').pop() || c;
const normal = (c: string): string => String(c || '').replace(/^\/+/, '');

/** `a` termine-t-il `b`, sur une frontiere de dossier ? « Tome2/x.cbz » finit « S/Tome2/x.cbz ». */
const estSuffixe = (a: string, b: string): boolean =>
  a === b || (b.endsWith(a) && b[b.length - a.length - 1] === '/');

/**
 * Le fichier designe par ce chemin, ou `undefined`.
 *
 * UN NOM AMBIGU NE CHOISIT PAS AU HASARD : si deux fichiers portent le meme nom de base et
 * qu'on n'a que ce nom, on ne rend rien. Rendre le premier serait afficher le mauvais tome
 * en silence — et le silence est precisement ce qui rend ce defaut couteux.
 */
export function choisirParChemin<T extends FichierNomme>(
  fichiers: T[],
  demande: string,
): T | undefined {
  const cible = normal(demande);
  if (!cible) return undefined;

  const exact = fichiers.find((f) => normal(f.nom) === cible);
  if (exact) return exact;

  // LES DEBRIDEURS NE NOMMENT PAS PAREIL : AllDebrid rend « One Piece/T01.cbz » la ou
  // TorBox rend « T01.cbz ». Un chemin qui est le SUFFIXE de l'autre — sur une frontiere de
  // dossier — designe donc le meme fichier. C'est ce qui distingue « Tome2/x.cbz » de
  // « Tome1/x.cbz » quand le nom court, lui, ne distingue rien.
  const suffixes = fichiers.filter((f) => estSuffixe(normal(f.nom), cible)
    || estSuffixe(cible, normal(f.nom)));
  if (suffixes.length === 1) return suffixes[0];
  if (suffixes.length > 1) return undefined;

  // Le nom court en dernier recours, et SEULEMENT s'il ne designe qu'un fichier. Rendre le
  // premier serait deposer ou afficher le mauvais tome, en silence.
  const parBase = fichiers.filter((f) => base(f.nom) === base(cible));
  return parBase.length === 1 ? parBase[0] : undefined;
}
