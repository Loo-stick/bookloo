// Resolution de la famille demandee par une requete.

import { familleParId, type Famille } from '../familles/table';

/**
 * Famille demandee, `null` si elle est inconnue.
 *
 * ABSENTE vaut « mangas » : les liens existants n'ont pas ce parametre, et les casser
 * rendrait la bibliotheque inutilisable le temps d'un deploiement.
 *
 * INCONNUE est refusee, jamais remplacee : substituer « mangas » ferait chercher des
 * mangas pour une requete « livres » mal orthographiee, sans que rien ne le signale.
 */
export function familleDemandee(query: unknown): Famille | null {
  const brut = (query as { famille?: unknown } | null)?.famille;
  if (brut === undefined || brut === null || brut === '') return familleParId('mangas');
  if (typeof brut !== 'string') return null;
  return familleParId(brut);
}
