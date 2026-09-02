// bookys — source en LIEN DIRECT pour les rayons dessines.
//
// CE QU'ELLE APPORTE. Mesure du 2026-09-01 : « Berserk » y rend 49 tomes, « Blacksad »
// 22 — un fonds que les trackers couvrent mal en francais. Les titres sont propres et
// portent leur tome : « Berserk - Tome 35 - Kentaro Miura ».
//
// CE QU'ELLE COUTE, ET POURQUOI ELLE DECLARE SON BUDGET. Le site est derriere un defi
// Cloudflare : chaque recherche passe par flaresolverr et met quatorze secondes a chaud,
// dix-sept a froid, la ou un tracker en met deux. Sous le budget commun du fan-out —
// quinze secondes — elle etait abandonnee a chaque recherche, avec une pastille « echec »
// qui ne voulait pas dire qu'elle n'avait rien trouve. Les resultats partant au fil de
// l'eau, son budget propre ne fait attendre personne.
//
// ELLE NE REPOND QUE POUR LES FAMILLES DESSINEES. bookys range aussi des romans, des
// magazines et des journaux : sur « Berserk » il en rend dix-sept, dont le titre contient
// simplement le mot cherche. Les laisser entrer remplirait un rayon Mangas de journaux.
// Sa presse, elle, se consulte au kiosque — qui a son propre ecran.

import { cached } from '../../core/cache';
import { pageViaFlaresolverr } from '../../core/flaresolverr';
import { tracerAppel, hoteDe } from '../../core/journal';
import { decodeEntities } from '../../core/xml';
import { parseRelease } from '../torrent/release';
import type { Candidate, Query, SearchContext, Source } from '../types';
import { identiteDdl, type LienDdl } from './wawacity';

const BASE = 'https://www7.bookys-ebooks.com';
const TTL_MS = 60 * 60 * 1000;
const TTL_VIDE_MS = 10 * 60 * 1000;
const MAX_RESULTATS = 60;

/**
 * Ce que bookys range ou, PAR FAMILLE.
 *
 * Une famille absente n'est pas interrogee du tout : bookys coute quatorze secondes, et
 * lui demander des romans quand on cherche un manga ne rendrait que du bruit.
 *
 * La presse a rejoint la table le 2026-09-01, quand elle est devenue une famille a part
 * entiere. Elle n'est pas un cas particulier : elle declare ses rubriques comme les
 * autres, et herite du reste.
 */
const SECTIONS_PAR_FAMILLE: Record<string, string[]> = {
  mangas: ['bandes-dessinees'],
  comics: ['bandes-dessinees'],
  bd: ['bandes-dessinees'],
  presse: ['journaux', 'magazines'],
};

/**
 * Le budget propre de cette source.
 *
 * Quarante secondes : deux fois et demie le cout mesure, pour couvrir un demarrage de
 * session flaresolverr. Voir l'en-tete.
 */
const BUDGET_MS = 40_000;

