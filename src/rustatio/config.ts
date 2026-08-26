export type ConfigRustatio = { url: string; token?: string };

/** SSRF minimale : http(s) uniquement + URL parsable. (localhost autorise : cas operateur.) */
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
