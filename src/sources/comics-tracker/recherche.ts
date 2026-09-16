// Comics Tracker — lire sa recherche, qui est PUBLIQUE.
//
// MESURE DU 2026-09-16, sans aucun compte : `GET /api/search?q=batman` rend 200 et un JSON
// de 60 elements — `{ items, total, page, limit, has_more, truncated, counts }`. Les
// comptes distinguent le francais de l'original : `counts: { vf: 313, vo: 1539 }`, et le
// parametre `scope` filtre — `scope=vf` ne rend plus que les 313 editions francaises.
//
// DEUX FORMES D'ELEMENT, et une seule nous interesse :
//   - `type: "french_edition"` avec `source_type: "edition"` ou `"run"` : une edition
//     francaise, avec son titre francais, sa collection et ses auteurs ;
//   - en `scope=vo`, `type: "issue"` : des numeros americains, sans titre francais.
// Loo veut du francais : on ne demande donc que `scope=vf`.
//
// CE QUE LA RECHERCHE NE DIT PAS : ni format de fichier, ni taille. Ces renseignements
// vivent derriere le compte — voir `session.ts`. Ce module ne fabrique donc pas encore de
// candidat : il rend ce que le site annonce, et rien de plus.
//
// Module pur : aucun reseau ici.

export const BASE_CT = 'https://comics-tracker.net';

/** Le site en rend 60 par page, et c'est ce que demande sa propre interface. */
export const PAR_PAGE = 60;

export interface EditionCt {
  id: string;
  titre: string;
  /** « edition » : un album ; « run » : une periode de serie. */
  genre: 'edition' | 'run';
  collection?: string;
  periode?: string;
  auteurs: string[];
  /** Chemin de la couverture, a servir par le proxy d'images du site. */
  image?: string;
  premierNumero?: string;
}

/** L'adresse d'une recherche. `scope=vf` : les editions francaises, et elles seules. */
export function urlRechercheCt(terme: string, page = 1): string {
  const p = new URLSearchParams();
  p.set('q', terme);
  p.set('scope', 'vf');
  p.set('page', String(Math.max(1, Math.trunc(page) || 1)));
  p.set('limit', String(PAR_PAGE));
  return `${BASE_CT}/api/search?${p.toString()}`;
}

/** L'adresse publique de la couverture d'une edition, servie par le proxy du site. */
export function urlCouvertureCt(image: string | undefined): string | undefined {
  const chemin = String(image || '').replace(/^\/+/, '');
  if (!chemin) return undefined;
  return `${BASE_CT}/api/image-proxy/image/${chemin.split('/').map(encodeURIComponent).join('/')}`;
}

function texte(x: unknown): string {
  return typeof x === 'string' ? x.trim() : '';
}

/**
 * Les editions francaises d'une reponse de recherche.
 *
 * Tout ce qui n'est pas une edition francaise est ECARTE, meme si le site le rend : un
 * numero americain sans titre francais n'a rien a faire dans un resultat francophone — il
 * s'afficherait « undefined », ce qu'une mesure en `scope=vo` a montre tel quel.
 */
export function editionsDeLaRecherche(donnees: unknown): EditionCt[] {
  const items = (donnees as { items?: unknown })?.items;
  if (!Array.isArray(items)) return [];
  const out: EditionCt[] = [];
  const vus = new Set<string>();
  for (const brut of items) {
    const it = brut as Record<string, unknown>;
    if (texte(it.type) !== 'french_edition') continue;
    const genre = texte(it.source_type);
    if (genre !== 'edition' && genre !== 'run') continue;
    const id = texte(it.id);
    const titre = texte(it.french_title);
    if (!id || !titre || vus.has(id)) continue;
    vus.add(id);
    out.push({
      id,
      titre,
      genre,
      collection: texte(it.collection_id) || undefined,
      periode: texte(it.period_name) || undefined,
      auteurs: Array.isArray(it.creators) ? it.creators.map(texte).filter(Boolean) : [],
      image: texte(it.image) || undefined,
      premierNumero: texte(it.first_issue_id) || undefined,
    });
  }
  return out;
}

/** Combien d'editions francaises le site annonce pour cette recherche. */
export function totalFrancais(donnees: unknown): number {
  const d = donnees as { counts?: { vf?: unknown }; total?: unknown } | null;
  const vf = Number(d?.counts?.vf);
  if (Number.isFinite(vf)) return vf;
  const total = Number(d?.total);
  return Number.isFinite(total) ? total : 0;
}

/** Une identite de release pour ce site : `ddl:comics-tracker:<id>`. */
export function identiteCt(id: string): string {
  return `ddl:comics-tracker:${id}`;
}

export function estIdentiteCt(x: string): boolean {
  return /^ddl:comics-tracker:[A-Za-z0-9_-]+$/.test(String(x || ''));
}

export function idCt(identite: string): string {
  return String(identite || '').slice('ddl:comics-tracker:'.length);
}
