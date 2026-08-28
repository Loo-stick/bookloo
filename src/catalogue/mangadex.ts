// Catalogue MangaDex.
//
// POURQUOI MANGADEX ET PAS ANILIST. AniList a de plus belles fiches — score, genres,
// statut — mais des titres alternatifs pauvres. Or ici le titre n'est pas de la
// decoration : c'est la SEULE chose qui permette de rapprocher une fiche d'un nom de
// release francais. MangaDex publie `title` et `altTitles` dans toutes les langues, y
// compris les romanisations, et c'est exactement le carburant dont le rapprochement a
// besoin.
//
// API publique, sans cle. Elle limite le debit a quelques requetes par seconde, d'ou le
// cache : les metadonnees d'une oeuvre ne bougent pas d'une heure a l'autre.

import { getJson } from '../core/http';
import { cached } from '../core/cache';
import type { Query } from '../sources/types';

const BASE = 'https://api.mangadex.org';
const TTL_RECHERCHE_MS = 6 * 60 * 60 * 1000;
const TTL_FICHE_MS = 24 * 60 * 60 * 1000;
const MAX_RESULTATS = 20;

import { nombreDeTomes } from './nombres';

export interface Oeuvre {
  id: string;
  titre: string;
  /** Toutes les formes connues, principale en tete, dedoublonnees. Sert a l'affichage
   *  et au rapprochement. */
  titres: string[];
  /** Formes a envoyer aux TRACKERS : latines, nettoyees, ordonnees par utilite. */
  formes: string[];
  auteur?: string;
  annee?: number;
  statut?: string;
  /**
   * Dernier tome annonce PAR LE CATALOGUE, quand il le sait.
   *
   * Mesure du 2026-08-28 : MangaDex rend `lastVolume` « 3 » sur une serie terminee et « »
   * sur une serie en cours ; ComicVine rend `count_of_issues`. C'est une BORNE
   * D'AFFICHAGE, pas une promesse — `count_of_issues` compte des issues et non des albums
   * relies, et la grille s'y arrete sans affirmer que la serie compte tant de tomes.
   */
  dernierTome?: number;
  synopsis?: string;
  couverture?: string;
  /**
   * ISBN de l'edition, quand le catalogue le connait.
   *
   * C'est le seul identifiant EXACT dont on dispose pour un livre. Mesure du 2026-08-24 :
   * « Holly Gibney, Tome 3 : Holly » envoye a Z-Library rend 30 livres dont 3 du bon
   * auteur — les premiers sont des Geek Girl de Holly SMALE, parce que le moteur repond
   * sur le prenom. Le meme livre cherche par son ISBN rend 6 resultats, tous les bons.
   */
  isbn?: string;
  /**
   * TOUS les ISBN connus de l'oeuvre, toutes editions confondues.
   *
   * Un ISBN designe une EDITION. Celui que rend un catalogue est presque toujours celui
   * d'une edition poche, quand une source indexe celle de l'editeur d'origine — mesure
   * du 2026-08-24 : l'ISBN Booknode ne recoupe JAMAIS ce que Z-Library indexe, 0 sur 7.
   * C'est la liste entiere qui permet un rapprochement EXACT, pas un ISBN isole.
   */
  isbns?: string[];
}

interface Relation {
  type?: string;
  attributes?: { fileName?: string; name?: string };
}

// Ecritures qu'aucun tracker francais n'indexe. Mesure du 2026-08-20 : « スマイリー »
// rend zero resultat sur C411 tout en consommant une requete du budget de recherche.
export const NON_LATIN = /[\u0400-\u04FF\u0590-\u05FF\u0600-\u06FF\u0E00-\u0E7F\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7AF]/;

/** Langues utiles pour un tracker francophone, dans l'ordre. */
const ORDRE_LANGUES = ['fr', 'en', 'ja-ro'];

/**
 * Nettoie une forme avant de l'envoyer a un tracker.
 *
 * On retire la ponctuation FINALE seulement. Mesure : « Smile! » rend 1 resultat sur
 * Tr4ker la ou « Smile » en rend 11 — les teams ne mettent pas le point d'exclamation
 * dans leurs noms de fichiers. On ne touche pas a la ponctuation interne : « Dr. STONE »
 * doit rester « Dr. STONE », c'est ainsi qu'il circule.
 */
export function nettoyerForme(t: string): string {
  return t.replace(/[\s!?.:;,\-–—]+$/u, '').replace(/\s+/g, ' ').trim();
}

