// MangaDex comme source du kiosque.
//
// POURQUOI LUI EN PREMIER, ET MESURE DU 2026-09-02 : il est deja dans le projet — le
// catalogue `md:`, ses couvertures deja autorisees par la CSP — il ne demande aucune cle,
// et il repond aux deux questions. Les autres pistes ont ete essayees le meme jour :
// AniList rend 403 (« temporarily disabled due to severe stability issues »), Jikan rend
// 504 deux fois de suite, MangaUpdates n'a que J-1 et J.

import { getJson } from '../core/http';
import { tracerAppel } from '../core/journal';
import { cached } from '../core/cache';
import type { Famille } from '../familles/table';
import type { Entree, SourceKiosque } from './types';

const BASE = 'https://api.mangadex.org';
const TTL_MS = 10 * 60 * 1000;
const TTL_VIDE_MS = 60 * 1000;
const MAX = 24;

interface Relation {
  type: string;
  id?: string;
  attributes?: { fileName?: string; title?: Record<string, string> };
}
interface Ressource {
  id: string;
  attributes: Record<string, unknown>;
  relationships?: Relation[];
}

/**
 * Le titre affichable d'une ressource MangaDex.
 *
 * L'ANGLAIS D'ABORD, PUIS N'IMPORTE QUOI. Le champ `title` est un dictionnaire par langue,
 * et il n'a PAS toujours de clef `en` : certaines series n'existent qu'en `ja` ou en `ko`.
 * Rendre une chaine vide dans ce cas ferait une ligne sans nom, ce qui est pire qu'un
 * titre dans une langue qu'on ne lit pas.
 */
export function titreDe(titres: Record<string, string> | undefined): string {
  if (!titres) return '';
  const valeurs = Object.entries(titres);
  const en = valeurs.find(([k]) => k === 'en')?.[1];
  return String(en ?? valeurs[0]?.[1] ?? '').trim();
}

/** L'etat d'une serie, dans les mots du projet. Inconnu reste vide plutot qu'invente. */
export function etatDe(statut: unknown): string | undefined {
  const table: Record<string, string> = {
    ongoing: 'en cours', completed: 'termine', hiatus: 'en pause', cancelled: 'abandonne',
  };
  return table[String(statut ?? '')] ?? undefined;
}

/** L'adresse d'une couverture, ou rien. Meme forme que le catalogue, deja dans la CSP. */
export function couvertureDe(id: string, relations: Relation[] | undefined): string | undefined {
  const f = relations?.find((r) => r.type === 'cover_art')?.attributes?.fileName;
  return f ? `https://uploads.mangadex.org/covers/${id}/${f}.256.jpg` : undefined;
}

/**
 * Les series les plus suivies, telles que le kiosque les affiche.
 *
 * PUR, POUR ETRE TESTE SUR UNE VRAIE REPONSE. La capture vit dans
 * `tests/fixtures/md-tendances.json` : les formes de MangaDex ne se devinent pas — un
 * titre est un dictionnaire de langues, une couverture est une relation.
 */
export function parseTendances(corps: unknown): Entree[] {
  const data = (corps as { data?: Ressource[] })?.data ?? [];
  const out: Entree[] = [];
  for (const m of data) {
    const a = m.attributes ?? {};
    const titre = titreDe(a.title as Record<string, string> | undefined);
    if (!titre) continue;
    out.push({
      id: `md:${m.id}`,
      titre,
      source: 'mangadex',
      // Une tendance n'a pas d'instant : elle est un CLASSEMENT, pas un evenement.
      quand: null,
      detail: a.year ? String(a.year) : undefined,
      etat: etatDe(a.status),
      couverture: couvertureDe(m.id, m.relationships),
      oeuvre: `md:${m.id}`,
    });
    if (out.length >= MAX) break;
  }
  return out;
}

async function demander(url: string, cle: string, signal?: AbortSignal): Promise<unknown> {
  const debut = Date.now();
  return cached<unknown>(
    cle,
    TTL_MS,
    async () => {
      const j = await getJson(url, { timeoutMs: 12000, signal, retries: 1 });
      tracerAppel({
        source: 'mangadex',
        hote: 'api.mangadex.org',
        statut: j === null ? null : 200,
        duree: Date.now() - debut,
        ok: j !== null,
      });
      // ECHEC, PAS RESULTAT VIDE : la meme regle que partout ailleurs dans ce projet. Une
      // panne rendue comme une liste vide se lit « rien ne bouge dans ce rayon ».
      if (j === null) throw new Error("mangadex n'a rendu aucune reponse exploitable");
      return j;
    },
    { scope: 'kiosque:mangadex', echec: (v) => v === null, negativeTtlMs: TTL_VIDE_MS },
  );
}

/**
 * MANGADEX NE SERT QUE LES TENDANCES, ET C'EST UNE CORRECTION.
 *
 * Il a servi « vient de sortir » pendant une journee : ses derniers chapitres traduits en
 * francais. Or MangaDex est un CATALOGUE de ce projet — il nomme les oeuvres, il donne les
 * couvertures et les fiches — et non une SOURCE : rien de ce qu'il publie ne se telecharge
 * par Book Loo Store. La section montrait donc des chapitres illisibles ici, et un clic
 * menait a la fiche, d'ou il fallait ENCORE lancer une recherche.
 *
 * « MangaDex c'est pas une de nos sources » — signale a l'usage, et c'est exact. Ce qui
 * avait ete valide etait « ce qui vient de sortir CHEZ TES SOURCES » ; j'ai bati sur
 * MangaDex parce que c'etait mesurable en dix minutes, sans dire que je changeais de plan.
 *
 * UN CLASSEMENT DE POPULARITE, LUI, EST BIEN LE METIER D'UN CATALOGUE : il nomme ce qui
 * merite d'etre cherche, et le clic mene a la fiche, d'ou les vraies sources sont
 * interrogees. `tendances` reste donc, `nouveautes` s'en va.
 */
export const mangadexKiosque: SourceKiosque = {
  id: 'mangadex',
  libelle: 'MangaDex',
  // LES MANGAS SEULEMENT. Son index couvre aussi des manhwa et des manhua, mais pas les
  // comics ni la BD franco-belge : les declarer ici les ferait paraitre servis.
  familles: ['mangas'],

  async tendances(_famille: Famille, signal?: AbortSignal): Promise<Entree[]> {
    const url = `${BASE}/manga?limit=${MAX}&order[followedCount]=desc`
      + '&contentRating[]=safe&contentRating[]=suggestive&includes[]=cover_art';
    return parseTendances(await demander(url, 'kiosque:md:tendances', signal));
  },

};
