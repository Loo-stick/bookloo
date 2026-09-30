// Google Books, POUR LES ISBN ET RIEN D'AUTRE.
//
// POURQUOI CETTE SOURCE EXISTE ICI. Un ISBN designe une EDITION, pas une oeuvre. Booknode
// rend celui de l'edition poche ; Z-Library indexe celui de l'editeur d'origine. Mesure du
// 2026-08-24 sur sept livres : les deux ne se recoupent JAMAIS — 0 sur 7. Google Books,
// lui, rend les ISBN de toutes les editions qu'il connait : 4 recoupements sur 4 cas
// aboutis (Holly 4 ISBN communs, L'Outsider 4, La Horde du Contrevent 2, Vernon
// Subutex 10).
//
// CE N'EST PAS UN CATALOGUE. Il ne rend ni fiche ni couverture, et n'apparait nulle part
// dans l'interface. Il enrichit une fiche deja construite par Booknode ou Open Library.
//
// IL N'EST JAMAIS APPELE DEPUIS LA RECHERCHE. Mesure : 2 requetes sur 6 ont rendu 503,
// meme apres quatre reprises avec attente croissante. Un service qui tombe une fois sur
// trois n'a rien a faire dans le chemin critique. Il n'est appele qu'a l'ouverture d'une
// fiche, dont le resultat est en cache 24 h, et son echec ne coute qu'une fiche sans ISBN.

import { getJson } from '../core/http';
import { cached } from '../core/cache';
import { getSettings } from '../core/settings';

const BASE = 'https://www.googleapis.com/books/v1/volumes';
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_VOLUMES = 20;

interface VolumeGb {
  volumeInfo?: {
    industryIdentifiers?: { type?: string; identifier?: string }[];
  };
}

/**
 * Normalise un ISBN : chiffres et X final, rien d'autre.
 *
 * Les tirets sont typographiques et placés differemment selon les sources : comparer
 * « 978-2-226-48147-4 » a « 9782226481474 » echouerait sur une difference qui n'existe
 * pas.
 */
export function normaliserIsbn(brut: string): string | null {
  const n = String(brut ?? '').replace(/[^0-9X]/gi, '').toUpperCase();
  return n.length === 10 || n.length === 13 ? n : null;
}

/** Extrait tous les ISBN d'une reponse Google Books. PUR, donc testable sans reseau. */
export function isbnsDeVolumes(brut: unknown): string[] {
  const items = (brut as { items?: VolumeGb[] })?.items;
  if (!Array.isArray(items)) return [];
  const out = new Set<string>();
  for (const v of items) {
    for (const id of v?.volumeInfo?.industryIdentifiers ?? []) {
      // `OTHER` couvre des identifiants maison qui ne sont pas des ISBN.
      if (!/^ISBN/i.test(String(id?.type ?? ''))) continue;
      const n = normaliserIsbn(String(id?.identifier ?? ''));
      if (n) out.add(n);
    }
  }
  return [...out];
}

/**
 * Les ISBN de toutes les editions connues d'un livre.
 *
 * Rend un tableau VIDE sur tout echec — cle absente, service en panne, aucun resultat.
 * L'appelant n'a pas a les distinguer : dans les trois cas la fiche n'aura pas d'ISBN, et
 * le rapprochement se fera au titre comme avant.
 */
export async function isbnsPour(
  titre: string, auteur?: string, signal?: AbortSignal,
): Promise<string[]> {
  const cle = getSettings().googlebooks.cle.trim();
  const t = titre.trim();
  if (!cle || !t) return [];

  // Le titre ET l'auteur : « L'Outsider » seul rend des dizaines d'oeuvres sans rapport,
  // et leurs ISBN pollueraient le rapprochement en le rendant faussement certain.
  const requete = auteur?.trim() ? `${t} ${auteur.trim()}` : t;

  const corps = await cached<unknown>(
    `googlebooks:isbn:${requete.toLowerCase()}`,
    TTL_MS,
    () => {
      const u = `${BASE}?${new URLSearchParams({
        q: requete, maxResults: String(MAX_VOLUMES), printType: 'books', key: cle,
      })}`;
      // `retries: 2` : les 503 de ce service sont passagers, et l'appel n'est fait qu'une
      // fois par fiche.
      return getJson<unknown>(u, { timeoutMs: 12000, signal, retries: 2 });
    },
    { scope: 'googlebooks', echec: (v) => v === null, shouldCache: (v) => v !== null },
  );
  return corps === null ? [] : isbnsDeVolumes(corps);
}