/**
 * Formes de recherche, ordonnees par utilite reelle sur des trackers francophones.
 *
 * Le defaut corrige ici : « Smiley! » a « Smile! » en QUATRIEME position dans MangaDex,
 * et Mangaloo n'envoyait que les deux premieres formes — donc « Smiley! » et le titre
 * japonais. Aucune des deux ne trouvait les treize releases qui existent sous « Smile ».
 */
export function formesDeRecherche(paires: { langue: string; valeur: string }[]): string[] {
  const rang = (langue: string) => {
    const i = ORDRE_LANGUES.indexOf(langue);
    return i === -1 ? ORDRE_LANGUES.length : i;
  };
  const retenues: { rang: number; forme: string }[] = [];
  const vues = new Set<string>();

  for (const { langue, valeur } of paires) {
    if (NON_LATIN.test(valeur)) continue;
    const forme = nettoyerForme(valeur);
    if (!forme) continue;
    const cle = forme.toLowerCase();
    // « Smiley! » et « Smiley » se reduisent a la meme requete : n'en payer qu'une.
    if (vues.has(cle)) continue;
    vues.add(cle);
    retenues.push({ rang: rang(langue), forme });
  }

  return retenues.sort((a, b) => a.rang - b.rang).map((x) => x.forme);
}

