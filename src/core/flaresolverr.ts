// Acces aux pages protegees par Cloudflare, via FlareSolverr.
//
// POURQUOI CE DETOUR EXISTE. Booknode refuse l'acces direct : HTTP 403, « Sorry, you have
// been blocked ». Ce n'est pas un defi JavaScript qu'un en-tete bien choisi contourne,
// c'est une regle de pare-feu. FlareSolverr pilote un vrai navigateur et rend le HTML.
//
// CE QUE CA COUTE, MESURE LE 2026-08-24 : 2,7 a 5,7 s par page, et jusqu'a 1,9 Mo de HTML
// pour une bibliographie d'auteur. C'est un ordre de grandeur au-dessus d'un appel d'API.
// Tout appelant doit donc mettre en cache, et ne jamais appeler dans une boucle.
//
// L'adresse appartient a l'OPERATEUR. Vide, la fonction rend `null` sans rien tenter :
// l'appelant retombe sur son autre source, et aucun reglage n'est a corriger.

import { postJson } from './http';
import { getSettings } from './settings';

/** Large : la resolution du defi peut demander plusieurs secondes de navigateur. */
const DELAI_MS = 75_000;

interface ReponseFlare {
  status?: string;
  message?: string;
  solution?: { status?: number; response?: string; url?: string };
}

/**
 * Rend le HTML d'une page, ou `null`.
 *
 * `null` couvre TOUS les echecs — adresse non configuree, FlareSolverr injoignable, defi
 * non resolu, reponse non-2xx. L'appelant n'a pas a les distinguer : dans les trois cas
 * il n'a pas de page, et son repli est le meme.
 */
export async function pageViaFlaresolverr(
  url: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const base = getSettings().flaresolverr.url.replace(/\/+$/, '');
  if (!base) return null;

  // Une seule tentative : rejouer un defi Cloudflare coute 5 s de plus et n'a aucune
  // raison de mieux se passer la seconde fois.
  const r = await postJson<ReponseFlare>(
    base,
    { cmd: 'request.get', url, maxTimeout: 70_000 },
    { timeoutMs: DELAI_MS, signal },
  );
  if (!r || r.status !== 'ok') return null;
  const sol = r.solution;
  if (!sol || (sol.status ?? 0) < 200 || (sol.status ?? 0) >= 300) return null;
  return typeof sol.response === 'string' ? sol.response : null;
}
