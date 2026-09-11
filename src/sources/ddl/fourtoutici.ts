// fourtoutici — la premiere source qui ne demande AUCUNE cle.
//
// CE QUI LA REND PARTICULIERE. Toutes les autres sources en lien direct — Wawacity,
// bookys, zone-ebook — rendent une adresse d'hebergeur qu'un debrideur doit deverrouiller.
// Celle-ci sert le fichier elle-meme, et honore les plages HTTP : mesure du 2026-09-07,
// `download.php` rend un 206 avec un `Content-Range` correct sur une demande d'un
// kilo-octet. Elle se lit donc en ligne sans qu'aucune cle soit configuree, comme
// Telegram — et pas comme les autres liens directs.
//
// SON API EST PROPRE, ce qui est assez rare pour etre dit : `files.php?q=` cherche
// vraiment — 14 resultats pertinents sur 15 pour « berserk », 50 sur 50 pour « stephen
// king » — et chaque fichier arrive avec son extension, son type MIME et sa taille. Rien
// n'est a deviner depuis le nom, contrairement a tout le reste du dossier.
//
// SA LIMITE EST DECLAREE : 30 requetes par minute, ecrites dans son propre script. Le
// cache n'est donc pas un confort mais une politesse.

import { cached } from '../../core/cache';
import { httpGet } from '../../core/http';
import { tracerAppel, hoteDe } from '../../core/journal';
import { parseRelease } from '../torrent/release';
import type { Candidate, Format, Query, SearchContext, Source } from '../types';
import { identiteDdl } from './wawacity';
import { categoriesInterrogeables, sertLaFamille, titreSansCategorie } from './fourtoutici-tri';
import { motPourFourtoutici } from './fourtoutici-terme';

const BASE = 'https://fourtoutici.cc';
const TTL_MS = 30 * 60 * 1000;
const TTL_VIDE_MS = 10 * 60 * 1000;
const MAX_RESULTATS = 60;
/** `files.php` rend 50 fichiers par page. Trois pages suffisent a couvrir une serie. */
const MAX_PAGES = 3;
/** De quoi tenir la limite declaree du site — 30 requetes par minute — sans la froler. */
const BUDGET_MS = 15_000;

/** Les extensions que le site annonce, et ce qu'elles valent pour nous. */
const FORMATS: Record<string, Format> = {
  cbz: 'cbz', cbr: 'cbr', pdf: 'pdf', epub: 'epub',
  mobi: 'kindle', azw3: 'kindle',
  mp3: 'audio', m4b: 'audio', m4a: 'audio', flac: 'audio',
};

interface FichierFtc {
  file_id?: unknown;
  original_name?: unknown;
  file_name?: unknown;
  extension?: unknown;
  size?: unknown;
}

/**
 * Les candidats d'une reponse de recherche, pour une famille donnee.
 *
 * LE FORMAT VIENT DE L'EXTENSION ANNONCEE, jamais du nom. C'est la difference avec toutes
 * les autres sources en lien direct de ce dossier, ou il faut le deviner : ici le site le
 * dit, et il a raison par construction.
 */
export function parseRechercheFourtoutici(corps: unknown, famille: string): Candidate[] {
  const fichiers = (corps as { files?: unknown })?.files;
  if (!Array.isArray(fichiers)) return [];

  const out: Candidate[] = [];
  const vus = new Set<string>();
  for (const brut of fichiers as FichierFtc[]) {
    const id = String(brut?.file_id ?? '');
    const nom = String(brut?.original_name ?? brut?.file_name ?? '').trim();
    if (!id || !nom || vus.has(id)) continue;
    // La categorie du site peut ECARTER, jamais admettre a elle seule : voir
    // `fourtoutici-tri.ts`.
    if (!sertLaFamille(nom, famille)) continue;
    vus.add(id);

    const titre = titreSansCategorie(nom);
    const { tomes, langue, provenance, format: devine } = parseRelease(titre);
    const ext = String(brut?.extension ?? '').toLowerCase();
    const taille = Number(brut?.size);

    out.push({
      source: 'fourtoutici',
      titre,
      // Pas d'empreinte : c'est du lien direct. L'identite est synthetique.
      identite: identiteDdl('fourtoutici', id),
      tomes,
      langue,
      format: FORMATS[ext] ?? devine,
      provenance,
      taille: Number.isFinite(taille) && taille > 0 ? taille : undefined,
    });
    if (out.length >= MAX_RESULTATS) break;
  }
  return out;
}

/**
 * Cette identite est-elle servie par fourtoutici ?
 *
 * Elle a la FORME d'un lien direct — `ddl:<site>:<id>` — mais elle ne se traite pas comme
 * les autres : le fichier s'ouvre sans debrideur. La distinction se fait donc sur le site,
 * pas sur la forme.
 */
export function estIdentiteFourtoutici(x: string): boolean {
  return /^ddl:fourtoutici:[A-Za-z0-9_-]+$/.test(String(x || ''));
}

/** L'identifiant porte par une identite fourtoutici. */
export function idFourtoutici(x: string): string {
  return String(x || '').slice('ddl:fourtoutici:'.length);
}

