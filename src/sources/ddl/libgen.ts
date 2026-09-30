// LibGen — des livres et de la presse EN FRANCAIS, lisibles sans debrideur.
//
// CE QUI LA REND LISIBLE, mesure du 2026-09-15. Chaque resultat porte un md5. La page
// `ads.php?md5=` rend un lien `get.php?md5=…&key=…`, qui redirige (307) vers un CDN —
// `cdn2.booksdl.lc` ce jour-la. Ce CDN annonce la taille au HEAD, meme sans aucun en-tete, et
// honore les plages : quatre demandes sur la meme adresse, a 0, 5, 20 et 60 secondes, toutes
// en 206 avec le bon `Content-Range`. Le lecteur par plages s'y branche donc tel quel, comme
// pour fourtoutici.
//
// CE QUI LA REND DIFFICILE. La base de LibGen refuse des connexions au hasard : « User
// 'libgen_get' has exceeded the 'max_user_connections' resource ». Trois `ads.php` sur six ont
// abouti, `get.php` a rendu des 500 aussi, et une reponse a depasse trente secondes. D'ou :
//   - des ESSAIS, bornes par un DELAI TOTAL plutot que par un nombre, pour ne jamais faire
//     attendre au-dela de ce qu'un proxy tolere ;
//   - la resolution faite UNE FOIS a l'ouverture, puis gardee dix minutes : la sonde et la
//     lecture qui suit ne resollicitent pas LibGen, et chaque plage va directement au CDN,
//     qui, lui, est stable. Le meme lien `get.php` redirigeait encore quatre-vingt-dix
//     secondes plus tard : sa cle n'est pas a usage unique.
//
// SEULEMENT LE FRANCAIS : voir `libgen-liste.ts`.

import axios from 'axios';
import { cached } from '../../core/cache';
import { tracerAppel, hoteDe } from '../../core/journal';
import { verifierUrlSortante } from '../../debrid/adresse-interne';
import { cheminEtat } from '../../core/sqlite';
import { creerPrecharges, ErreurDefinitive, type SourcePrecharge } from '../../lecture/precharges';
import { parseRelease } from '../torrent/release';
import type { Candidate, Query, SearchContext, Source } from '../types';
import { identiteDdl } from './wawacity';
import {
  BASE_LIBGEN, adresseCdnAcceptable, estFrancais, formatLibgen, lienGetDepuisAds,
  lignesDeLaRecherche, rubriquesDeFamille, urlRechercheLibgen,
} from './libgen-liste';

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15';
const TTL_MS = 30 * 60 * 1000;
const TTL_VIDE_MS = 10 * 60 * 1000;
const MAX_RESULTATS = 60;
const ESSAIS_RECHERCHE = 2;
/** Garde du lien du CDN : assez pour sonder puis lire, bien moins que ce qu'il a tenu. */
const TTL_LIEN_MS = 10 * 60 * 1000;
/** Au-dela, la resolution abandonne : un proxy rendait un 502 nu vers cent secondes. */
const DELAI_RESOLUTION_MS = 40_000;
/** Un serveur du CDN vivant rendait son premier octet en moins de quatre secondes. */
const DELAI_SONDE_CDN_MS = 8_000;

/**
 * La patience de lecture envers le CDN, pour `ouvrirDistant`.
 *
 * Mesure du 2026-09-15, depuis le serveur qui tire 4 Mo/s de cdnjs : le CDN de LibGen rend
 * 24 a 400 Ko/s, et quatre plages paralleles se PARTAGENT ce debit au lieu de le
 * multiplier. Un Mo prenait 16 a 25 s : le delai total de 20 s le coupait en route. On ne
 * coupe donc que sur un silence, et jamais au-dela de trois minutes par plage.
 */
export const PATIENCE_LIBGEN = { inactiviteMs: 20_000, totalMs: 180_000 };

const pause = (ms: number) => new Promise((z) => { setTimeout(z, ms); });

/**
 * Les candidats d'une page de resultats : francais, et dans un format dont on fait quelque
 * chose.
 */
