// Client Torznab generique : YggReborn, C411, Tr4ker.
//
// Les trois exposent le meme protocole, donc un seul client les couvre et ajouter un
// tracker tient en une entree de configuration.
//
// DEUX REGLES MESUREES LE 2026-08-20, chacune corrigeant une panne silencieuse :
//
//   1. `t=book-search` est ANNONCE disponible par les caps de C411 et Tr4ker, et
//      n'existe pas : les deux repondent `<error code="202" description="No such
//      function"/>`. On n'emet que `t=search`.
//   2. Les categories multiples se joignent par des VIRGULES. `cat=7103&cat=7102` ne
//      retient que la premiere — mesure sur Ygg : 1 resultat au lieu de 18. Un
//      `append` en boucle ferait donc disparaitre la moitie du catalogue sans lever
//      la moindre erreur.

import { getText } from '../../core/http';
import { cached } from '../../core/cache';
import { extractBlocks, tagText, attrOf, torznabAttrs } from '../../core/xml';
import { getSettings, type IndexeurTorznab } from '../../core/settings';
import { tracer } from '../../core/journal';
import { parseRelease } from './release';
import type { Candidate, NomCle, Query, SearchContext, Source } from '../types';
import { categoriesPour, sourceEcartee } from '../../familles/table';

const TTL_MS = 30 * 60 * 1000;
const TTL_VIDE_MS = 10 * 60 * 1000;
const MAX_ITEMS = 100;
const MAX_XML_OCTETS = 4 * 1024 * 1024;

export interface TorznabItem {
  titre: string;
  hash?: string;
  torrentUrl?: string;
  taille?: number;
  seeders?: number;
  categorie?: string;
}

/** Analyse une reponse Torznab. Fonction pure : testee sans reseau. */
export function parseTorznab(xml: string): TorznabItem[] {
  const out: TorznabItem[] = [];

  for (const bloc of extractBlocks(xml, 'item').slice(0, MAX_ITEMS)) {
    const titre = tagText(bloc, 'title');
    if (!titre) continue;

    const attrs = torznabAttrs(bloc);
    const enclosure = attrOf(bloc, 'enclosure', 'url') || undefined;
    const lien = tagText(bloc, 'link') || undefined;
    const magnet = [enclosure, lien].find((u) => u && u.startsWith('magnet:'));

    // Les trackers PRIVES ne publient pas de magnet : leur enclosure pointe le
    // .torrent, seule forme qui porte l'annonceur. Sans ce lien, le debrideur ne
    // recevrait qu'un hash nu, inutilisable hors DHT.
    const torrentUrl = [enclosure, lien].find((u) => u && /^https?:/i.test(u));

    let hash = attrs.infohash?.toLowerCase();
    if (!hash && magnet) {
      const m = magnet.match(/btih:([a-f0-9]+)/i);
      if (m && m[1].length === 40) hash = m[1].toLowerCase();
    }
    if (!hash) {
      const guid = tagText(bloc, 'guid');
      if (guid && /^[a-f0-9]+$/i.test(guid) && guid.length === 40) hash = guid.toLowerCase();
    }

    const tailleBrute = attrs.size || tagText(bloc, 'size');
    const taille = tailleBrute ? Number(tailleBrute) : NaN;

    out.push({
      titre,
      hash,
      torrentUrl,
      taille: Number.isFinite(taille) && taille > 0 ? taille : undefined,
      seeders: attrs.seeders !== undefined ? Number(attrs.seeders) || 0 : undefined,
      categorie: attrs.category || tagText(bloc, 'category') || undefined,
    });
  }
  return out;
}

/**
 * URL d'interrogation. Exportee pour que le test puisse verifier la forme du `cat`
 * sans passer par le reseau — c'est precisement le detail qui casse en silence.
 */
export function construireUrl(
  indexeur: IndexeurTorznab,
  apiKey: string,
  params: Record<string, string>,
  categories: (string | number)[] = [],
): string {
  // Les categories de la FAMILLE priment. Celles de l'indexeur restent le repli : une
  // famille qui ne declare rien pour cette source ne doit pas produire une requete sans
  // `cat`, qui ramenerait le tracker entier.
  const cat = (categories.length ? categories : indexeur.categories).join(',');
  const qs = new URLSearchParams({
    apikey: apiKey,
    cat,
    limit: String(MAX_ITEMS),
    ...params,
  });
  return `${indexeur.url.replace(/\/+$/, '')}?${qs.toString()}`;
}

/**
 * Requetes tentees, dans l'ordre.
 *
 * TROIS formes au maximum, et non deux. Mesure du 2026-08-20 : pour « Smiley! », la
 * forme qui trouve les treize releases — « Smile » — arrive en troisieme position une
 * fois les titres non latins ecartes. S'arreter a deux ne rendait rien.
 */
