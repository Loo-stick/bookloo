/**
 * Nommer un tome A DEUX NIVEAUX : l'archive, et le fichier qu'elle contient.
 *
 * Toute la chaine de lecture ne transporte qu'UN nom de fichier — c'est ce que le debrideur
 * comprend. Or une release peut n'etre qu'un seul ZIP contenant les tomes : mesure du
 * 2026-08-28, « One.Piece.[T01.T105]…CHROMATIQUE » est un .zip de 15,3 Go, pas cent cinq
 * CBZ. Il faut donc deux noms la ou il n'y a qu'une place.
 *
 * Le separateur « !/ » est celui des URL de JAR et de ZIP : il se lit, il ne s'invente pas,
 * et il n'apparait pas dans un nom de fichier ordinaire.
 */
const SEPARATEUR = '!/';

export function cheminImbrique(archive: string, interne: string): string {
  return `${archive}${SEPARATEUR}${interne}`;
}

/**
 * Les deux morceaux d'un chemin imbrique, ou `null` pour un fichier ordinaire.
 *
 * Seul le PREMIER separateur coupe : un nom de fichier peut contenir « ! », et la coupure
 * doit rester la meme a chaque lecture.
 */
export function lireCheminImbrique(
  chemin: string,
): { archive: string; interne: string } | null {
  const i = String(chemin || '').indexOf(SEPARATEUR);
  if (i <= 0) return null;
  const interne = chemin.slice(i + SEPARATEUR.length);
  if (!interne) return null;
  return { archive: chemin.slice(0, i), interne };
}