export function candidatsLibgen(html: string): Candidate[] {
  const out: Candidate[] = [];
  for (const l of lignesDeLaRecherche(html)) {
    if (!estFrancais(l.langue)) continue;
    const format = formatLibgen(l.extension);
    if (!format) continue;
    // LE NUMERO « #58 » D'UN ALBUM FAIT FOI : le parseur de release ne lit pas un nombre
    // colle a un diese. A defaut, il lit les tomes du titre, et la provenance dans tous les cas.
    const lu = parseRelease(l.titre);
    const tomes = l.numero !== undefined ? { debut: l.numero, integrale: false } : lu.tomes;
    const provenance = lu.provenance;
    // UN MAGAZINE PORTE SA DATE DANS LE TITRE : c'est elle que la presse lit pour dater et
    // trier les numeros. « Le Monde diplomatique #795 Juin 2020 ». Une annee seule — celle
    // d'un livre — reste dans l'edition.
    const titre = l.annee && !/^\d{4}$/.test(l.annee) ? `${l.titre} ${l.annee}` : l.titre;
    out.push({
      source: 'libgen',
      titre,
      // Pas d'empreinte : c'est du lien direct. L'identite porte le md5, qui suffit a tout.
      identite: identiteDdl('libgen', l.md5),
      tomes,
      langue: 'FR',
      format,
      provenance,
      taille: l.taille,
      // LES ISBN RENDENT LE RAPPROCHEMENT EXACT quand la fiche en connait un.
      isbns: l.isbns.length ? l.isbns : undefined,
      // L'EDITION A COTE DU TITRE, jamais dedans : voir `Candidate.edition`.
      edition: [l.auteur, l.editeur, l.annee, l.pages ? `${l.pages} p.` : '']
        .filter(Boolean).join(' · ') || undefined,
    });
    if (out.length >= MAX_RESULTATS) break;
  }
  return out;
}

/** Une page de resultats, avec un second essai : la base de LibGen refuse au hasard. */
async function pageDeRecherche(url: string, signal?: AbortSignal): Promise<string | null> {
  for (let essai = 1; essai <= ESSAIS_RECHERCHE; essai += 1) {
    const debut = Date.now();
    try {
      const r = await axios.get<string>(url, {
        timeout: 7000, signal, responseType: 'text', validateStatus: () => true,
        maxRedirects: 0, maxContentLength: 4 * 1024 * 1024,
        headers: { 'User-Agent': UA, Accept: 'text/html' },
      });
      tracerAppel({
        source: 'libgen', hote: hoteDe(BASE_LIBGEN), statut: r.status,
        duree: Date.now() - debut, ok: r.status === 200,
      });
      if (r.status === 200) return String(r.data || '');
    } catch (e) {
      tracerAppel({
        source: 'libgen', hote: hoteDe(BASE_LIBGEN), statut: null,
        duree: Date.now() - debut, ok: false, motif: (e as Error).message,
      });
      if (signal?.aborted) return null;
    }
    if (essai < ESSAIS_RECHERCHE) await pause(800);
  }
  return null;
}

export function libgenSource(): Source {
  return {
    id: 'libgen',
    label: 'LibGen',
    // Pas de `cleRequise` : site public, et lecture sans debrideur.

    async search(q: Query, ctx: SearchContext): Promise<Candidate[]> {
      const famille = ctx.famille?.id;
      if (!famille) return [];
      const rubriques = rubriquesDeFamille(famille);
      // L'audio n'existe pas chez LibGen : ce rayon repond vide sans requete.
      if (!rubriques.length) return [];
      const terme = (q.titres[0] || '').trim();
      if (!terme) return [];

      const candidats = await cached<Candidate[] | null>(
        `libgen:${rubriques.join('')}:${terme.toLowerCase()}`,
        TTL_MS,
        async () => {
          const html = await pageDeRecherche(urlRechercheLibgen(terme, rubriques), ctx.signal);
          return html === null ? null : candidatsLibgen(html);
        },
        {
          scope: 'libgen',
          echec: (v) => v === null,
          shouldCache: (v) => v !== null && v.length > 0,
          negativeTtlMs: TTL_VIDE_MS,
        },
      );
      // Echec, pas resultat vide : voir la note dans torznab.ts.
      if (candidats === null) {
        throw new Error("LibGen n'a pas repondu — sa base refuse des connexions par moments, reessayez");
      }
      return candidats;
    },
  };
}

