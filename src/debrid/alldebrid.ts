// AllDebrid.
//
// LE POINT DELICAT DE TOUT LE PROJET, et il tient en une phrase : chez AllDebrid,
// verifier le cache, c'est deposer.
//
// AllDebrid a supprime son endpoint de disponibilite instantanee. La seule facon de
// connaitre l'etat d'un hash est `POST /magnet/upload`, dont la reponse porte `ready` —
// mais qui DEPOSE le magnet sur le compte. Si le torrent n'est pas en cache, AllDebrid
// commence a le telecharger et le magnet compte dans le plafond de magnets actifs.
//
// D'ou quatre regles, chacune corrigeant un defaut observe dans Dramallyu ou
// stream-fusion :
//
//   1. UN SEUL HASH A LA FOIS. La fonction jette si on lui en passe plusieurs. Sur une
//      page de quarante resultats, un lot ferait quarante depots — la garantie ne peut
//      pas reposer sur la discipline de l'appelant. Les lots passent par StremThru.
//   2. LE RETRAIT EST ATTENDU, et son resultat est rendu a l'appelant pour affichage.
//      Dramallyu le lance en tache de fond et son journal prevoit deja le cas « NON
//      RETIRES, ils restent dans le compte » : l'utilisateur doit le savoir tout de
//      suite, pas dans un fichier de log.
//   3. PHOTOGRAPHIER LE COMPTE AVANT. On ne retire que ce qu'on vient d'ajouter, sinon
//      on supprime les telechargements que l'utilisateur avait lances lui-meme.
//   4. UNE ERREUR D'API NE CONCLUT RIEN. Plafond atteint, service en panne : l'etat
//      reste « inconnu ». Traduire une limite de compte en « pas en cache » serait faux.
//
// VERSION D'API : `/v4/magnet/status` est DISCONTINUE (mesure du 2026-08-20, reponse
// `code: DISCONTINUED`). Tout passe donc par `v4.1`, ou `magnet/status`, `magnet/files`,
// `magnet/delete` et `link/unlock` repondent tous.

import axios from 'axios';
import { tracer, hoteDe } from '../core/journal';
import { verifierUrlSortante } from './adresse-interne';
import { abandonnerPlutotQueMagnetNu } from './repli';
import type { DebridService, EtatCache, FichierDebride, ResultatVerification } from './types';

const BASE = 'https://api.alldebrid.com/v4.1';

/** Un .torrent de bande dessinee pese quelques dizaines de Ko ; 4 Mo est deja genereux. */
const MAX_TORRENT_OCTETS = 4 * 1024 * 1024;
const AGENT = 'mangaloo';

/**
 * Mesure du 2026-08-20 : la reponse de `/magnet/status` ne porte AUCUN champ d'archive
 * (`completionDate`, `filename`, `hash`, `id`, `nbLinks`, `notified`, `size`, `status`,
 * `statusCode`, `type`, `uploadDate`, `version`), et aucun endpoint de zip n'existe.
 * Le bouton « tout recuperer » n'apparaitra donc pas pour AllDebrid — plutot qu'un
 * bouton qui echouerait.
 */
export const CAPACITE_ZIP_MESUREE = false;

const RE_HASH = /^[a-f0-9]+$/;
const estHash = (h: string) => RE_HASH.test(h) && h.length === 40;

interface ReponseAd<T> {
  status?: string;
  data?: T;
  error?: { code?: string; message?: string };
}

interface FichierDeposeAd {
  hash?: string;
  id?: number | string;
  ready?: boolean;
  error?: { code?: string; message?: string };
}

/**
 * Identifiant rendu par un depot de FICHIER .torrent. Pur, donc testable sans reseau.
 *
 * La forme differe de celle du depot par hash : `data.files[]` et non `data.magnets[]`.
 * Les confondre rendait `null` sur un depot pourtant reussi, et l'appelant retombait sur
 * le magnet nu — c'est-a-dire sur le defaut qu'on corrige.
 */
export function idDepuisDepotFichier(data: unknown): string | null {
  const f = (data as { files?: FichierDeposeAd[] } | null)?.files?.[0];
  if (!f || f.error || f.id === undefined || f.id === null) return null;
  return String(f.id);
}

