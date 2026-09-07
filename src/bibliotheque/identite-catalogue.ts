import { lireIdentite } from '../catalogue';

/**
 * Le catalogue et l'identifiant d'une oeuvre, depuis la cle stockee dans les favoris.
 *
 * POURQUOI CE DEMELAGE EXISTE. `identiteOeuvre` prefixe par « md: » quoi qu'il arrive, y
 * compris quand ce qu'elle recoit portait deja son propre prefixe. Une bibliotheque reelle
 * porte donc « md:md:<uuid> » et « md:cv:27781 » a cote de « md:<uuid> » — mesure du
 * 2026-08-28 sur une base de dix entrees : six doublement prefixees.
 *
 * On ne CORRIGE pas la cle en base : elle est la cle primaire de `favoris` et de
 * `progression`, et la renommer deplacerait toute la progression. On la lit correctement,
 * ce qui suffit.
 *
 * Rend `null` pour une oeuvre issue d'une recherche libre (`libre:…`) : aucun catalogue ne
 * la connait, et lui inventer une identite ferait interroger MangaDex sur un titre au
 * hasard.
 */
export function identiteCatalogue(oeuvre: string): { catalogue: string; id: string } | null {
  const direct = lireIdentite(oeuvre || '');
  if (!direct) return null;
  // Le prefixe exterieur peut n'etre qu'un artefact : si ce qu'il enveloppe est lui-meme
  // une identite valide, c'est elle qui fait foi.
  const interne = lireIdentite(direct.id);
  return interne || direct;
}
