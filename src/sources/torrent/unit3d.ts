// Tracker UNIT3D — Gemini aujourd'hui.
//
// Chez Dramallyu, UNIT3D est la MEILLEURE source : on y cherche par `tmdbId`, donc sans
// aucune approximation de romanisation. Ici cet avantage disparait — TMDB ne connait pas
// les manga — et on retombe sur une recherche par nom, qui chez Gemini est tres
// permissive : `name=manga` remonte « The Mandalorian ». Le filtrage par categorie n'est
// donc pas une optimisation, c'est une necessite.
//
// DEUX MESURES DU 2026-08-20 qui pilotent tout ce fichier :
//
//   - Gemini ne publie NI `info_hash` NI `magnet_link`. Le hash exige de telecharger le
//     .torrent, ce qui coute une requete HTTP par resultat. On plafonne, et les
//     candidats au-dela sont rendus SANS hash plutot que jetes en silence — l'interface
//     les montrera comme non verifiables.
//   - `num_file` EST fourni. La distinction « tome isole / pack » est donc gratuite sur
//     cette source, sans toucher au .torrent.

import { createHash } from 'node:crypto';
import { getJson, httpGet } from '../../core/http';
import { tracerAppel, hoteDe } from '../../core/journal';
import { sansSecretUrl, avecSecretUrl } from './secret-url';
import { cached } from '../../core/cache';
import { infoHashDepuisTorrent } from '../../core/bencode';
import { getSettings } from '../../core/settings';
import { parseRelease } from './release';
import type { Candidate, NomCle, Query, SearchContext, Source } from '../types';
import { categoriesPour, sourceEcartee } from '../../familles/table';

const TTL_MS = 30 * 60 * 1000;
const TTL_VIDE_MS = 10 * 60 * 1000;
const PAR_PAGE = 50;

/**
 * Plafond de telechargements de .torrent par recherche.
 *
 * Chaque unite est une requete HTTP de plus dans un fan-out qui doit tenir sous
 * quelques secondes. Les .torrent de scans sont petits, mais leur nombre ne l'est pas :
 * une recherche « naruto » rend des dizaines de tomes.
 */
const MAX_TELECHARGEMENTS = 8;
const MAX_TORRENT_OCTETS = 2 * 1024 * 1024;

interface AttributsUnit3d {
  name?: string;
  size?: number | string;
  seeders?: number | string;
  num_file?: number | string;
  category?: string;
  info_hash?: string | null;
  magnet_link?: string | null;
  download_link?: string;
}