/**
 * Depose le FICHIER .torrent, seul porteur de l'annonceur.
 *
 * POURQUOI C'EST NECESSAIRE. Un torrent de tracker prive n'est pas dans le DHT et son
 * magnet ne porte aucun annonceur : depose sous forme de hash nu, il reste inerte —
 * AllDebrid n'a aucun moyen d'aller le chercher. Constate a l'usage : sur TorBox tout
 * fonctionnait, sur AllDebrid rien ne se mettait jamais en cache.
 *
 * C'EST NOUS QUI TELECHARGEONS le .torrent, comme le fait deja TorBox : son lien est
 * signe par la passkey de l'utilisateur, et elle n'a rien a faire chez un tiers.
 */
async function deposerFichier(
  torrentUrl: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    // TRACE DELIBEREE, et la seule de ce fichier.
    //
    // C'est LE geste qui touche le tracker : recuperer le .torrent enregistre un
    // telechargement chez lui, et son annonceur porte le passkey. Il doit donc etre
    // visible dans les journaux, sans quoi on ne peut ni le constater ni le dementir —
    // ce qui a coute une journee d'enquete le 2026-08-26.
    //
    // L'URL n'est PAS journalisee : elle porte le passkey.
    // On journalise l'HOTE seulement : le passkey vit dans le chemin et la requete.
    tracer('AllDebrid', `recuperation du .torrent chez ${hoteDe(torrentUrl)}`);
    // NI L'INTERNE, NI LES REDIRECTIONS. L'URL vient d'un tracker et n'etait validee que
    // par « ^https?: ». Une URL forgee pointant vers une adresse privee ferait lire le
    // contenu par le serveur, puis le televerser chez le debrideur ou il devient lisible.
    // Signale par une revue de code le 2026-08-29.
    //
    // Les deux gardes vont ENSEMBLE : sans `maxRedirects: 0`, un hote public redirigerait
    // vers l'interne apres la verification.
    await verifierUrlSortante(torrentUrl);
    const res = await axios.get<ArrayBuffer>(torrentUrl, {
      responseType: 'arraybuffer',
      timeout: 15000,
      maxContentLength: MAX_TORRENT_OCTETS,
      maxRedirects: 0,
      validateStatus: () => true,
      signal,
    });
    if (res.status < 200 || res.status >= 300) return null;
    const contenu = Buffer.from(res.data);
    // Un .torrent est du bencode : il commence par 'd'. Une page d'erreur du tracker,
    // elle, commence par '<' — et serait acceptee sans ce controle.
    if (contenu.length === 0 || contenu[0] !== 0x64) return null;

    const form = new FormData();
    form.append('files[]', new Blob([contenu]), 'release.torrent');

    const envoi = await axios.post<ReponseAd<unknown>>(
      `${BASE}/magnet/upload/file?agent=${AGENT}`,
      form,
      {
        headers: { Authorization: `Bearer ${apiKey}` },
        timeout: 30000,
        validateStatus: () => true,
        maxRedirects: 0,
        signal,
      },
    );
    if (envoi.status !== 200 || envoi.data?.status !== 'success') {
      tracer('AllDebrid', `depot du .torrent refuse (${envoi.status})`);
      return null;
    }
    return idDepuisDepotFichier(envoi.data.data);
  } catch (e) {
    tracer('AllDebrid', `depot du .torrent impossible : ${(e as Error).message}`);
    return null;
  }
}

async function appel<T>(
  chemin: string,
  apiKey: string,
  params: Record<string, string | string[]>,
  signal?: AbortSignal,
  methode: 'get' | 'post' = 'get',
): Promise<{ data: T | null; codeErreur?: string }> {
  const corps = new URLSearchParams();
  for (const [cle, valeur] of Object.entries(params)) {
    if (Array.isArray(valeur)) for (const v of valeur) corps.append(cle, v);
    else corps.append(cle, valeur);
  }
  try {
    const url = `${BASE}${chemin}?agent=${AGENT}`;
    const res =
      methode === 'post'
        ? await axios.post<ReponseAd<T>>(url, corps.toString(), {
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            timeout: 25000,
            validateStatus: () => true,
            signal,
          })
        : await axios.get<ReponseAd<T>>(`${url}&${corps.toString()}`, {
            headers: { Authorization: `Bearer ${apiKey}` },
            timeout: 25000,
            validateStatus: () => true,
            signal,
          });
    const body = res.data;
    if (!body || body.status === 'error') {
      return { data: null, codeErreur: body?.error?.code || 'INCONNU' };
    }
    return { data: (body.data ?? null) as T | null };
  } catch (e) {
    tracer('AllDebrid', `${chemin}: ${(e as Error).message}`);
    return { data: null, codeErreur: 'RESEAU' };
  }
}

