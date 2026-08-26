// TorBox (API v1).
//
// C'est le seul des deux debrideurs a exposer une VRAIE consultation de cache :
// `POST /torrents/checkcached` accepte un lot de hashs, ne depose rien, et repond
// exhaustivement. C'est lui qui permet d'afficher une page entiere de resultats avec
// leur etat de cache sans toucher au compte de l'utilisateur.
//
// Il sait aussi produire une archive de son cote (`requestdl` accepte `zip_link`), ce
// qui evite de faire transiter douze gigaoctets par le serveur pour recuperer un pack.

import axios from 'axios';
import { get as cacheGet, set as cacheSet, del as cacheDel } from '../core/cache';
import { tracer, hoteDe } from '../core/journal';
import type { DebridService, EtatCache, FichierDebride } from './types';

const BASE = 'https://api.torbox.app/v1/api';
/**
 * Taille de lot pour `checkcached`, MESUREE le 2026-08-20.
 *
 * L'endpoint se degrade de facon non lineaire : 20 hashs reviennent en 0,5 s, 50 en
 * 23,9 s, et 100 echouent sec. La valeur de 100 — reprise sans la verifier — faisait
 * donc echouer toute la colonne TorBox sur une page un peu fournie.
 */
const LOT_CACHE = 20;

/**
 * Lots simultanes.
 *
 * Les envoyer TOUS ensemble declenche une limitation de debit : apres une rafale,
 * TorBox ferme la connexion sans repondre pendant plusieurs minutes — verifie, et
 * `/user/me` continuait de repondre pendant ce temps, donc la limite est propre a cet
 * endpoint. Trois de front suffisent : six lots de 20 reviennent en environ une seconde.
 */
const LOTS_SIMULTANES = 3;
const TENTATIVES = 6;
const ATTENTE_MS = 1500;
const MAX_TORRENT_OCTETS = 4 * 1024 * 1024;

/**
 * Duree de memorisation d'un verdict de cache.
 *
 * Un « en-cache » est stable : le fichier restera dans le cache partage de TorBox. Un
 * « absent » doit expirer vite — il suffit qu'une personne le telecharge pour qu'il
 * devienne disponible.
 *
 * Ce cache n'est pas qu'une optimisation : mesure du 2026-08-20, TorBox traverse des
 * periodes ou il repond en 25 s ou pas du tout. Sans memorisation, une colonne
 * entierement renseignee redevenait « non verifie » a la recherche suivante.
 */
const TTL_PRESENT_MS = 30 * 60 * 1000;
const TTL_ABSENT_MS = 10 * 60 * 1000;

interface ReponseTb<T> {
  success?: boolean;
  detail?: string;
  data?: T;
}

interface TorrentTb {
  id: number;
  hash?: string;
  download_finished?: boolean;
  download_present?: boolean;
  files?: { id: number; name: string; short_name?: string; size?: number }[];
}

const RE_HASH = /^[a-f0-9]+$/;
const estHash = (h: string) => RE_HASH.test(h) && h.length === 40;