function requetesPour(q: Query): Record<string, string>[] {
  const formes: string[] = [];
  for (const t of q.titres) {
    const propre = t.trim();
    if (propre && !formes.includes(propre)) formes.push(propre);
    if (formes.length === 3) break;
  }
  return formes.map((titre) => ({ t: 'search', q: titre }));
}

async function recuperer(
  idIndexeur: string,
  indexeur: IndexeurTorznab,
  apiKey: string,
  params: Record<string, string>,
  categories: (string | number)[],
  signal?: AbortSignal,
): Promise<TorznabItem[] | null> {
  // La CLE N'ENTRE PAS dans la cle de cache : deux utilisateurs qui cherchent la meme
  // oeuvre sur le meme tracker partagent le resultat, et aucune passkey ne s'ecrit sur
  // disque.
  //
  // Le revers doit etre traite : `null` signale un ECHEC — passkey refusee, indexeur
  // injoignable — et n'est jamais memorise. Autrement, une passkey expiree rendrait le
  // tracker vide pour TOUT LE MONDE pendant la duree du TTL negatif.
  // Les CATEGORIES entrent dans la cle. Sans elles, une recherche « livres » et une
  // recherche « mangas » sur le meme titre partageraient la meme entree — et la seconde
  // rendrait les resultats de la premiere, sans que rien ne le signale.
  const cle = `torznab:${idIndexeur}:${categories.join(',')}:${JSON.stringify(params)}`;
  return cached<TorznabItem[] | null>(
    cle,
    TTL_MS,
    async () => {
      const xml = await getText(construireUrl(indexeur, apiKey, params, categories), {
        timeoutMs: 12000,
        signal,
        retries: 1,
        maxBytes: MAX_XML_OCTETS,
      });
      return xml === null ? null : parseTorznab(xml);
    },
    {
      scope: 'torznab',
      echec: (v) => v === null,
      shouldCache: (v) => v !== null && v.length > 0,
      negativeTtlMs: TTL_VIDE_MS,
    },
  );
}

function versCandidat(idSource: string, item: TorznabItem): Candidate {
  const { tomes, langue, format, provenance } = parseRelease(item.titre);
  return {
    source: idSource,
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
  };
}

function fabriquerSource(id: string, label: string, cleRequise: NomCle): Source {
  return {
    id,
    label,
    cleRequise,

    async search(q: Query, ctx: SearchContext): Promise<Candidate[]> {
      const settings = getSettings();
      const indexeur = settings.torznab[id];
      if (!indexeur?.enabled) return [];
      const apiKey = ctx.cles[cleRequise];
      if (!apiKey) return [];

      // Une source que la famille ne declare PAS n'est pas interrogee. Ygg n'a aucune
      // categorie audiobook : lui envoyer la requete rendrait du bruit, ou le tracker
      // entier si `cat` partait vide.
      const categoriesFamille = ctx.famille ? categoriesPour(ctx.famille, id) : [];
      if (ctx.famille && sourceEcartee(ctx.famille, id)) return [];

      const vus = new Set<string>();
      const out: Candidate[] = [];
      let uneReponse = false;

      for (const params of requetesPour(q)) {
        if (ctx.signal?.aborted) break;
        const items = await recuperer(id, indexeur, apiKey, params, categoriesFamille, ctx.signal);
        if (items === null) {
          tracer('Torznab', `${label}: aucune reponse exploitable`);
          continue;
        }
        uneReponse = true;
        for (const item of items) {
          // Sans hash, on ne peut ni interroger le cache ni deposer chez le debrideur.
          // On garde quand meme l'entree si un lien .torrent permet de le calculer.
          const identite = item.hash || item.torrentUrl || item.titre;
          if (vus.has(identite)) continue;
          vus.add(identite);
          out.push(versCandidat(id, item));
        }
      }

      // AUCUNE requete n'a abouti : c'est un ECHEC, pas un resultat vide. Rendre []
      // ferait afficher « vide » — c'est-a-dire « cette oeuvre n'existe pas sur ce
      // tracker » — pour un indexeur injoignable ou une passkey refusee. Constate en
      // condition reelle : Ygg et C411 annonces vides alors qu'ils ne repondaient pas.
      if (!uneReponse) throw new Error(`${label} n'a rendu aucune reponse exploitable`);
      return out;
    },
  };
}

export function torznabSources(): Source[] {
  return [
    fabriquerSource('yggreborn', 'YggReborn', 'ygg'),
    fabriquerSource('c411', 'C411', 'c411'),
    fabriquerSource('tr4ker', 'Tr4ker', 'tr4ker'),
    fabriquerSource('v3x', 'V3X', 'v3x'),
  ];
}
