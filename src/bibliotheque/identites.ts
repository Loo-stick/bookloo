// Identites de la bibliotheque.
//
// POURQUOI CE FICHIER EXISTE. La spec de lecture en ligne avait reporte l'avancement sur
// une question precise, faute de savoir y repondre sans usage reel :
//
//     « Qu'est-ce qui identifie CE TOME d'une session a l'autre ? »
//
// Une cle (infohash, chemin) meurt avec la release : le lien debride expire, le torrent
// quitte le tracker, et le favori ne vaut plus rien. Ces fonctions posent la reponse
// retenue apres usage : on identifie l'OEUVRE et le TOME, jamais la release. Celle-ci
// n'est qu'un raccourci d'acces, remplacable.
//
// Tout est pur ici : aucune base, aucun reseau. C'est ce qui rend ces regles testables
// directement, et c'est le pattern du depot — la logique decidable sort des routes.

import { normaliserTitre } from '../sources/torrent/release';

/**
 * `md:<uuid>` depuis une fiche MangaDex, `libre:<titre normalise>` sinon.
 *
 * La seconde forme n'est pas un raffinement. La recherche libre existe pour couvrir ce
 * que MangaDex ne connait pas — la BD franco-belge notamment. Sans identite pour ces
 * oeuvres-la, elles ne pourraient tout simplement pas entrer dans la bibliotheque.
 */
export function identiteOeuvre(o: { mangadexId?: string; titre: string }): string {
  if (o.mangadexId) return `md:${o.mangadexId}`;
  return `libre:${normaliserTitre(o.titre)}`;
}

/**
 * `t<numero>` quand il est connu, `f:<nom de fichier>` sinon.
 *
 * Le repli n'est pas theorique : des fichiers sans numero de tome existent dans les
 * archives, et l'interface les affiche deja « — ». Sans identite, leur position serait
 * perdue a chaque fermeture.
 */
export function identiteTome(f: { tome?: number; chemin: string }): string {
  if (f.tome !== undefined) return `t${f.tome}`;
  return `f:${f.chemin.split('/').pop() || f.chemin}`;
}

/**
 * Ramene une position dans les bornes de l'archive REELLEMENT ouverte.
 *
 * Une release de remplacement peut compter moins de planches que celle ou la position a
 * ete prise. Sans ce bornage, « reprendre » ouvrirait dans le vide — et l'utilisateur
 * n'aurait aucun moyen de comprendre pourquoi.
 */
export function bornerPlanche(planche: number, planches: number): number {
  if (!Number.isFinite(planche) || planche < 0) return 0;
  return Math.min(Math.trunc(planche), Math.max(planches - 1, 0));
}

/** Deduit, jamais stocke : deux sources de verite finiraient par diverger. */
export function estFini(planche: number, planches: number): boolean {
  return planches > 0 && planche >= planches - 1;
}