interface EntreeAd {
  n?: string;
  s?: number;
  l?: string;
  e?: EntreeAd[];
}

/**
 * Aplatit l'arborescence rendue par `/magnet/files`.
 *
 * Seules les entrees porteuses d'un lien sont gardees : les dossiers n'en ont pas, et
 * les retenir ferait proposer a l'utilisateur un « fichier » qui ne se telecharge pas.
 */
export function aplatirEntrees(entrees: EntreeAd[] | undefined): FichierDebride[] {
  const out: FichierDebride[] = [];
  const descendre = (liste: EntreeAd[] | undefined) => {
    if (!Array.isArray(liste)) return;
    for (const e of liste) {
      if (Array.isArray(e?.e)) descendre(e.e);
      else if (e?.l && e?.n) out.push({ id: e.l, nom: e.n, taille: e.s, lien: e.l });
    }
  };
  descendre(entrees);
  return out;
}

interface MagnetAd {
  id?: number | string;
  hash?: string;
  ready?: boolean;
  statusCode?: number;
  files?: EntreeAd[];
}

/** Hashs deja presents sur le compte, AVANT que la verification n'y touche. */
async function magnetsExistants(
  apiKey: string,
  signal?: AbortSignal,
): Promise<Set<string> | null> {
  const { data } = await appel<{ magnets?: MagnetAd[] }>('/magnet/status', apiKey, {}, signal);
  if (!data?.magnets) return null;
  const out = new Set<string>();
  for (const m of data.magnets) if (m.hash) out.add(String(m.hash).toLowerCase());
  return out;
}

/**
 * Verifie UN hash, et rend compte du depot ET de son retrait.
 *
 * C'est la seule operation de Mangaloo qui touche le compte de l'utilisateur. Elle rend
 * donc tout ce qu'il faut pour le lui dire honnetement.
 */