/** Les liens du CDN deja resolus, par md5. En memoire : ils ne valent que quelques minutes. */
const liensCdn = new Map<string, { url: string; expire: number }>();

/** Le fichier est range sur un serveur du CDN qui ne repond pas. */
const EN_PANNE = Symbol('cdn en panne');

/**
 * Une tentative : ads.php, puis get.php, puis l'adresse du CDN verifiee. `null` quand LibGen
 * n'a pas repondu — une autre tentative peut aboutir ; `EN_PANNE` quand le CDN est mort.
 */
async function uneResolution(md5: string, limite: number): Promise<string | null | typeof EN_PANNE> {
  const delai = () => Math.max(1000, Math.min(15_000, limite - Date.now()));
  const debut = Date.now();
  try {
    const ads = await axios.get<string>(`${BASE_LIBGEN}/ads.php?md5=${md5}`, {
      timeout: delai(), responseType: 'text', validateStatus: () => true, maxRedirects: 0,
      maxContentLength: 1024 * 1024,
      headers: { 'User-Agent': UA, Accept: 'text/html', Referer: `${BASE_LIBGEN}/` },
    });
    tracerAppel({
      source: 'libgen', hote: hoteDe(BASE_LIBGEN), statut: ads.status,
      duree: Date.now() - debut, ok: ads.status === 200,
    });
    if (ads.status !== 200) return null;
    const get = lienGetDepuisAds(String(ads.data || ''), md5);
    if (!get) return null;

    // `maxRedirects: 0` VA AVEC `verifierUrlSortante` : on lit la redirection, on la juge,
    // et seulement ensuite on la suivra. Suivie d'office, elle pourrait mener a l'interne.
    const g = await axios.get(get, {
      timeout: delai(), responseType: 'arraybuffer', validateStatus: () => true, maxRedirects: 0,
      maxContentLength: 64 * 1024,
      headers: { 'User-Agent': UA, Referer: `${BASE_LIBGEN}/ads.php?md5=${md5}`, Range: 'bytes=0-0' },
    });
    tracerAppel({
      source: 'libgen', hote: hoteDe(BASE_LIBGEN), statut: g.status,
      duree: Date.now() - debut, ok: g.status === 307 || g.status === 302,
    });
    const cdn = adresseCdnAcceptable(g.headers.location as string | undefined, get);
    if (!cdn) return null;
    await verifierUrlSortante(cdn);

    // LE LIEN EST ESSAYE AVANT D'ETRE RENDU. Mesure du 2026-09-15 : le CDN a plusieurs
    // serveurs, et l'un d'eux, `cdn5.booksdl.lc`, repondait 503 puis ne repondait plus du
    // tout — soixante secondes sans un octet. Rendu tel quel, ce lien etait garde dix
    // minutes et la liseuse s'arretait sur « timeout of 20000ms exceeded ». Un octet
    // demande, un delai court : un serveur vivant repond en moins de quatre secondes.
    const t = Date.now();
    const sonde = await axios.get(cdn, {
      timeout: Math.min(DELAI_SONDE_CDN_MS, delai()), responseType: 'arraybuffer',
      validateStatus: () => true, maxRedirects: 0, maxContentLength: 64 * 1024,
      headers: { 'User-Agent': UA, Range: 'bytes=0-0' },
    }).then((s) => s.status, () => null);
    const vivant = sonde === 206 || sonde === 200;
    tracerAppel({
      source: 'libgen', hote: hoteDe(cdn), statut: sonde, duree: Date.now() - t, ok: vivant,
      motif: vivant ? undefined : 'serveur du CDN en panne',
    });
    // UN FICHIER RESTE SUR SON SERVEUR : quatre resolutions neuves du meme md5 ont toutes
    // redirige vers `cdn5`, ou echoue en 500. Reessayer ne fait qu'allonger l'attente.
    return vivant ? cdn : EN_PANNE;
  } catch (e) {
    tracerAppel({
      source: 'libgen', hote: hoteDe(BASE_LIBGEN), statut: null,
      duree: Date.now() - debut, ok: false, motif: (e as Error).message,
    });
    return null;
  }
}

