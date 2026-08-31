// Hebergeurs reellement pris en charge par chaque debrideur.
//
// POURQUOI CE FICHIER EXISTE, et la lecon vient de Dramallyu : une liste d'hebergeurs
// « debridables » ecrite a la main y etait fausse DANS LES DEUX SENS — elle retenait
// DailyUploads et Nitroflare, qu'AllDebrid ne prend pas, et ignorait ce que TorBox prend.
// Resultat : des liens proposes qui ne pouvaient pas s'ouvrir, et d'autres, utilisables,
// ecartes sans raison.
//
// Les deux services publient leur liste. On la leur demande.
//
//   AllDebrid : GET /v4/user/hosts        -> { hosts: { "1fichier": { status } } }
//   TorBox    : GET /v1/api/webdl/hosters -> [ { name, domains[], status } ]
//
// Le STATUT compte autant que la presence : un hebergeur connu mais marque inactif
// echouera au deblocage.

import axios from 'axios';
import { cached } from '../core/cache';
import { tracer } from '../core/journal';
import type { NomService } from './index';

// Ces listes bougent rarement ; les redemander a chaque release serait absurde.
const TTL_MS = 12 * 60 * 60 * 1000;

/** « 1Fichier », « 1fichier.com », « www.turbobit.net » -> forme comparable. */
export function normaliserHote(nom: string): string {
  return nom
    .toLowerCase()
    .replace(/^www\./, '')
    .replace(/\.(com|net|org|io|to|co|me|cc|link|app)$/g, '')
    .replace(/[^a-z0-9]/g, '');
}

export function parseHotesAllDebrid(corps: unknown): Set<string> {
  const hosts = (corps as { data?: { hosts?: Record<string, { status?: boolean }> } })?.data?.hosts;
  const out = new Set<string>();
  if (!hosts || typeof hosts !== 'object') return out;
  for (const [nom, info] of Object.entries(hosts)) {
    // Un statut ABSENT est considere actif : mesure du 2026-08-20, dailyuploads est
    // publie sans statut, et l'ecarter priverait d'un hebergeur qui fonctionne.
    if (info && info.status === false) continue;
    out.add(normaliserHote(nom));
  }
  return out;
}

export function parseHotesTorbox(corps: unknown): Set<string> {
  const data = (corps as { data?: unknown })?.data;
  const out = new Set<string>();
  if (!Array.isArray(data)) return out;
  for (const brut of data) {
    const h = brut as { name?: string; domains?: unknown; status?: boolean };
    if (h?.status === false) continue;
    if (h?.name) out.add(normaliserHote(h.name));
    // Les domaines comptent autant que le nom : le site annonce « DailyUploads » la ou
    // le lien porte « dailyuploads.net ».
    if (Array.isArray(h?.domains)) {
      for (const d of h.domains) if (typeof d === 'string') out.add(normaliserHote(d));
    }
  }
  return out;
}

/**
 * Cet hebergeur est-il exploitable ?
 *
 * Une liste VIDE veut dire « on n'a pas pu savoir » : on ne declare alors rien
 * exploitable, plutot que de promettre un deblocage qui echouera.
 */
export function hoteExploitable(hebergeur: string, supportes: Set<string>): boolean {
  if (supportes.size === 0) return false;
  return supportes.has(normaliserHote(hebergeur));
}

export async function hotesSupportes(service: NomService, cle: string): Promise<Set<string>> {
  // La cle N'ENTRE PAS dans la cle de cache : la liste est la meme pour tous les
  // utilisateurs d'un meme service, et aucune cle ne s'ecrit sur disque.
  const liste = await cached<string[] | null>(
    `hotes:${service}`,
    TTL_MS,
    async () => {
      try {
        const url =
          service === 'alldebrid'
            ? 'https://api.alldebrid.com/v4/user/hosts?agent=mangaloo'
            : 'https://api.torbox.app/v1/api/webdl/hosters';
        const res = await axios.get(url, {
          headers: { Authorization: `Bearer ${cle}` },
          timeout: 15000,
          validateStatus: () => true,
        });
        if (res.status < 200 || res.status >= 300) return null;
        const set =
          service === 'alldebrid' ? parseHotesAllDebrid(res.data) : parseHotesTorbox(res.data);
        return set.size > 0 ? [...set] : null;
      } catch (e) {
        tracer('Hotes', `${service}: ${(e as Error).message}`);
        return null;
      }
    },
    { scope: 'hotes', echec: (v) => v === null, shouldCache: (v) => v !== null },
  );
  return new Set(liste ?? []);
}