function nombre(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Analyse une reponse UNIT3D. Fonction pure : testee sans reseau. */
/**
 * L'identite d'une release SANS EMPREINTE, et elle doit etre UNIQUE.
 *
 * Elle valait `u3d:<source>:${brut.id ?? ''}` : quand l'API ne rend pas d'`id`, toutes
 * les releases recevaient la MEME identite, terminee par un vide. Or c'est cette identite
 * qui indexe le lien memorise cote serveur — `memoriserLien(userId, hash || identite)` :
 * la derniere ecrasait les precedentes, et cliquer sur la premiere ouvrait la derniere.
 * Signale par une revue de code le 2026-08-29.
 *
 * A defaut d'`id`, le TITRE distingue. Il n'est pas garanti unique — deux releases
 * homonymes existent — mais cela ramene la collision de « toutes les releases sans id »
 * a « deux releases portant exactement le meme nom », qui est deja le comportement du
 * reste du pipeline.
 */
export function identiteDeSecours(idSource: string, brut: unknown, titre: string): string {
  const id = (brut as { id?: unknown })?.id;
  if (id !== undefined && id !== null && String(id) !== '') return `u3d:${idSource}:${id}`;
  return `u3d:${idSource}:t:${createHash('sha1').update(titre).digest('hex').slice(0, 16)}`;
}

/**
 * Le corps d'une reponse UNIT3D, prive des jetons que portent ses liens.
 *
 * Le cache est persistant et partage : ce qui y entre doit pouvoir etre lu par n'importe
 * quel compte sans rien lui apprendre.
 */
export function anonymiserCorps(corps: unknown): unknown {
  const c = corps as { data?: unknown };
  if (!c || !Array.isArray(c.data)) return corps;
  return {
    ...c,
    data: c.data.map((e) => {
      const a = (e as { attributes?: { download_link?: string } })?.attributes;
      if (!a?.download_link) return e;
      return {
        ...(e as object),
        attributes: { ...a, download_link: sansSecretUrl(a.download_link) },
      };
    }),
  };
}

export function parseUnit3d(idSource: string, corps: unknown, jeton = ''): Candidate[] {
  const data = (corps as { data?: unknown })?.data;
  if (!Array.isArray(data)) return [];

  const out: Candidate[] = [];
  for (const brut of data) {
    const a: AttributsUnit3d = (brut as { attributes?: AttributsUnit3d })?.attributes ?? {};
    const titre = (a.name || '').trim();
    if (!titre) continue;

    let hash: string | undefined;
    const brutHash = a.info_hash;
    if (typeof brutHash === 'string' && /^[a-f0-9]+$/i.test(brutHash) && brutHash.length === 40) {
      hash = brutHash.toLowerCase();
    }
    if (!hash && typeof a.magnet_link === 'string') {
      const m = a.magnet_link.match(/btih:([a-f0-9]+)/i);
      if (m && m[1].length === 40) hash = m[1].toLowerCase();
    }

    const { tomes, langue, format, provenance } = parseRelease(titre);
    out.push({
      source: idSource,
      titre,
      hash,
      // UNE IDENTITE MEME SANS EMPREINTE. `torrentUrl` porte le jeton de telechargement
      // de l'utilisateur : `sansSecret` la retire avant que la carte atteigne le
      // navigateur, et le client n'avait alors plus AUCUN moyen de designer une release
      // dont on n'a pas encore calcule le hash. Il ne pouvait donc pas en demander une.
      identite: hash ? undefined : identiteDeSecours(idSource, brut, titre),
      // Le lien sorti du cache est anonyme : on y remet le jeton du DEMANDEUR. Sans cette
      // reinjection le tracker le refuserait ; avec celui d'un autre, ce serait une fuite.
      torrentUrl: a.download_link ? avecSecretUrl(a.download_link, 'api_token', jeton) : undefined,
      taille: nombre(a.size),
      seeders: a.seeders !== undefined ? Number(a.seeders) || 0 : undefined,
      categorie: a.category,
      nbFichiers: nombre(a.num_file),
      tomes,
      langue,
      format,
      provenance,
    });
  }
  return out;
}

/**
 * Complete les hashs manquants en telechargeant les .torrent, dans la limite du plafond.
 *
 * Les candidats non completes GARDENT leur place dans la liste. Les jeter reviendrait a
 * cacher a l'utilisateur des releases qui existent, au seul motif qu'on n'a pas voulu
 * payer une requete de plus.
 */
async function completerHashes(candidats: Candidate[], signal?: AbortSignal): Promise<void> {
  let faits = 0;
  for (const c of candidats) {
    if (faits >= MAX_TELECHARGEMENTS || signal?.aborted) return;
    if (c.hash || !c.torrentUrl) continue;
    faits++;
    const res = await httpGet<ArrayBuffer>(c.torrentUrl, {
      responseType: 'buffer',
      timeoutMs: 10000,
      retries: 0,
      signal,
      maxBytes: MAX_TORRENT_OCTETS,
    });
    if (!res || res.status >= 400) continue;
    const hash = infoHashDepuisTorrent(Buffer.from(res.data as ArrayBuffer));
    if (hash) {
      c.hash = hash;
      // L'IDENTITE DISPARAIT AVEC L'EMPREINTE. Elle n'existe que pour designer une
      // release dont on n'a PAS le hash. La laisser en place faisait porter les deux au
      // meme candidat : le client le classait « sans empreinte », affichait « Obtenir
      // l empreinte », et le clic cherchait un lien memorise sous l'identite alors qu'il
      // l'etait sous le hash. Defaut signale a l'usage — le bouton revenait a son
      // libelle sans rien faire.
      c.identite = undefined;
    }
  }
}

function fabriquerSource(id: string, label: string, cleRequise: NomCle): Source {
  return {
    id,
    label,
    cleRequise,

    async search(q: Query, ctx: SearchContext): Promise<Candidate[]> {
      // Une famille qui ne declare aucun type pour cette source n'est pas interrogee :
      // sans `types[]`, la requete rendrait la categorie entiere — c'est-a-dire des
      // mangas dans une recherche de romans.
      if (ctx.famille && sourceEcartee(ctx.famille, id)) return [];
      const indexeur = getSettings().unit3d[id];
      if (!indexeur?.enabled) return [];
      const jeton = ctx.cles[cleRequise];
      if (!jeton) return [];

      const titre = (q.titres[0] || '').trim();
      if (!titre) return [];

      const types = ctx.famille ? categoriesPour(ctx.famille, id) : [];

      // `categories[]` est la forme attendue par UNIT3D. URLSearchParams echapperait
      // les crochets en %5B%5D, que l'API ne reconnait pas : l'URL se compose donc a la
      // main, chaque valeur restant encodee individuellement.
      const url =
        `${indexeur.url.replace(/\/+$/, '')}/api/torrents/filter` +
        `?api_token=${encodeURIComponent(jeton)}` +
        // DEUX AXES, ET C'EST LA GRANULARITE DU TRACKER. Chez UNIT3D, `category_id` est le
        // CONTENANT — 12 = « Livres » — et `type_id` dit ce que c'est vraiment :
        // 27 Livres, 28 Livres\BD, 29 Livres\Comics, 30 Livres\Mangas, 25/26/33 pour
        // l'audio. La categorie vient donc du reglage, et la famille fournit les types.
        //
        // Mesure du 2026-08-25, requete « Holly » : categories[]=12 rend 13 resultats
        // dont 12 mangas ; en ajoutant types[]=27, il en reste UN — le bon.
        `&categories[]=${encodeURIComponent(String(indexeur.categorie))}` +
        types.map((t) => `&types[]=${encodeURIComponent(String(t))}`).join('') +
        `&name=${encodeURIComponent(titre)}&perPage=${PAR_PAGE}`;

      // La cle reste hors de la cle de cache, comme pour Torznab.
      // LES TYPES FONT PARTIE DE LA CLE. Sans eux, les quatre familles se partageaient la
      // meme reponse : une recherche de livres rendait ce qu'une recherche de mangas
      // venait de mettre en cache, et le filtre par type n'avait aucun effet visible.
      // C'est le meme defaut que celui deja corrige sur Torznab, reste ici.
      const corps = await cached<unknown>(
        `unit3d:${id}:${types.join(',')}:${titre.toLowerCase()}`,
        TTL_MS,
        async () => {
          const debut = Date.now();
          const r = await getJson<unknown>(url, {
            timeoutMs: 12000, signal: ctx.signal, retries: 1,
          });
          // L'HOTE, JAMAIS L'URL : le jeton API y voyage en parametre de requete.
          tracerAppel({
            source: id,
            hote: hoteDe(indexeur.url),
            statut: r === null ? null : 200,
            duree: Date.now() - debut,
            ok: r !== null,
          });
          // LE JETON SORT AVANT LE CACHE. Celui-ci est PERSISTANT et sa cle n'inclut pas
          // l'utilisateur : le corps brut, `download_link` compris, s'ecrivait sur disque et
          // le compte suivant recevait le jeton du premier. On cache donc un corps ANONYME,
          // et chacun y remet le sien a la lecture.
          return r === null ? null : anonymiserCorps(r);
        },
        {
          scope: 'unit3d',
          echec: (v) => v === null,
          shouldCache: (v) => v !== null,
          negativeTtlMs: TTL_VIDE_MS,
        },
      );

      if (corps === null) {
        // Echec, pas resultat vide : voir la note dans torznab.ts.
        throw new Error(`${label} n'a rendu aucune reponse exploitable`);
      }

      const candidats = parseUnit3d(id, corps, jeton);
      await completerHashes(candidats, ctx.signal);
      return candidats;
    },
  };
}

export function unit3dSources(): Source[] {
  return [fabriquerSource('g3mini', 'Gemini', 'g3mini')];
}
