// Knaben — meta-recherche sur les trackers publics.
//
// SOURCE PUBLIQUE, sans cle. Elle interroge d'un coup 1337x, The Pirate Bay, Nyaa et
// d'autres, dans la categorie 6000000 (Books, dont Books/Comics).
//
// UNE LIMITE A CONNAITRE, mesuree le 2026-08-20 : Knaben ne rend presque jamais de lien
// .torrent — un seul resultat sur treize. Il donne un magnet et un infohash, ce qui
// suffit a deposer chez un debrideur (le contenu est public, le DHT le trouve), mais
// PAS a decoder l'arborescence sans rien deposer. Les releases venues de Knaben seules
// n'auront donc pas leur tranche de tomes.
//
// Le dedoublonnage par hash rattrape une partie du probleme : quand la meme release
// existe aussi sur Nyaa ou sur un tracker prive, c'est l'entree porteuse d'un .torrent
// qui l'emporte.

import axios from 'axios';
import { tracerAppel, hoteDe } from '../../core/journal';
import { cached } from '../../core/cache';
import { getSettings } from '../../core/settings';
import { parseRelease } from './release';
import type { Candidate, Query, SearchContext, Source } from '../types';
import { categoriesPour, sourceEcartee } from '../../familles/table';

const TTL_MS = 30 * 60 * 1000;
const TTL_VIDE_MS = 10 * 60 * 1000;
const MAX_ITEMS = 60;

interface HitKnaben {
  title?: string;
  hash?: string;
  magnetUrl?: string;
  link?: string;
  bytes?: number;
  seeders?: number;
  category?: string;
  tracker?: string;
}

function hashDe(hit: HitKnaben): string | undefined {
  const brut = String(hit.hash ?? '').toLowerCase();
  if (/^[a-f0-9]+$/.test(brut) && brut.length === 40) return brut;
  const m = String(hit.magnetUrl ?? '').match(/btih:([a-f0-9]+)/i);
  return m && m[1].length === 40 ? m[1].toLowerCase() : undefined;
}

/** Analyse une reponse Knaben. Fonction pure : testee sans reseau. */
export function parseKnaben(corps: unknown): Candidate[] {
  const hits = (corps as { hits?: unknown })?.hits;
  if (!Array.isArray(hits)) return [];

  const out: Candidate[] = [];
  for (const brut of hits.slice(0, MAX_ITEMS)) {
    const hit = brut as HitKnaben;
    const titre = (hit.title || '').trim();
    const hash = hashDe(hit);
    // Sans hash, l'entree est inexploitable : ni verification de cache, ni depot.
    if (!titre || !hash) continue;

    const { tomes, langue, format, provenance } = parseRelease(titre);
    const taille = Number(hit.bytes);
    out.push({
      source: 'knaben',
      titre,
      hash,
      // Presque toujours absent chez Knaben. On le garde quand il est la.
      torrentUrl: hit.link && /^https?:/i.test(hit.link) ? hit.link : undefined,
      taille: Number.isFinite(taille) && taille > 0 ? taille : undefined,
      seeders: hit.seeders !== undefined ? Number(hit.seeders) || 0 : undefined,
      // Le tracker d'origine est plus parlant que « Books » : il dit d'ou ca vient.
      categorie: hit.tracker || hit.category,
      tomes,
      langue,
      format,
      provenance,
    });
  }
  return out;
}

async function interroger(
  url: string,
  categories: (string | number)[],
  terme: string,
  signal?: AbortSignal,
): Promise<unknown | null> {
  try {
    const res = await axios.post(
      url,
      {
        query: terme,
        categories: categories.map(Number).filter(Number.isFinite),
        size: MAX_ITEMS,
        hide_xxx: true,
        hide_unsafe: false,
        order_direction: 'desc',
      },
      {
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        timeout: 12000,
        validateStatus: () => true,
        signal,
      },
    );
    if (res.status < 200 || res.status >= 300) return null;
    return res.data;
  } catch {
    return null;
  }
}

export function knabenSource(): Source {
  return {
    id: 'knaben',
    label: 'Knaben',
    // Pas de cleRequise : source publique.

    async search(q: Query, ctx: SearchContext): Promise<Candidate[]> {
      // Ecartee quand la famille ne declare aucune categorie pour cette source.
      if (ctx.famille && sourceEcartee(ctx.famille, 'knaben')) return [];
      const categoriesFamille = ctx.famille ? categoriesPour(ctx.famille, 'knaben') : [];
      const conf = getSettings().knaben;
      if (!conf.enabled) return [];
      const terme = (q.titres[0] || '').trim();
      if (!terme) return [];

      // LES CATEGORIES ENTRENT DANS LA CLE. Sans elles, une recherche « livres » et une
      // recherche « mangas » sur le meme titre partagent la meme entree, et la seconde
      // rend les resultats filtres de la premiere — sans que rien ne le signale. Le meme
      // defaut a ete corrige sur Torznab et UNIT3D ; il trainait encore ici. Signale par
      // une revue de code le 2026-08-29.
      const categoriesUtiles = categoriesFamille.length ? categoriesFamille : conf.categories;
      const corps = await cached<unknown>(
        `knaben:${categoriesUtiles.join(',')}:${terme.toLowerCase()}`,
        TTL_MS,
        async () => {
          const debut = Date.now();
          const r = await interroger(conf.url, categoriesUtiles, terme, ctx.signal);
          tracerAppel({
            source: 'knaben',
            hote: hoteDe(conf.url),
            statut: r === null ? null : 200,
            duree: Date.now() - debut,
            ok: r !== null,
          });
          return r;
        },
        {
          scope: 'knaben',
          echec: (v) => v === null,
          shouldCache: (v) => v !== null,
          negativeTtlMs: TTL_VIDE_MS,
        },
      );

      // Echec, pas resultat vide : voir la note dans torznab.ts.
      if (corps === null) throw new Error("Knaben n'a rendu aucune reponse exploitable");
      return parseKnaben(corps);
    },
  };
}