export const MOTIF_CDN_EN_PANNE = 'le serveur de LibGen qui garde ce fichier est en panne — '
  + 'essayez une autre release du meme livre';
export const MOTIF_LIBGEN_MUET = "LibGen n'a pas rendu le fichier a temps — sa base refuse des "
  + 'connexions par moments, reessayez';

/**
 * L'adresse du fichier chez le CDN. `null` seulement pour un md5 mal forme.
 *
 * L'ECHEC SE DIT, IL NE SE TAIT PAS : une erreur porte la raison, parce que les deux pannes
 * demandent deux gestes differents — reessayer, ou choisir une autre release.
 *
 * `frais` force une nouvelle resolution : c'est ce que demande le lecteur quand un lien
 * expire. Sans lui, un lien de moins de dix minutes est rendu tel quel.
 */
export async function resoudreFichierLibgen(
  md5: string,
  options: { frais?: boolean } = {},
): Promise<string | null> {
  if (!/^[a-f0-9]{32}$/.test(String(md5 || ''))) return null;
  const memo = liensCdn.get(md5);
  if (!options.frais && memo && memo.expire > Date.now()) return memo.url;

  const limite = Date.now() + DELAI_RESOLUTION_MS;
  for (let essai = 1; Date.now() < limite; essai += 1) {
    const url = await uneResolution(md5, limite);
    if (url === EN_PANNE) throw new Error(MOTIF_CDN_EN_PANNE);
    if (url) {
      liensCdn.set(md5, { url, expire: Date.now() + TTL_LIEN_MS });
      return url;
    }
    const attente = 1000 * essai;
    if (Date.now() + attente >= limite) break;
    await pause(attente);
  }
  throw new Error(MOTIF_LIBGEN_MUET);
}

/**
 * Le resolveur a donner a `ouvrirDistant` : le lien garde a l'ouverture, un lien NEUF ensuite.
 *
 * `ouvrirDistant` ne rappelle `resoudre` qu'apres un 401, 403 ou 410 — un lien expire. Rendre
 * alors le meme lien garde ne servirait a rien.
 */
let precharges: ReturnType<typeof creerPrecharges> | null = null;

/**
 * Les prechargements LibGen. LA LECTURE PASSE PAR EUX : voir `lecture/precharges.ts` pour
 * les debits mesures qui l'imposent.
 *
 * Cree a l'usage, pas a l'import : un test qui importe ce module ne cree aucun dossier.
 * 10 Go en tout, 1 Go par fichier, deux a la fois — valide par Loo le 2026-09-15.
 */
export function prechargesLibgen(): ReturnType<typeof creerPrecharges> {
  if (!precharges) {
    precharges = creerPrecharges({
      dossier: () => cheminEtat('libgen'),
      maxFichierOctets: 1024 ** 3,
      maxDossierOctets: 10 * 1024 ** 3,
      simultanes: 2,
      // Le CDN s'est deja tu vingt secondes pleines sur un Ko : trente laissent sa chance
      // a un serveur lent sans laisser pourrir une connexion morte.
      silenceMs: 30_000,
      maxReprises: 8,
      attenteRepriseMs: 3_000,
    });
  }
  return precharges;
}

/** Ce que le prechargement demande a LibGen : le md5 pour nom, et le resolveur. */
export function sourcePrechargeLibgen(md5: string): SourcePrecharge {
  return {
    cle: md5,
    resoudre: async (frais) => {
      let url: string | null;
      try {
        url = await resoudreFichierLibgen(md5, { frais });
      } catch (e) {
        // LE SERVEUR EN PANNE NE REVIENT PAS : le fichier y reste — quatre resolutions
        // neuves y retombaient. Reprendre ne ferait qu'allonger l'attente.
        if ((e as Error).message === MOTIF_CDN_EN_PANNE) throw new ErreurDefinitive(MOTIF_CDN_EN_PANNE);
        throw e;
      }
      if (!url) throw new ErreurDefinitive('identite LibGen invalide');
      return url;
    },
  };
}

export function resolveurLibgen(md5: string): () => Promise<string | null> {
  let appels = 0;
  return () => resoudreFichierLibgen(md5, { frais: appels++ > 0 });
}
