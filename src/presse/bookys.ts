// bookys : le fonds le plus large des trois, et le seul derriere un defi Cloudflare.
//
// MESURE DU 2026-08-31 : en direct il rend 403 « Just a moment… ». Par flaresolverr —
// le meme outil que Booknode utilise deja — la page arrive en 14 a 17 secondes, A CHAUD
// AUSSI. C'est ce cout qui impose au kiosque d'arriver en flux : les deux autres sites
// repondent en moins d'une seconde, et les attendre tous ensemble ferait patienter quinze
// secondes devant un ecran vide.

import { cached } from '../core/cache';
import { pageViaFlaresolverr } from '../core/flaresolverr';
import { tracerAppel, hoteDe } from '../core/journal';
import { decodeEntities } from '../core/xml';
import { separerTitreDate } from './titre-date';
import { rubriqueDuChemin } from './rubrique';
import { RUBRIQUES, type Kiosque, type Numero, type Rubrique } from './types';

const BASE = 'https://www7.bookys-ebooks.com';
const TTL_MS = 30 * 60 * 1000;
const MAX_NUMEROS = 60;
/**
 * Combien de pages on remonte.
 *
 * DEUX, ET PAS TROIS. Une page rend vingt numeros et coute quatorze secondes : la
 * troisieme ferait passer le site de vingt-huit a quarante-deux secondes pour vingt
 * numeros de plus, dont la plupart auront ete publies par les deux autres sites.
 */
const PAGES = 2;

/**
 * Le titre qui ouvre l'encadre lateral, et ou la liste principale s'arrete.
 *
 * SANS CETTE COUPURE, DOUZE MAGAZINES SE RANGERAIENT PARMI LES JOURNAUX. Releve sur la
 * capture du 2026-08-31 : `/journaux/new` porte vingt liens `/journaux/` CONTIGUS, de
 * l'offset 53512 a 83699, puis des magazines commencent juste apres ce titre. Et
 * `/magazines/new` ne contient AUCUN lien `/journaux/` — c'est cette asymetrie qui trahit
 * l'encadre.
 *
 * Un premier releve avait conclu l'inverse : que la rubrique venait de la page consultee
 * et jamais du chemin. C'etait faux, et cette regle-la aurait mal range douze magazines a
 * chaque consultation.
 */
const FIN_DE_LISTE = /top\s+de\s+la\s+semaine/i;