export async function verifierUnHash(
  hash: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<ResultatVerification> {
  const h = hash.toLowerCase();
  if (!estHash(h)) return { etat: 'inconnu', retire: null, message: 'hash invalide' };

  const dejaLa = await magnetsExistants(apiKey, signal);
  if (dejaLa === null) {
    // On n'a pas pu photographier le compte : deposer maintenant reviendrait a risquer
    // de supprimer ensuite un magnet de l'utilisateur, ou d'en laisser un des notres.
    return {
      etat: 'inconnu',
      retire: null,
      message: "l'etat du compte AllDebrid est illisible, aucun depot n'a ete tente",
    };
  }

  const { data, codeErreur } = await appel<{ magnets?: MagnetAd[] }>(
    '/magnet/upload',
    apiKey,
    { 'magnets[]': [h] },
    signal,
    'post',
  );

  if (!data?.magnets?.length) {
    // Plafond de magnets actifs atteint, service en panne : on ne conclut RIEN.
    return {
      etat: 'inconnu',
      retire: null,
      message: `AllDebrid n'a pas repondu a la verification (${codeErreur ?? 'sans code'})`,
    };
  }

  const m = data.magnets[0];
  const etat: EtatCache = m.ready === true ? 'en-cache' : 'absent';
  const etaitDejaLa = dejaLa.has(h);

  if (etaitDejaLa) {
    return {
      etat,
      retire: null,
      message: 'ce torrent etait deja sur votre compte, rien n a ete ajoute ni retire',
    };
  }

  if (m.id === undefined) {
    return {
      etat,
      retire: false,
      message: "AllDebrid n a pas rendu d identifiant : le depot n a PAS pu etre retire",
    };
  }

  // Retrait ATTENDU, pas lance en tache de fond : l'utilisateur doit savoir tout de
  // suite si un magnet est reste sur son compte.
  const { codeErreur: erreurRetrait } = await appel(
    '/magnet/delete',
    apiKey,
    { id: String(m.id) },
    signal,
  );
  const retire = erreurRetrait === undefined;

  return {
    etat,
    retire,
    message: retire
      ? 'depot de verification retire du compte'
      : `le depot n a PAS pu etre retire (${erreurRetrait}) : il reste sur votre compte AllDebrid`,
  };
}

export function allDebrid(apiKey: string): DebridService {
  return {
    nom: 'alldebrid',
    supporteVerificationCache: true,
    // Interroger AllDebrid, c'est deposer. L'interface doit pouvoir le dire.
    verificationDepose: true,
    supporteZip: CAPACITE_ZIP_MESUREE,

    async verifierCache(hashes, signal) {
      if (hashes.length > 1) {
        throw new Error(
          'AllDebrid ne se verifie que sur un seul hash a la fois : chaque verification ' +
            'depose un magnet. Pour un lot, passer par StremThru.',
        );
      }
      const out = new Map<string, EtatCache>();
      if (hashes.length === 0) return out;
      const h = hashes[0].toLowerCase();
      const r = await verifierUnHash(h, apiKey, signal);
      out.set(h, r.etat);
      return out;
    },

    async deposer(hash, torrentUrl, signal) {
      const h = hash.toLowerCase();
      if (!estHash(h)) return null;

      // Le FICHIER d'abord : lui seul porte l'annonceur, et sans annonceur un torrent de
      // tracker prive reste inerte chez AllDebrid.
      //
      // ON NE RETOMBE PAS SUR LE MAGNET quand le depot a ete accepte. Ajouter le hash
      // par-dessus creerait un doublon sans annonceur, bloque dans le compte — meme
      // piege que celui deja documente cote TorBox.
      if (torrentUrl) {
        const id = await deposerFichier(torrentUrl, apiKey, signal);
        if (id !== null) return id;
        // ET ON N'Y RETOMBE PAS DAVANTAGE QUAND LE DEPOT A ECHOUE. Le paragraphe
        // ci-dessus ne valait que pour le succes : un tracker en panne, un timeout ou
        // une page d'erreur a la place du bencode faisaient tomber le code sur le magnet
        // nu — le piege exact qu'il pretend eviter. Signale par une revue le 2026-08-29.
        if (abandonnerPlutotQueMagnetNu(torrentUrl)) return null;
      }

      const { data } = await appel<{ magnets?: MagnetAd[] }>(
        '/magnet/upload',
        apiKey,
        { 'magnets[]': [h] },
        signal,
        'post',
      );
      const id = data?.magnets?.[0]?.id;
      return id === undefined ? null : String(id);
    },

    async trouver(hash, signal) {
      const h = hash.toLowerCase();
      if (!estHash(h)) return null;
      const { data } = await appel<{ magnets?: MagnetAd[] }>('/magnet/status', apiKey, {}, signal);
      const trouve = (data?.magnets || []).find((m) => String(m.hash).toLowerCase() === h);
      return trouve?.id === undefined ? null : String(trouve.id);
    },

    async listerFichiers(idOuHash, signal) {
      let id = idOuHash;
      if (estHash(idOuHash.toLowerCase())) {
        const { data } = await appel<{ magnets?: MagnetAd[] }>('/magnet/status', apiKey, {}, signal);
        const trouve = data?.magnets?.find(
          (m) => String(m.hash || '').toLowerCase() === idOuHash.toLowerCase(),
        );
        if (trouve?.id === undefined) return [];
        id = String(trouve.id);
      }
      const { data } = await appel<{ magnets?: MagnetAd[] }>(
        '/magnet/files',
        apiKey,
        { 'id[]': [id] },
        signal,
      );
      const entree = data?.magnets?.[0];
      return aplatirEntrees(entree?.files);
    },

    async lienFichier(_idOuHash, idFichier, signal) {
      // Chez AllDebrid, l'identifiant d'un fichier EST son lien intermediaire : il faut
      // encore le passer par /link/unlock pour obtenir un lien telechargeable.
      const lien = String(idFichier);
      if (!/^https?:/i.test(lien)) return null;
      const { data } = await appel<{ link?: string }>(
        '/link/unlock',
        apiKey,
        { link: lien },
        signal,
        'post',
      );
      return data?.link ?? null;
    },

    async lienZip() {
      // AllDebrid ne sait pas produire d'archive (mesure du 2026-08-20). On rend null
      // plutot que d'exposer un bouton qui echouerait.
      return null;
    },
  };
}