function entetes(apiKey: string): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}` };
}

async function tbGet<T>(chemin: string, apiKey: string, signal?: AbortSignal): Promise<T | null> {
  try {
    const res = await axios.get<ReponseTb<T>>(`${BASE}${chemin}`, {
      headers: entetes(apiKey),
      timeout: 20000,
      validateStatus: () => true,
      signal,
    });
    if (res.status < 200 || res.status >= 300 || !res.data?.success) return null;
    return (res.data.data ?? null) as T | null;
  } catch (e) {
    tracer('TorBox', `${chemin}: ${(e as Error).message}`);
    return null;
  }
}

async function tbPost<T>(
  chemin: string,
  apiKey: string,
  corps: unknown,
  formulaire = false,
  signal?: AbortSignal,
): Promise<T | null> {
  try {
    const charge = formulaire ? new URLSearchParams(corps as Record<string, string>) : corps;
    const res = await axios.post<ReponseTb<T>>(`${BASE}${chemin}`, charge, {
      headers: {
        ...entetes(apiKey),
        'Content-Type': formulaire ? 'application/x-www-form-urlencoded' : 'application/json',
      },
      timeout: 25000,
      validateStatus: () => true,
      signal,
    });
    if (res.status < 200 || res.status >= 300 || !res.data?.success) return null;
    return (res.data.data ?? null) as T | null;
  } catch (e) {
    tracer('TorBox', `${chemin}: ${(e as Error).message}`);
    return null;
  }
}

/**
 * Analyse une reponse de `checkcached`. Fonction pure : testee sans reseau.
 *
 * TorBox repond exhaustivement sur le lot demande : un hash qu'il ne cite pas, il ne
 * l'a pas. On peut donc conclure `absent`, ce qui est impossible avec StremThru.
 *
 * En revanche, une reponse qu'on ne sait pas lire ne conclut RIEN : tout reste
 * `inconnu`. Traduire une panne en « pas en cache » serait un mensonge.
 */
export function parseCheckCached(corps: unknown, hashes: string[]): Map<string, EtatCache> {
  const propres = hashes.map((h) => h.toLowerCase()).filter(estHash);
  const out = new Map<string, EtatCache>();

  const enCache = new Set<string>();
  let lisible = false;

  if (Array.isArray(corps)) {
    lisible = true;
    for (const item of corps) {
      const h = String((item as { hash?: unknown })?.hash ?? '').toLowerCase();
      if (estHash(h)) enCache.add(h);
    }
  } else if (corps && typeof corps === 'object') {
    lisible = true;
    for (const cle of Object.keys(corps as Record<string, unknown>)) {
      const h = cle.toLowerCase();
      if (estHash(h)) enCache.add(h);
    }
  }

  for (const h of propres) {
    out.set(h, enCache.has(h) ? 'en-cache' : lisible ? 'absent' : 'inconnu');
  }
  return out;
}

function attendre(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function trouverExistant(
  hash: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<TorrentTb | null> {
  const liste = await tbGet<TorrentTb[]>('/torrents/mylist?bypass_cache=true', apiKey, signal);
  if (!Array.isArray(liste)) return null;
  return liste.find((t) => (t.hash || '').toLowerCase() === hash) ?? null;
}

async function attendrePret(
  id: number,
  apiKey: string,
  signal?: AbortSignal,
): Promise<TorrentTb | null> {
  for (let i = 0; i < TENTATIVES; i++) {
    const info = await tbGet<TorrentTb | TorrentTb[]>(
      `/torrents/mylist?bypass_cache=true&id=${id}`,
      apiKey,
      signal,
    );
    const t = Array.isArray(info) ? info[0] : info;
    if (t && (t.download_finished || t.download_present)) return t;
    if (signal?.aborted) return null;
    await attendre(ATTENTE_MS);
  }
  return null;
}

/**
 * Depose le .torrent lui-meme quand on l'a.
 *
 * Sur un tracker PRIVE, un magnet construit a partir d'un hash nu ne porte aucun
 * annonceur, et le torrent ne figure pas dans le DHT : le depot reste inerte. Seul le
 * fichier .torrent porte l'adresse d'annonce. C'est nous qui le telechargeons, car son
 * lien est signe par la passkey de l'utilisateur.
 */
async function deposerFichier(
  torrentUrl: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<number | null> {
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
    tracer('TorBox', `recuperation du .torrent chez ${hoteDe(torrentUrl)}`);
    const res = await axios.get<ArrayBuffer>(torrentUrl, {
      responseType: 'arraybuffer',
      timeout: 15000,
      maxContentLength: MAX_TORRENT_OCTETS,
      validateStatus: () => true,
      signal,
    });
    if (res.status < 200 || res.status >= 300) return null;
    const contenu = Buffer.from(res.data);
    if (contenu.length === 0 || contenu[0] !== 0x64) return null; // doit commencer par 'd'

    const form = new FormData();
    form.append('file', new Blob([contenu]), 'release.torrent');
    form.append('seed', '3');
    form.append('allow_zip', 'true');

    const envoi = await axios.post<ReponseTb<{ torrent_id?: number }>>(
      `${BASE}/torrents/createtorrent`,
      form,
      { headers: entetes(apiKey), timeout: 30000, validateStatus: () => true, signal },
    );
    if (envoi.status < 200 || envoi.status >= 300 || !envoi.data?.success) {
      tracer('TorBox', `depot du .torrent refuse: HTTP ${envoi.status}`);
      return null;
    }
    return envoi.data.data?.torrent_id ?? null;
  } catch (e) {
    tracer('TorBox', `depot du .torrent: ${(e as Error).message}`);
    return null;
  }
}

function versFichiers(t: TorrentTb): FichierDebride[] {
  return (t.files ?? []).map((f) => ({
    id: f.id,
    nom: f.short_name || f.name,
    taille: f.size,
  }));
}

async function torrentDe(
  idOuHash: string,
  apiKey: string,
  signal?: AbortSignal,
): Promise<TorrentTb | null> {
  if (/^\d+$/.test(idOuHash)) {
    const info = await tbGet<TorrentTb | TorrentTb[]>(
      `/torrents/mylist?bypass_cache=true&id=${idOuHash}`,
      apiKey,
      signal,
    );
    return Array.isArray(info) ? info[0] ?? null : info;
  }
  return trouverExistant(idOuHash.toLowerCase(), apiKey, signal);
}

/**
 * Cle sentinelle signalant qu'au moins un lot n'a pas abouti.
 *
 * Elle n'est jamais un hash valide, donc elle ne peut pas entrer en collision.
 */
export const MARQUEUR_ECHEC = 'echec-verification';

export function torbox(apiKey: string): DebridService {
  return {
    nom: 'torbox',
    supporteVerificationCache: true,
    // `checkcached` est une consultation : rien n'est depose sur le compte.
    verificationDepose: false,
    // `requestdl` accepte `zip_link` — mesure du 2026-08-20.
    supporteZip: true,

    async verifierCache(hashes, signal) {
      const propres = [...new Set(hashes.map((h) => h.toLowerCase()).filter(estHash))];
      const out = new Map<string, EtatCache>();

      // Verdicts deja connus : ils survivent aux pannes de TorBox, et allegent d'autant
      // le nombre de requetes — donc le risque de limitation de debit.
      const aDemander: string[] = [];
      for (const h of propres) {
        const memorise = cacheGet<EtatCache>(`tb:dispo:${h}`);
        if (memorise === 'en-cache' || memorise === 'absent') out.set(h, memorise);
        else aDemander.push(h);
      }

      const lots: string[][] = [];
      for (let i = 0; i < aDemander.length; i += LOT_CACHE) lots.push(aDemander.slice(i, i + LOT_CACHE));

      // Concurrence BORNEE : en parallele pour ne pas faire attendre l'utilisateur,
      // mais pas tous d'un coup, sous peine de limitation de debit.
      let prochain = 0;
      let echecs = 0;
      const travailleur = async () => {
        while (prochain < lots.length) {
          if (signal?.aborted) return;
          const lot = lots[prochain++];
          const corps = await tbPost<unknown>(
            '/torrents/checkcached?format=list&list_files=false',
            apiKey,
            { hashes: lot },
            false,
            signal,
          );
          if (corps === null) {
            // Panne ou limitation : on ne conclut RIEN, et on ne memorise rien.
            echecs++;
            continue;
          }
          for (const [h, etat] of parseCheckCached(corps, lot)) {
            out.set(h, etat);
            cacheSet(`tb:dispo:${h}`, etat, etat === 'en-cache' ? TTL_PRESENT_MS : TTL_ABSENT_MS, 'torbox');
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(LOTS_SIMULTANES, lots.length) }, travailleur),
      );
      if (echecs > 0) {
        tracer('TorBox', `${echecs} lot(s) sans reponse : l etat reste inconnu`);
        // L'appelant doit pouvoir DIRE que TorBox n'a pas repondu, au lieu de laisser
        // croire a un « pas en cache » definitif.
        out.set(MARQUEUR_ECHEC, 'inconnu');
      }
      return out;
    },

    async deposer(hash, torrentUrl, signal) {
      const h = hash.toLowerCase();
      // Deposer CHANGE la reponse a « est-ce en cache ? ». Le verdict memorise devient
      // donc faux a cet instant precis, et le garder ferait mentir la prochaine
      // verification pendant tout son TTL — dix minutes pour un « absent ».
      cacheDel(`tb:dispo:${h}`);
      if (!estHash(h)) return null;

      // Deja dans la bibliotheque : inutile de le rajouter, et cela evite de polluer
      // le compte a chaque ouverture.
      const existant = await trouverExistant(h, apiKey, signal);
      if (existant?.download_finished || existant?.download_present) return String(existant.id);

      if (torrentUrl) {
        const id = await deposerFichier(torrentUrl, apiKey, signal);
        if (id !== null) {
          // ON NE RETOMBE PAS SUR LE MAGNET. Le depot a ete accepte : le torrent est
          // en route, il n'est simplement pas encore lisible. Ajouter le magnet
          // par-dessus creerait un doublon sans annonceur, bloque a « checking 0 % »
          // dans le compte de l'utilisateur.
          const pret = await attendrePret(id, apiKey, signal);
          return pret ? String(pret.id) : String(id);
        }
      }

      const cree = await tbPost<{ torrent_id?: number }>(
        '/torrents/createtorrent',
        apiKey,
        { magnet: `magnet:?xt=urn:btih:${h}`, seed: '3', allow_zip: 'true' },
        true,
        signal,
      );
      const id = cree?.torrent_id ?? existant?.id;
      if (id === undefined) return null;
      const pret = await attendrePret(id, apiKey, signal);
      return pret ? String(pret.id) : String(id);
    },

    async trouver(hash, signal) {
      const h = hash.toLowerCase();
      const liste = await tbGet<TorrentTb[]>('/torrents/mylist?bypass_cache=true', apiKey, signal);
      const trouve = (liste || []).find((t) => String(t.hash).toLowerCase() === h);
      return trouve?.id === undefined ? null : String(trouve.id);
    },

    async listerFichiers(idOuHash, signal) {
      const t = await torrentDe(idOuHash, apiKey, signal);
      return t ? versFichiers(t) : [];
    },

    async lienFichier(idOuHash, idFichier, signal) {
      const t = await torrentDe(idOuHash, apiKey, signal);
      if (!t) return null;
      const dl = await tbGet<{ url?: string } | string>(
        `/torrents/requestdl?token=${encodeURIComponent(apiKey)}` +
          `&torrent_id=${t.id}&file_id=${encodeURIComponent(String(idFichier))}&zip_link=false`,
        apiKey,
        signal,
      );
      if (typeof dl === 'string') return dl;
      return dl?.url ?? null;
    },

    async lienZip(idOuHash, signal) {
      const t = await torrentDe(idOuHash, apiKey, signal);
      if (!t) return null;
      const dl = await tbGet<{ url?: string } | string>(
        `/torrents/requestdl?token=${encodeURIComponent(apiKey)}&torrent_id=${t.id}&zip_link=true`,
        apiKey,
        signal,
      );
      if (typeof dl === 'string') return dl;
      return dl?.url ?? null;
    },
  };
}
