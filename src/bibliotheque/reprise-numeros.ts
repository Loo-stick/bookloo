// Rattraper les numeros de presse entres sous une identite de TOME.
//
// POURQUOI CE FICHIER EXISTE. « Mad Movies 406 2026.pdf » est entre en bibliotheque sous
// `t406` : le serveur y avait lu un numero et en avait fait un tome, ce que
// `familles/table.ts` annonce comme une faute depuis le premier jour de la famille
// presse. `identiteTome` ne le fait plus. Restent les lignes deja ecrites, et elles ne
// disparaissent pas toutes seules : la grille montrerait deux carres pour un seul numero,
// dont un en pointille — exactement ce qu'on vient de corriger.
//
// LA REGLE EST ETROITE A DESSEIN. On ne reecrit une position que si elle porte le numero
// que l'ancien code aurait tire du nom de SA release : c'est la signature de la faute, et
// rien d'autre ne lui ressemble. Une position numerotee qu'on ne sait pas expliquer reste
// en place — la garder visible vaut mieux que la deplacer au jugé.
//
// Module pur : aucune base ici, seulement la decision.

import { numeroDeFichier } from '../sources/torrent/structure';
import { familleNumerote, identiteTome } from './identites';

/**
 * L'identite que cette position devrait porter, ou `null` s'il n'y a rien a changer.
 *
 * `titreRelease` est le nom du fichier tel que le favori l'a retenu : c'est de lui que
 * l'ancien code tirait le numero, donc lui seul peut confirmer la faute.
 */
export function identiteRattrapee(
  famille: unknown,
  titreRelease: unknown,
  tome: unknown,
): string | null {
  if (familleNumerote(famille)) return null;
  const id = String(tome ?? '');
  const m = /^t(\d+)$/.exec(id);
  if (!m) return null;
  const nom = typeof titreRelease === 'string' ? titreRelease.trim() : '';
  if (!nom) return null;
  if (numeroDeFichier(nom) !== Number(m[1])) return null;
  const voulue = identiteTome({ chemin: nom }, false);
  return voulue === id ? null : voulue;
}

interface PositionRattrapable {
  tome: string;
  planche: number;
}

/**
 * Des deux positions d'un meme numero, celle qu'il faut garder.
 *
 * LA PLUS AVANCEE GAGNE. Les deux decrivent la meme lecture ; garder la moins avancee
 * ferait perdre des pages a quelqu'un qui n'a rien demande. A egalite, la position deja
 * a la bonne identite reste — elle n'a rien a prouver.
 */
export function positionAGarder(
  numerotee: PositionRattrapable,
  nommee: PositionRattrapable | undefined,
): PositionRattrapable {
  if (!nommee) return numerotee;
  return numerotee.planche > nommee.planche ? numerotee : nommee;
}
