// Catalogue ComicVine.
//
// CE N'EST PAS UN CATALOGUE AMERICAIN. Sonde du 2026-08-22 : Blacksad (Dargaud), Lanfeust
// de Troy (Soleil), Thorgal (Splitter), XIII (Cinebook), Le Chat du Rabbin (Dargaud),
// Largo Winch (Dupuis) — six titres franco-belges cherches, six trouves avec leur editeur
// d'origine. Il sert donc les familles Comics ET BD, ce qui evite d'aller chercher une
// seconde source de metadonnees pour la bande dessinee.
//
// La cle appartient a l'OPERATEUR, comme l'adresse de la facade Telegram : elle n'est pas
// propre a un utilisateur. Sans elle, les deux familles retombent sur la recherche libre.

import { getJson } from '../core/http';
import { getSettings } from '../core/settings';
import type { Oeuvre } from './mangadex';
import { nombreDeTomes } from './nombres';

const BASE = 'https://comicvine.gamespot.com/api';
const MAX = 20;
// ComicVine refuse les requetes sans agent identifiable.
const ENTETES = { 'User-Agent': 'Bookloo/1.0 (+https://github.com/Loo-stick/bookloo)' };

interface VolumeCv {
  id?: number | string;
  name?: string;
  start_year?: string | null;
  publisher?: { name?: string } | null;
  description?: string | null;
  image?: { medium_url?: string } | null;
}

/** Retire le HTML rendu par ComicVine. L'inserer tel quel serait une injection. */
function sansHtml(brut: string): string {
  return brut.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Convertit un volume ComicVine en `Oeuvre`. PUR, donc testable sans reseau. */
export function normaliserVolume(brut: unknown): Oeuvre | null {
  const v = brut as VolumeCv | null;
  if (!v || typeof v !== 'object') return null;
  const titre = typeof v.name === 'string' ? v.name.trim() : '';
  if (!titre || v.id === undefined || v.id === null) return null;

  const annee = Number(v.start_year);
  const synopsis = typeof v.description === 'string' ? sansHtml(v.description) : undefined;

  return {
    id: String(v.id),
    titre,
    titres: [titre],
    // ComicVine ne rend qu'un titre par volume : c'est la seule forme a envoyer aux
    // trackers. La rendre en tableau garde le contrat identique a MangaDex.
    formes: [titre],
    auteur: v.publisher?.name || undefined,
    annee: Number.isFinite(annee) && annee > 0 ? annee : undefined,
    synopsis: synopsis || undefined,
    couverture: v.image?.medium_url || undefined,
    dernierTome: nombreDeTomes((v as { count_of_issues?: unknown }).count_of_issues),
  };
}

function cle(): string {
  return getSettings().comicvine.cle;
}

export async function chercherComicvine(titre: string, signal?: AbortSignal): Promise<Oeuvre[]> {
  if (!cle() || !titre.trim()) return [];
  const url = `${BASE}/search/?api_key=${encodeURIComponent(cle())}&format=json`
    + `&resources=volume&limit=${MAX}&query=${encodeURIComponent(titre)}`;
  const r = await getJson<{ results?: unknown[] }>(url, {
    timeoutMs: 10000, signal, headers: ENTETES,
  });
  // `null` signale un ECHEC, jamais un resultat vide : la distinction remonte jusqu'a
  // l'interface, ou « vide » et « n'a pas repondu » ne disent pas la meme chose.
  if (r === null) throw new Error('ComicVine n a pas repondu');
  return (r.results || []).map(normaliserVolume).filter((o): o is Oeuvre => o !== null);
}

export async function ficheComicvine(id: string, signal?: AbortSignal): Promise<Oeuvre | null> {
  if (!cle()) return null;
  // Les volumes ComicVine s'adressent en `4050-<id>`.
  const url = `${BASE}/volume/4050-${encodeURIComponent(id)}/?api_key=${encodeURIComponent(cle())}`
    + '&format=json';
  const r = await getJson<{ results?: unknown }>(url, {
    timeoutMs: 10000, signal, headers: ENTETES,
  });
  if (r === null) return null;
  return normaliserVolume(r.results);
}
