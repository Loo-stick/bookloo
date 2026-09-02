export type ConfigRustatio = { url: string; token?: string };

/**
 * Forme minimale : http(s) et URL parsable.
 *
 * CE N'EST PAS LA PROTECTION SSRF, et le croire etait la faute. Le commentaire d'origine
 * disait « SSRF minimale… localhost autorise : cas operateur » — mais ce champ est
 * PAR UTILISATEUR, saisi par n'importe quel compte via `PUT /api/compte/cles`. C'est le
 * seul endroit du projet ou une chaine venue d'une requete atteint la position d'HOTE
 * d'un appel sortant, et sept appels en dependent.
 *
 * La verification reelle est `verifierUrlSortante`, qui resout le nom et refuse toutes
 * les plages internes. Elle est appelee AVANT chaque appel, dans `client.ts` et
 * `keytest.ts` — la ou l'on part sur le reseau, pas ici ou l'on ne fait que lire un champ.
 */
export function urlRustatioValide(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Parse la valeur stockee dans cles.rustatio. null si absente/illisible/URL invalide. */
export function parseConfigRustatio(brut: string | undefined): ConfigRustatio | null {
  if (!brut) return null;
  try {
    const o = JSON.parse(brut) as { url?: unknown; token?: unknown };
    if (typeof o.url !== 'string' || !urlRustatioValide(o.url)) return null;
    const url = o.url.replace(/\/+$/, ''); // pas de slash final
    return typeof o.token === 'string' && o.token ? { url, token: o.token } : { url };
  } catch {
    return null;
  }
}
