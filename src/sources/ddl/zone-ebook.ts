// Zone-ebook comme SOURCE de recherche, a cote du kiosque.
//
// LE KIOSQUE ET LA SOURCE NE FONT PAS LE MEME METIER. Le kiosque regarde ce qui vient de
// paraitre dans une rubrique ; la source repond a un titre, pour une famille donnee. Le
// site, lui, rend TOUTES ses rubriques d'un seul coup a chaque recherche — c'est donc au
// filtre de dire quelle rubrique interesse ce rayon-la.
//
// SA RECHERCHE N'EXISTE QUE POUR SES MEMBRES : voir `presse/zone-ebook-session.ts`, ou la
// mesure est ecrite. Sans identifiants, le fan-out ecarte la source avant de l'appeler.

import { postForm } from '../../core/http';
import { parseRelease } from '../torrent/release';
import { identiteDdl } from './wawacity';
import { cookiePour, sessionRefusee } from '../../presse/zone-ebook-session';
import type { Candidate, Query, SearchContext, Source } from '../types';

const BASE = 'https://zone-ebook.com';
const MAX_RESULTATS = 40;

/**
 * CINQ RESULTATS PAR PAGE, et c'est le site qui le dit.
 *
 * Releve dans les outils de developpement le 2026-09-02 : `search_start=2` va avec
 * `result_from=6`. La deuxieme page commence donc au sixieme resultat. Sans pagination on
 * ne voyait que la premiere — « je cherche Naruto, bookloo trouve 5 correspondances, perso
 * j'en vois plus ».
 */
const PAR_PAGE = 5;

/** Au-dela, on ne fait plus attendre : quatre pages valent vingt resultats. */
const PAGES_MAX = 4;
const MAX_OCTETS = 2_000_000;

/**
 * Le budget de zone-ebook.
 *
 * Mesure du 2026-09-02 : la PREMIERE recherche paie la connexion — 1466 ms — puis les
 * suivantes tombent a 365 et 549 ms, la session etant retenue. Douze secondes laissent la
 * place a une connexion lente sans faire attendre le reste du fan-out, qui repond en deux.
 */
const BUDGET_MS = 12_000;

/**
 * Les sections du site qui alimentent chaque rayon.
 *
 * UNE SEULE SECTION POUR TROIS RAYONS. `bd-comics-mangas` ne distingue pas un manga d'un
 * comic : c'est la requete qui fait le tri, exactement comme `bandes-dessinees` chez
 * bookys. Prétendre trancher sur le chemin inventerait une information que le site ne
 * donne pas.
 *
 * Les cinq sections ont ete relevees sur le site le 2026-09-02, pas devinees :
 * `journaux`, `magazines`, `bd-comics-mangas`, `livres`, `livres-audio`.
 */
/**
 * Les CATEGORIES du site, telles que son formulaire avance les numerote.
 *
 * Relevees dans le `<select>` de la recherche etendue le 2026-09-02 — la page n'est pas
 * servie aux visiteurs, c'est Loo qui l'a lue :
 *     1 magazines · 2 Livres · 3 Bd/Comics/Mangas · 4 journaux · 5 Livres Audio
 *
 * FILTRER ICI VAUT MIEUX QUE FILTRER APRES. Sans `catlist[]`, une page de cinq resultats
 * melange toutes les rubriques : chercher un manga pouvait n'en rendre qu'un seul par
 * page, et les quatre pages lues coutaient quatre requetes pour quatre resultats. Avec la
 * categorie, les cinq resultats d'une page comptent tous.
 *
 * LA PRESSE EN DEMANDE DEUX, et c'est pourquoi le champ est un tableau : `catlist[]` vient
 * d'un `<select multiple>`, qui repete la meme cle. L'aplatir chercherait dans les
 * magazines OU dans les journaux, jamais dans les deux.
 */
export const CATEGORIES_PAR_FAMILLE: Record<string, string[]> = {
  mangas: ['3'],
  comics: ['3'],
  bd: ['3'],
  livres: ['2'],
  audio: ['5'],
  presse: ['1', '4'],
};