/** Premiere valeur non vide d'un objet { langue: texte }, en preferant certaines langues. */
function preferee(champ: unknown, preferences: string[]): string | undefined {
  if (!champ || typeof champ !== 'object') return undefined;
  const table = champ as Record<string, unknown>;
  for (const langue of preferences) {
    const v = table[langue];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  for (const v of Object.values(table)) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

/**
 * Normalise une entree brute. Exportee pour etre testee sur fixture, sans reseau.
 *
 * Rend `null` plutot que de jeter : une entree abimee dans une liste de vingt ne doit
 * pas faire echouer toute la recherche.
 */
export function normaliserOeuvre(brut: unknown): Oeuvre | null {
  try {
    const m = brut as { id?: string; attributes?: Record<string, unknown>; relationships?: Relation[] };
    if (!m?.id || !m.attributes) return null;
    const a = m.attributes;

    // Le titre principal : on prefere une forme latine, plus proche de ce qu'ecrivent
    // les teams de scan francaises.
    const titre = preferee(a.title, ['fr', 'en', 'ja-ro', 'ja']);
    if (!titre) return null;

    const titres: string[] = [titre];
    const paires: { langue: string; valeur: string }[] = [];
    const ajouter = (langue: string, v: unknown) => {
      if (typeof v !== 'string') return;
      const t = v.trim();
      if (!t) return;
      if (!titres.includes(t)) titres.push(t);
      paires.push({ langue, valeur: t });
    };

    // `title` peut porter plusieurs langues, et `altTitles` est un TABLEAU d'objets a
    // une seule cle. Oublier d'aplatir l'un ou l'autre coute des romanisations
    // entieres — donc des releases qu'on ne retrouvera jamais.
    if (a.title && typeof a.title === 'object') {
      for (const [langue, v] of Object.entries(a.title as Record<string, unknown>)) {
        ajouter(langue, v);
      }
    }
    if (Array.isArray(a.altTitles)) {
      for (const entree of a.altTitles) {
        if (entree && typeof entree === 'object') {
          for (const [langue, v] of Object.entries(entree as Record<string, unknown>)) {
            ajouter(langue, v);
          }
        }
      }
    }

    const relations = Array.isArray(m.relationships) ? m.relationships : [];
    const auteur = relations.find((r) => r.type === 'author')?.attributes?.name;
    const couvertureFichier = relations.find((r) => r.type === 'cover_art')?.attributes?.fileName;

    const annee = Number(a.year);

    return {
      id: m.id,
      titre,
      titres,
      formes: formesDeRecherche(paires),
      auteur: auteur?.trim() || undefined,
      annee: Number.isFinite(annee) && annee > 0 ? annee : undefined,
      statut: typeof a.status === 'string' ? a.status : undefined,
      dernierTome: nombreDeTomes((a as { lastVolume?: unknown }).lastVolume),
      synopsis: preferee(a.description, ['fr', 'en']),
      couverture: couvertureFichier
        ? `https://uploads.mangadex.org/covers/${m.id}/${couvertureFichier}.256.jpg`
        : undefined,
    };
  } catch {
    return null;
  }
}

function url(chemin: string, params: Record<string, string>): string {
  const qs = new URLSearchParams(params);
  // `includes[]` doit garder ses crochets : URLSearchParams les echapperait.
  return `${BASE}${chemin}?${qs.toString()}&includes[]=cover_art&includes[]=author`;
}

export async function chercherOeuvres(q: string, signal?: AbortSignal): Promise<Oeuvre[]> {
  const requete = q.trim();
  if (!requete) return [];
  const corps = await cached<unknown>(
    `mangadex:recherche:${requete.toLowerCase()}`,
    TTL_RECHERCHE_MS,
    () =>
      getJson<unknown>(url('/manga', { title: requete, limit: String(MAX_RESULTATS) }), {
        timeoutMs: 10000,
        signal,
        retries: 1,
      }),
    { scope: 'mangadex', echec: (v) => v === null, shouldCache: (v) => v !== null },
  );
  const data = (corps as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];
  return data.map(normaliserOeuvre).filter((o): o is Oeuvre => o !== null);
}

/**
 * Le plus grand volume que l'agregat connait, ou `undefined`.
 *
 * POURQUOI L'AGREGAT ET PAS `lastVolume`. Mesure du 2026-08-28 : `lastVolume` n'est
 * renseigne que sur les series TERMINEES — Manhole rend « 3 », One Piece rend « ». Or c'est
 * precisement sur une serie en cours qu'on a besoin de savoir jusqu'ou elle va. L'agregat
 * range les chapitres par volume, et son maximum vaut 115 pour One Piece.
 *
 * On prend le MAXIMUM, pas le compte : l'indexation est trouee — 62 volumes listes pour un
 * maximum de 115 — et c'est la borne de la grille qui nous interesse, pas l'inventaire.
 *
 * MangaDex range sous « none » les chapitres sans volume : les compter donnerait NaN.
 */
export function plusGrandVolume(agregat: unknown): number | undefined {
  const v = (agregat as { volumes?: unknown } | null)?.volumes;
  if (!v || typeof v !== 'object') return undefined;
  let max = 0;
  for (const cle of Object.keys(v)) {
    const n = Number(cle);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max > 0 ? Math.trunc(max) : undefined;
}

/**
 * Le dernier tome d'une serie, d'apres son agregat.
 *
 * Un appel de plus, mis en cache comme la fiche. Il n'est lance que lorsque `lastVolume` ne
 * dit rien, c'est-a-dire sur les series en cours — les seules ou la question se pose.
 */
export async function dernierTomeIndexe(
  id: string, signal?: AbortSignal,
): Promise<number | undefined> {
  const corps = await cached<unknown>(
    `mangadex:agregat:${id}`,
    TTL_FICHE_MS,
    () => getJson<unknown>(
      // SANS FILTRE DE LANGUE. Mesure du 2026-08-28 : `translatedLanguage[]=fr` rend ZERO
      // volume sur One Piece, alors que toutes langues confondues le maximum est 115. Le
      // numero de tome ne depend pas de la langue ou on l'a scanne.
      `${BASE}/manga/${encodeURIComponent(id)}/aggregate`,
      { timeoutMs: 10000, signal, retries: 1 },
    ),
    { scope: 'mangadex', echec: (v) => v === null, shouldCache: (v) => v !== null },
  );
  return plusGrandVolume(corps);
}

export async function ficheOeuvre(id: string, signal?: AbortSignal): Promise<Oeuvre | null> {
  if (!/^[0-9a-f-]+$/i.test(id)) return null;
  const corps = await cached<unknown>(
    `mangadex:fiche:${id}`,
    TTL_FICHE_MS,
    () =>
      getJson<unknown>(url(`/manga/${id}`, {}), { timeoutMs: 10000, signal, retries: 1 }),
    { scope: 'mangadex', echec: (v) => v === null, shouldCache: (v) => v !== null },
  );
  const o = normaliserOeuvre((corps as { data?: unknown })?.data);
  if (!o) return null;
  // LE COMPLEMENT N'EST DEMANDE QUE S'IL MANQUE. `lastVolume` suffit sur une serie
  // terminee ; l'agregat ne sert que pour les series en cours, ou il est la seule source.
  // Un appel de plus, mis en cache, et seulement la ou la question se pose.
  if (o.dernierTome === undefined) {
    try {
      o.dernierTome = await dernierTomeIndexe(id, signal);
    } catch {
      // Le total n'est qu'une borne d'affichage : son absence ne doit jamais priver
      // l'appelant de la fiche entiere.
    }
  }
  return o;
}

/** Requete de recherche de releases construite depuis une fiche. */
export function requeteDepuisOeuvre(o: Oeuvre): Query {
  // Les FORMES, pas tous les titres : latines, nettoyees et ordonnees par utilite.
  return {
    titres: o.formes.length > 0 ? o.formes : o.titres,
    mangadexId: o.id, isbn: o.isbn, isbns: o.isbns,
  };
}