/** L'adresse du fichier lui-meme. Directe : aucun debrideur ne s'interpose. */
export function urlFichierFourtoutici(id: string): string {
  return `${BASE}/backend/api/download.php?file_id=${encodeURIComponent(id)}`;
}

/**
 * L'adresse d'une page de resultats.
 *
 * `cat` est omis quand la famille n'a pas de categorie verifiee : le site IGNORE une
 * categorie qu'il ne connait pas, et l'envoyer quand meme rendrait une recherche non
 * filtree qui se lirait a tort comme un resultat de cette categorie.
 */
export function urlRechercheFourtoutici(terme: string, cat: string | null, page: number): string {
  const q = `q=${encodeURIComponent(terme)}`;
  const c = cat ? `&cat=${encodeURIComponent(cat)}` : '';
  const p = page > 0 ? `&page=${page}` : '';
  return `${BASE}/backend/api/files.php?${q}${c}${p}`;
}

/** Le site annonce lui-meme s'il lui reste des pages. */
export function aEncoreDesPages(corps: unknown): boolean {
  return (corps as { has_more?: unknown })?.has_more === true;
}

export function fourtouticiSource(): Source {
  return {
    id: 'fourtoutici',
    label: 'fourtoutici',
    // Pas de `cleRequise`, et ici cela va plus loin qu'ailleurs : meme la LECTURE ne
    // demande aucune cle, le site servant ses fichiers lui-meme.

    async search(q: Query, ctx: SearchContext): Promise<Candidate[]> {
      const famille = ctx.famille?.id;
      if (!famille) return [];
      // UN SEUL MOT, ET SANS ACCENT : c'est tout ce que le site accepte. Mesure du
      // 2026-09-07 — « Shining » rend 200, mais « stephen king », « stephen+king »,
      // « stephen-king » et meme un mot accentue rendent un 403 de nginx. Envoyer le titre
      // entier faisait donc echouer a peu pres toutes les recherches.
      const terme = motPourFourtoutici(q.titres[0] || '');
      if (!terme) return [];

      // FILTRER A LA SOURCE, PAS AU RETOUR. Le site classe par pertinence et pagine par
      // 50 : mesure du 2026-09-07, « Elle » rend 297 fichiers dont les deux seuls MAGAZINE
      // ne paraissent sur aucune page avant la derniere. Ne lire que la premiere page les
      // perdait entierement. Avec `cat=MAGAZINE` ils arrivent du premier coup.
      const cats = categoriesInterrogeables(famille);
      const aInterroger: readonly (string | null)[] = cats.length ? cats : [null];

      const fin = Date.now() + BUDGET_MS;
      const corps: unknown[] = [];
      let premiereEnEchec = true;

      for (const cat of aInterroger) {
        for (let page = 0; page < MAX_PAGES; page += 1) {
          if (Date.now() >= fin) break;
          const debut = Date.now();
          const url = urlRechercheFourtoutici(terme, cat, page);
          const reponse = await cached<unknown>(
            `fourtoutici:${terme.toLowerCase()}:${cat ?? '-'}:${page}`,
            TTL_MS,
            async () => {
              const r = await httpGet<unknown>(url, {
                timeoutMs: 12000,
                signal: ctx.signal,
                retries: 1,
              });
              tracerAppel({
                source: 'fourtoutici',
                hote: hoteDe(BASE),
                statut: r ? r.status : null,
                duree: Date.now() - debut,
                ok: Boolean(r && r.status >= 200 && r.status < 300),
              });
              // UN REFUS N'EST PAS UNE PANNE, et le dire change ce qu'on peut en faire :
              // une panne se retente, un refus demande de changer la requete.
              if (r && r.status === 403) throw new Error('fourtoutici a refuse cette requete');
              if (!r || r.status < 200 || r.status >= 300) return null;
              return r.data ?? null;
            },
            {
              scope: 'fourtoutici',
              echec: (v) => v === null,
              shouldCache: (v) => v !== null,
              negativeTtlMs: TTL_VIDE_MS,
            },
          );

          // Une page qui tombe n'annule que la suite de SA categorie : ce qui est deja
          // rassemble reste bon. Seul un premier appel sans reponse est une panne.
          if (reponse === null) break;
          premiereEnEchec = false;
          corps.push(reponse);
          if (!aEncoreDesPages(reponse)) break;
        }
      }

      // Echec, pas resultat vide : voir la note dans torznab.ts.
      if (premiereEnEchec) throw new Error("fourtoutici n'a rendu aucune reponse exploitable");

      const out: Candidate[] = [];
      const vus = new Set<string>();
      for (const page of corps) {
        for (const c of parseRechercheFourtoutici(page, famille)) {
          // Les categories d'une meme famille ne se recouvrent pas, mais deux pages d'une
          // meme categorie le peuvent si le site republie entre deux appels.
          const cle = c.identite ?? c.titre;
          if (vus.has(cle)) continue;
          vus.add(cle);
          out.push(c);
          if (out.length >= MAX_RESULTATS) return out;
        }
      }
      return out;
    },
  };
}