/**
 * Les sections d'URL correspondantes.
 *
 * ELLES RESTENT, MEME AVEC `catlist[]` : c'est le meme fait dit deux fois, une fois au
 * site et une fois a la lecture. Le filtre de sortie ecarte ce que la categorie n'aurait
 * pas du laisser passer — un encart lateral, par exemple, qui n'obeit a aucune categorie.
 */
export const SECTIONS_PAR_FAMILLE: Record<string, string[]> = {
  mangas: ['bd-comics-mangas'],
  comics: ['bd-comics-mangas'],
  bd: ['bd-comics-mangas'],
  livres: ['livres'],
  audio: ['livres-audio'],
  presse: ['journaux', 'magazines'],
};

function texteNu(html: string): string {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Les candidats d'une page de recherche, pour les sections demandees.
 *
 * ON GARDE LE TITRE LE PLUS LONG PAR FICHE : le site pose plusieurs liens vers la meme
 * fiche — la vignette, qui n'a pas de texte, et le titre. Prendre le premier rendrait des
 * lignes vides.
 */
export function parseRechercheZone(html: string, sections: string[]): Candidate[] {
  const parId = new Map<string, string>();
  const motif = new RegExp(
    `<a[^>]+href="[^"]*zone-ebook\\.com/(?:${sections.join('|')})/(\\d+)-[^"]*"[^>]*>([\\s\\S]*?)</a>`,
    'g',
  );
  for (const m of html.matchAll(motif)) {
    const texte = texteNu(m[2]!);
    if (!texte) continue;
    const connu = parId.get(m[1]!);
    if (connu === undefined || texte.length > connu.length) parId.set(m[1]!, texte);
  }

  const out: Candidate[] = [];
  for (const [id, titre] of parId) {
    const { tomes, langue, format, provenance } = parseRelease(titre);
    out.push({
      source: 'zone-ebook',
      titre,
      // Pas de hash : c'est du lien direct. L'identite est synthetique, et tout le chemin
      // debrideur la connait deja — `ouvreurs.ts` sait ouvrir `ddl:zone-ebook:<id>`.
      identite: identiteDdl('zone-ebook', id),
      tomes,
      langue,
      format,
      provenance,
    });
    if (out.length >= MAX_RESULTATS) break;
  }
  return out;
}

/**
 * Une page de resultats.
 *
 * `search_start` EST UN NUMERO DE PAGE, `result_from` LE RANG DU PREMIER RESULTAT. Les
 * deux sont envoyes parce que le site les envoie tous les deux : la capture du 2026-09-02
 * montre `search_start=2` avec `result_from=6`. N'en envoyer qu'un rendrait la premiere
 * page indefiniment, ce qui se lirait « le site n'a que cinq reponses ».
 *
 * `full_search=1` EST LA RECHERCHE ETENDUE, celle du formulaire avance. Elle regarde plus
 * que le titre, et c'est ce qui fait la difference entre cinq correspondances et la
 * quinzaine que le site sait rendre.
 */
async function pageDeRecherche(
  terme: string,
  page: number,
  categories: string[],
  cookie: string,
  signal?: AbortSignal,
): Promise<string | null> {
  return postForm(
    `${BASE}/index.php?do=search`,
    {
      do: 'search',
      subaction: 'search',
      search_start: String(page),
      full_search: '1',
      result_from: String((page - 1) * PAR_PAGE + 1),
      story: terme,
      // Les valeurs par defaut du formulaire avance, envoyees telles quelles : le site les
      // attend, et les omettre le fait retomber sur des reglages qui ne sont pas ceux-la.
      titleonly: '0',
      searchuser: '',
      replyless: '0',
      replylimit: '0',
      searchdate: '0',
      beforeafter: 'after',
      sortby: 'date',
      resorder: 'desc',
      showposts: '0',
      // La categorie demandee, repetee autant de fois qu'il y en a — comme le fait le
      // `<select multiple>` du site.
      'catlist[]': categories,
    },
    {
      timeoutMs: 20000,
      signal,
      maxBytes: MAX_OCTETS,
      headers: { Cookie: cookie, Referer: `${BASE}/index.php?do=search` },
    },
  );
}

export function zoneEbookSource(): Source {
  return {
    id: 'zone-ebook',
    label: 'zone-ebook',
    // LE MOT DE PASSE EST LA CLE REQUISE. Sans lui le fan-out ecarte la source avant de
    // l'appeler, et l'ecran affiche « cle absente » — un fait, la ou une liste vide se
    // lirait « ce site ne connait pas cette oeuvre ».
    cleRequise: 'zone_mdp',
    budgetMs: BUDGET_MS,

    async search(q: Query, ctx: SearchContext): Promise<Candidate[]> {
      const sections = ctx.famille ? SECTIONS_PAR_FAMILLE[ctx.famille.id] : undefined;
      const categories = ctx.famille ? CATEGORIES_PAR_FAMILLE[ctx.famille.id] : undefined;
      if (!sections || !categories) return [];
      const terme = (q.titres[0] || '').trim();
      if (!terme || ctx.userId === undefined) return [];

      const cookie = await cookiePour(ctx.userId, ctx.cles, ctx.signal);
      if (!cookie) throw new Error('zone-ebook a refuse ces identifiants');

      const toutes = Object.values(SECTIONS_PAR_FAMILLE).flat();
      const parId = new Map<string, Candidate>();
      let vuUneFiche = false;

      // LES PAGES S'ENCHAINENT TANT QU'ELLES APPORTENT. On s'arrete des qu'une page ne
      // rend plus rien : une page vide veut dire que le site a epuise ses reponses, et
      // continuer ferait payer trois requetes pour rien.
      for (let page = 1; page <= PAGES_MAX; page += 1) {
        if (ctx.signal?.aborted) break;
        const html = await pageDeRecherche(terme, page, categories, cookie, ctx.signal);
        // Echec, pas resultat vide : voir la note dans torznab.ts. Seule la PREMIERE page
        // fait echouer la source — une page 3 injoignable ne doit pas effacer les deux
        // premieres, deja obtenues.
        if (html === null) {
          if (page === 1) throw new Error("zone-ebook n'a rendu aucune reponse exploitable");
          break;
        }
        // Le site rend TOUTES ses rubriques : on mesure sur toutes pour savoir si la page
        // portait quelque chose, et on ne garde que les sections du rayon.
        const surLaPage = parseRechercheZone(html, toutes);
        if (surLaPage.length === 0) break;
        vuUneFiche = true;
        const avant = parId.size;
        for (const c of parseRechercheZone(html, sections)) {
          // Une identite manquante ne peut ni s'ouvrir ni se dedoublonner : on l'ecarte
          // plutot que de la poser sous une cle vide, qui en ferait disparaitre d'autres.
          if (c.identite && !parId.has(c.identite)) parId.set(c.identite, c);
        }
        if (parId.size >= MAX_RESULTATS) break;
        // ON S'ARRETE QUAND UNE PAGE N'APPORTE PLUS RIEN, pas quand elle est « courte ».
        //
        // Compter les fiches d'une page pour deviner si c'est la derniere se trompe des
        // que la page en porte moins que la taille annoncee — une fiche repetee, une
        // entree hors categorie — et la recherche s'arretait alors sur six resultats
        // quand le site en avait davantage. Une page qui n'ajoute aucune identite
        // nouvelle est la vraie fin ; au pire elle coute une requete de plus.
        if (parId.size === avant) break;
      }

      // AUCUNE FICHE SUR AUCUNE PAGE = SESSION TOMBEE. Une page de visiteur n'en porte
      // aucune. La prendre pour « rien ne correspond » laisserait la session morte en
      // memoire, et toutes les recherches suivantes rendraient vide sans se reconnecter.
      if (!vuUneFiche) sessionRefusee(ctx.userId);
      return [...parId.values()].slice(0, MAX_RESULTATS);
    },
  };
}