const texteNu = (h: string) => decodeEntities(h.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/**
 * Les candidats d'une page de recherche.
 *
 * SEULES LES SECTIONS DEMANDEES SONT RETENUES. Le chemin de chaque fiche dit sa rubrique,
 * et c'est la seule chose qui distingue un tome de Berserk d'un journal dont le titre
 * contient « Berserk » — mesure du 2026-09-01 : cette recherche rend 49 bandes dessinees,
 * mais aussi 11 magazines, 4 romans et 2 journaux.
 */
export function parseRechercheBookys(html: string, sections: string[]): Candidate[] {
  const parId = new Map<string, string>();
  const motif = new RegExp(
    `<a[^>]+href="[^"]*bookys-ebooks\\.com/(?:${sections.join('|')})/(\\d+)-[^"]*"[^>]*>([\\s\\S]*?)</a>`,
    'g',
  );
  for (const m of html.matchAll(motif)) {
    const texte = texteNu(m[2]);
    if (!texte) continue;
    const connu = parId.get(m[1]);
    if (connu === undefined || texte.length > connu.length) parId.set(m[1], texte);
  }

  const out: Candidate[] = [];
  for (const [id, titre] of parId) {
    const { tomes, langue, format, provenance } = parseRelease(titre);
    out.push({
      source: 'bookys',
      titre,
      // Pas de hash : c'est du lien direct. L'identite est synthetique, et tout le chemin
      // debrideur la connait deja.
      identite: identiteDdl('bookys', id),
      tomes,
      langue,
      format,
      provenance,
    });
    if (out.length >= MAX_RESULTATS) break;
  }
  return out;
}

async function page(url: string, cle: string, signal?: AbortSignal): Promise<string | null> {
  const debut = Date.now();
  return cached<string | null>(
    cle,
    TTL_MS,
    async () => {
      const h = await pageViaFlaresolverr(url, signal);
      tracerAppel({
        source: 'bookys',
        hote: hoteDe(url),
        statut: h === null ? null : 200,
        duree: Date.now() - debut,
        ok: h !== null,
      });
      return h;
    },
    {
      scope: 'bookys',
      echec: (v) => v === null,
      shouldCache: (v) => v !== null,
      negativeTtlMs: TTL_VIDE_MS,
    },
  );
}

export function bookysSource(): Source {
  return {
    id: 'bookys',
    label: 'bookys',
    // Pas de cleRequise : le site est public. Ce sont les DEBRIDEURS qui demandent une
    // cle, et cela se joue plus tard, a l'ouverture.
    budgetMs: BUDGET_MS,

    async search(q: Query, ctx: SearchContext): Promise<Candidate[]> {
      const sections = ctx.famille ? SECTIONS_PAR_FAMILLE[ctx.famille.id] : undefined;
      if (!sections) return [];
      const terme = (q.titres[0] || '').trim();
      if (!terme) return [];

      const html = await page(
        `${BASE}/search?q=${encodeURIComponent(terme)}`,
        `bookys:recherche:${terme.toLowerCase()}`,
        ctx.signal,
      );
      // Echec, pas resultat vide : voir la note dans torznab.ts.
      if (html === null) throw new Error("bookys n'a rendu aucune reponse exploitable");
      return parseRechercheBookys(html, sections);
    },
  };
}

/**
 * Les liens d'une fiche.
 *
 * CE QUE J'AVAIS RATE, ET LA LECON. Un premier releve ne cherchait que des HOTES EXTERNES
 * dans les `href` de la page. Il n'en trouvait aucun, et j'en avais conclu — a tort — que
 * bookys ne livrait pas. La verite est qu'il livre par SON PROPRE redirecteur : chaque
 * hebergeur est un lien vers « <fiche>/dl/<id> », de classe `bys-host`, dont le TEXTE
 * porte le nom de l'hebergeur.
 *
 * Chercher la forme qu'on attend, et conclure de son absence, n'est pas mesurer. Les mots
 * « 1fichier », « uptobox » et « nitroflare » etaient dans la page depuis le debut.
 *
 * Releve du 2026-09-01 sur une fiche reelle : quatre hebergeurs — 1fichier, Nitroflare,
 * DailyUploads, Rg.to.
 */
export function parseFicheBookys(html: string): LienDdl[] {
  const out: LienDdl[] = [];
  const vus = new Set<string>();
  const motif = /<a[^>]+href="([^"]+)"[^>]*class="[^"]*bys-host[^"]*"[^>]*>([^<]*)<\/a>/g;
  for (const m of html.matchAll(motif)) {
    const url = decodeEntities(m[1]);
    if (!/\/dl\/\d+$/.test(url) || vus.has(url)) continue;
    const hebergeur = m[2].trim();
    if (!hebergeur) continue;
    vus.add(url);
    out.push({ hebergeur, url });
  }
  return out;
}

/** Ce lien est-il un redirecteur bookys ? Il ne peut pas etre donne tel quel a un debrideur. */
export function estLienBookys(url: string): boolean {
  return /bookys-ebooks\.com\/.+\/dl\/\d+$/.test(String(url || ''));
}

/**
 * Suit le redirecteur interne jusqu'a l'adresse REELLE de l'hebergeur.
 *
 * La page `/dl/<id>` porte, avec la meme classe `bys-host`, un lien vers l'hebergeur —
 * « https://1fichier.com/dir/… ». C'est cette adresse-la qu'un debrideur sait ouvrir ;
 * l'adresse bookys ne lui dirait rien.
 *
 * Un saut de plus, donc un passage de plus par flaresolverr. Il n'est paye qu'au moment
 * ou l'utilisateur demande REELLEMENT ce fichier, jamais a l'affichage d'une liste.
 */
export async function resoudreLienBookys(
  url: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const html = await page(url, `bookys:dl:${url}`, signal);
  if (html === null) return null;
  const motif = /<a[^>]+href="(https?:\/\/[^"]+)"[^>]*class="[^"]*bys-host[^"]*"/g;
  for (const m of html.matchAll(motif)) {
    const cible = decodeEntities(m[1]);
    // On ecarte les liens qui repointent vers bookys : seul l'hebergeur nous interesse.
    if (!/bookys-ebooks\.com/.test(cible)) return cible;
  }
  return null;
}

/** La fiche d'une release, pour le parcours debrideur. */
export async function ouvrirFicheBookys(
  id: string,
  signal?: AbortSignal,
): Promise<LienDdl[] | null> {
  if (!/^\d+$/.test(id)) return null;
  // Le slug ne compte pas : la fiche se sert sur le seul identifiant, et ses liens
  // portent de toute facon leur adresse complete.
  const html = await page(`${BASE}/bandes-dessinees/${id}-x`, `bookys:fiche:${id}`, signal);
  return html === null ? null : parseFicheBookys(html);
}