const texteNu = (h: string) => decodeEntities(h.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/** Ce que bookys range hors presse : romans, livres, tutos, et ses propres ressources. */
const HORS_PRESSE = new Set([
  'romans', 'livres', 'tutos-logiciels', 'images', 'js', 'css', 'build', 'password', 'storage',
]);

/**
 * Les rubriques de presse, ET ELLES SEULES.
 *
 * LA BANDE DESSINEE N'EN FAIT PAS PARTIE, et l'y avoir mise etait une erreur. bookys range
 * sous `bandes-dessinees` des revues de BD, de comics et de manga : les afficher parmi les
 * magazines les noyait au milieu des journaux, alors que l'application a DEJA un rayon
 * pour chacune — avec son catalogue, son rapprochement par tome et sa bibliotheque. Un
 * numero de manga n'a rien a faire dans un kiosque de presse.
 */
const RUBRIQUES_CATEGORIES = new Set<string>(RUBRIQUES);

function couperALaListe(html: string): string {
  const m = FIN_DE_LISTE.exec(html);
  return m && m.index > 0 ? html.slice(0, m.index) : html;
}

/**
 * Les numeros d'une page, quel que soit le chemin qui la sert.
 *
 * `chemin` est ce qui apparait dans l'URL — « journaux », « magazines »,
 * « bandes-dessinees » — et `rubrique` est celle sous laquelle le kiosque les RANGE. Les
 * deux different pour une revue de BD : le kiosque n'a que deux rubriques, et une revue
 * s'affiche naturellement parmi les magazines.
 */
function extraireNumeros(html: string, chemin: string, rubrique: Rubrique): Numero[] {
  const principale = couperALaListe(html);
  const parId = new Map<string, string>();
  // Pas de « .html » final, contrairement a zone-ebook.
  const motif = new RegExp(
    `<a[^>]+href="[^"]*bookys-ebooks\\.com/${chemin}/(\\d+)-[^"]*"[^>]*>([\\s\\S]*?)</a>`,
    'g',
  );
  for (const m of principale.matchAll(motif)) {
    const texte = texteNu(m[2]);
    if (!texte) continue;
    const connu = parId.get(m[1]);
    if (connu === undefined || texte.length > connu.length) parId.set(m[1], texte);
  }

  const out: Numero[] = [];
  for (const [id, brut] of parId) {
    const { titre, date } = separerTitreDate(brut);
    out.push({ site: 'bookys', id, titre, rubrique, date, brut });
    if (out.length >= MAX_NUMEROS) break;
  }
  return out;
}

export function parseListeBookys(html: string, rubrique: Rubrique): Numero[] {
  return extraireNumeros(html, rubrique, rubrique);
}

/**
 * Les numeros d'une page de RECHERCHE, ou les deux rubriques se melangent.
 *
 * La rubrique se lit dans le chemin. Un resultat sous `romans`, `livres` ou
 * `bandes-dessinees` est ecarte : ce kiosque sert la presse, et le reste a deja son rayon.
 */
export function parseRechercheBookys(html: string): Numero[] {
  const principale = couperALaListe(html);
  const parId = new Map<string, { brut: string; rubrique: Rubrique }>();
  const motif =
    /<a[^>]+href="([^"]*bookys-ebooks\.com\/[a-z-]+\/(\d+)-[^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
  for (const m of principale.matchAll(motif)) {
    const rubrique = rubriqueDuChemin(m[1]);
    if (!rubrique) continue;
    const texte = texteNu(m[3]);
    if (!texte) continue;
    const connu = parId.get(m[2]);
    if (connu === undefined || texte.length > connu.brut.length) {
      parId.set(m[2], { brut: texte, rubrique });
    }
  }
  const out: Numero[] = [];
  for (const [id, { brut, rubrique }] of parId) {
    const { titre, date } = separerTitreDate(brut);
    out.push({ site: 'bookys', id, titre, rubrique, date, brut });
    if (out.length >= MAX_NUMEROS) break;
  }
  return out;
}

export interface CategorieBookys {
  rubrique: string;
  slug: string;
  libelle: string;
}

/**
 * Les categories du bloc de gauche.
 *
 * ELLES SE LISENT DANS UNE PAGE DEJA RECUPEREE. Le bloc est present sur `/journaux/new`,
 * que la rubrique Journaux a deja mise en cache : l'onglet « Par titre » ne coute donc
 * aucun appel supplementaire tant qu'on n'ouvre pas une categorie — et un appel bookys
 * coute quinze secondes.
 *
 * Ces categories n'existent QUE chez bookys. C'est pour cela qu'elles vivent dans un
 * onglet a part, qui nomme sa provenance, plutot que dans un filtre qui masquerait deux
 * sites sur trois sans le dire.
 */
export function parseCategoriesBookys(html: string): CategorieBookys[] {
  const vus = new Set<string>();
  const out: CategorieBookys[] = [];
  const motif =
    /<a[^>]+href="[^"]*bookys-ebooks\.com\/([a-z-]+)\/([a-z][a-z0-9-]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  for (const m of html.matchAll(motif)) {
    const rubrique = m[1].toLowerCase();
    const slug = m[2].toLowerCase();
    // « new » et « top » sont des LISTES, pas des categories : les proposer comme un
    // titre a suivre n'aurait aucun sens.
    if (slug === 'new' || slug === 'top') continue;
    if (HORS_PRESSE.has(rubrique) || !RUBRIQUES_CATEGORIES.has(rubrique)) continue;
    const cle = `${rubrique}/${slug}`;
    if (vus.has(cle)) continue;
    const libelle = texteNu(m[3]);
    if (!libelle) continue;
    vus.add(cle);
    out.push({ rubrique, slug, libelle });
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
    { scope: 'presse:bookys', echec: (v) => v === null, shouldCache: (v) => v !== null },
  );
}

/**
 * L'adresse d'une page de rubrique.
 *
 * MESURE DU 2026-09-01 : `?page=2` rend les vingt suivants ; `/new/2` ne rend rien.
 */
export function urlListe(rubrique: Rubrique, page = 1): string {
  return page <= 1 ? `${BASE}/${rubrique}/new` : `${BASE}/${rubrique}/new?page=${page}`;
}

export const bookys: Kiosque = {
  id: 'bookys',
  libelle: 'bookys',
  async dernieres(rubrique, signal) {
    const out: Numero[] = [];
    const vus = new Set<string>();
    for (let n = 1; n <= PAGES; n += 1) {
      const html = await page(urlListe(rubrique, n), `presse:bookys:${rubrique}:${n}`, signal);
      // Un echec sur la PREMIERE page est une panne ; sur les suivantes, mieux vaut
      // rendre ce qu'on a que rien.
      if (html === null) {
        if (n === 1) throw new Error('bookys n a pas repondu');
        break;
      }
      const lot = parseListeBookys(html, rubrique).filter((x) => !vus.has(x.id));
      if (lot.length === 0) break;
      for (const x of lot) { vus.add(x.id); out.push(x); }
    }
    return out;
  },
  chercheable: true,
  // `_ctx` IGNORE, ET NOMME : ce site repond a tout le monde. Le laisser sans nom
  // ferait croire a un oubli la ou c'est une propriete du site.
  async chercher(terme, _ctx, signal) {
    // Mesure du 2026-09-01 : `/search?q=` trouve juste — « cahiers du cinema » rend le
    // bon magazine. La forme `?s=` rend l'accueil, ce qui passerait pour dix resultats
    // sans rapport.
    const url = `${BASE}/search?q=${encodeURIComponent(terme)}`;
    const html = await page(url, `presse:bookys:q:${terme.toLowerCase()}`, signal);
    if (html === null) throw new Error('bookys n a pas repondu');
    return parseRechercheBookys(html);
  },
};

/** Les categories, lues dans la page des derniers journaux — deja en cache. */
export async function categoriesBookys(signal?: AbortSignal): Promise<CategorieBookys[]> {
  const html = await page(urlListe('journaux', 1), 'presse:bookys:journaux:1', signal);
  return html === null ? [] : parseCategoriesBookys(html);
}

/** Les numeros d'une categorie : « journaux/le-monde », « magazines/philosophie ». */
export async function numerosDeCategorie(
  rubrique: string,
  slug: string,
  signal?: AbortSignal,
): Promise<Numero[]> {
  if (!RUBRIQUES_CATEGORIES.has(rubrique) || !/^[a-z][a-z0-9-]*$/.test(slug)) return [];
  const html = await page(`${BASE}/${rubrique}/${slug}`, `presse:bookys:${rubrique}:${slug}`, signal);
  if (html === null) throw new Error('bookys n a pas repondu');
  // Une categorie de bande dessinee garde la rubrique « magazines » pour l'affichage :
  // le kiosque n'en connait que deux, et une revue de BD s'y range naturellement.
  return extraireNumeros(html, rubrique, rubrique === 'journaux' ? 'journaux' : 'magazines');
}
