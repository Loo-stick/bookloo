// Nyaa — categories Literature.
//
// SOURCE PUBLIQUE, sans cle : elle repond a tout le monde, y compris a un compte
// Mangaloo qui n'a renseigne aucune passkey.
//
// C'est la seule source du projet qui apporte des RAWS JAPONAIS (categorie 3_3). Les
// quatre trackers francais n'en ont pas, et c'est precisement ce qu'on cherche quand on
// veut lire avant la traduction. Le 3_2 — « traduit, autre langue que l'anglais » —
// contient du francais.
//
// Nyaa n'expose la taille que sous forme lisible (« 44.7 GiB ») : la conversion est
// dans `parseTaille`, reprise telle quelle de Dramallyu.

import { getText } from '../../core/http';
import { cached } from '../../core/cache';
import { extractBlocks, tagText } from '../../core/xml';
import { getSettings } from '../../core/settings';
import { parseRelease } from './release';
import type { Candidate, Query, SearchContext, Source } from '../types';
import { categoriesPour, sourceEcartee } from '../../familles/table';

const TTL_MS = 30 * 60 * 1000;
const TTL_VIDE_MS = 10 * 60 * 1000;
const MAX_ITEMS = 75;
const MAX_XML_OCTETS = 4 * 1024 * 1024;

export interface ItemNyaa {
  titre: string;
  hash: string;
  torrentUrl?: string;
  taille?: number;
  seeders?: number;
  categorie?: string;
}

const FACTEURS: Record<string, number> = {
  b: 1,
  kib: 1024,
  mib: 1024 ** 2,
  gib: 1024 ** 3,
  tib: 1024 ** 4,
};

/** « 44.7 GiB » -> octets. Nyaa n'expose la taille que sous cette forme. */
export function parseTaille(texte: string | null): number | undefined {
  if (!texte) return undefined;
  const m = texte.trim().match(/^([\d.]+)\s*(B|KiB|MiB|GiB|TiB)$/i);
  if (!m) return undefined;
  const valeur = Number(m[1]);
  if (!Number.isFinite(valeur)) return undefined;
  const facteur = FACTEURS[m[2].toLowerCase()];
  return facteur ? Math.round(valeur * facteur) : undefined;
}

/** Analyse le RSS Nyaa. Fonction pure : testee sans reseau. */
export function parseNyaaRss(xml: string): ItemNyaa[] {
  const out: ItemNyaa[] = [];
  for (const bloc of extractBlocks(xml, 'item').slice(0, MAX_ITEMS)) {
    const titre = tagText(bloc, 'title');
    // Nyaa prefixe ses champs propres : <nyaa:infoHash>, <nyaa:seeders>, <nyaa:size>.
    const hash = (tagText(bloc, 'nyaa:infoHash') || '').toLowerCase();
    if (!titre || !/^[a-f0-9]+$/.test(hash) || hash.length !== 40) continue;

    const seeders = Number(tagText(bloc, 'nyaa:seeders') || '');
    // <link> pointe le .torrent public : c'est lui qui rend l'arborescence des packs
    // decodable sans rien deposer chez un debrideur.
    const lien = tagText(bloc, 'link') || undefined;

    out.push({
      titre,
      hash,
      torrentUrl: lien && /^https?:/i.test(lien) ? lien : undefined,
      taille: parseTaille(tagText(bloc, 'nyaa:size')),
      seeders: Number.isFinite(seeders) ? seeders : undefined,
      categorie: tagText(bloc, 'nyaa:categoryId') || undefined,
    });
  }
  return out;
}

async function recuperer(
  base: string,
  categorie: string,
  terme: string,
  signal?: AbortSignal,
): Promise<ItemNyaa[] | null> {
  return cached<ItemNyaa[] | null>(
    `nyaa:${categorie}:${terme.toLowerCase()}`,
    TTL_MS,
    async () => {
      const url = `${base.replace(/\/+$/, '')}/?page=rss&c=${categorie}&f=0&q=${encodeURIComponent(terme)}`;
      const xml = await getText(url, {
        timeoutMs: 12000,
        signal,
        retries: 1,
        maxBytes: MAX_XML_OCTETS,
      });
      return xml === null ? null : parseNyaaRss(xml);
    },
    {
      scope: 'nyaa',
      echec: (v) => v === null,
      shouldCache: (v) => v !== null && v.length > 0,
      negativeTtlMs: TTL_VIDE_MS,
    },
  );
}

export function nyaaSource(): Source {
  return {
    id: 'nyaa',
    label: 'Nyaa',
    // Pas de cleRequise : source publique.

    async search(q: Query, ctx: SearchContext): Promise<Candidate[]> {
      // Ecartee quand la famille ne declare aucune categorie pour cette source.
      if (ctx.famille && sourceEcartee(ctx.famille, 'nyaa')) return [];
      const categoriesFamille = ctx.famille ? categoriesPour(ctx.famille, 'nyaa') : [];
      const conf = getSettings().nyaa;
      if (!conf.enabled) return [];
      const terme = (q.titres[0] || '').trim();
      if (!terme) return [];

      const vus = new Set<string>();
      const out: Candidate[] = [];
      let uneReponse = false;

      for (const categorie of (categoriesFamille.length ? categoriesFamille : conf.categories)) {
        if (ctx.signal?.aborted) break;
        const items = await recuperer(conf.url, String(categorie), terme, ctx.signal);
        if (items === null) continue;
        uneReponse = true;
        for (const item of items) {
          if (vus.has(item.hash)) continue;
          vus.add(item.hash);
          const { tomes, langue, format, provenance } = parseRelease(item.titre);
          out.push({
            source: 'nyaa',
            titre: item.titre,
            hash: item.hash,
            torrentUrl: item.torrentUrl,
            taille: item.taille,
            seeders: item.seeders,
            categorie: item.categorie,
            tomes,
            langue,
            format,
            provenance,
          });
        }
      }

      // Echec, pas resultat vide : voir la note dans torznab.ts.
      if (!uneReponse) throw new Error("Nyaa n'a rendu aucune reponse exploitable");
      return out;
    },
  };
}
