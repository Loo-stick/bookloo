// downmagaz — lire son inventaire et ses fiches, sans passer par ses portes fermees.
//
// SA RECHERCHE EST FERMEE AUX AUTOMATES. Son `robots.txt` interdit `/*do=search`, et
// aussi `/*do=download` et `/engine/go.php`. On batit donc l'index sur son sitemap, qui,
// lui, est autorise — meme demarche que 1001ebooks.
//
// ET LE REDIRECTEUR N'EST QU'UN EMBALLAGE. Le lien de chaque hebergeur est ecrit en clair
// sur la fiche, dans un attribut `data-url` ; c'est un script qui l'encode en base64 pour
// l'envoyer a `go.php`. On lit donc le lien la ou il est publie, sans jamais appeler le
// chemin interdit.
//
// CE QU'IL Y A DEDANS, mesure du 2026-09-11 a la premiere construction : 110 926 fiches,
// dont 102 360 de presse et 8 566 albums de BD, sur 34 rubriques qui ont toutes la forme
// `…magazine…_francaise`. Les identifiants montent a 124 426 ; l'ecart est fait de fiches
// retirees.
//
// LE SITEMAP EST DECOUPE EN TROIS FICHIERS de 40 000 adresses au plus — `news_pages`,
// `news_pages2`, `news_pages3`. J'avais d'abord conclu a un plafond de 40 000 et a un
// inventaire tronque : la sonde avait echoue sur le premier fichier, trop gros pour elle,
// et n'avait jamais lu les deux autres. Un chiffre rond tire d'une lecture partielle n'est
// pas une mesure.

import { normaliserTitre } from '../torrent/release';
import type { LienDdl } from './wawacity';
import { parcourirPages } from './parcours-pages';

export const BASE_DOWNMAGAZ = 'https://fr.downmagaz.net';

/**
 * Les rayons qu'une rubrique sert.
 *
 * `comics` porte en realite des ALBUMS DE BD — « Les Ogres-Dieux T03 », « Tete de pioche
 * T03 » — et sert donc les deux rayons. `adult` est ecartee. Toute autre rubrique de la
 * forme du site est de la presse : c'est le cas des 32 restantes, relevees une a une.
 * Ce qui n'a pas cette forme — trois adresses sans rubrique dans le sitemap — est ignore.
 */
export function famillesDeRubrique(rubrique: string): string[] {
  const r = String(rubrique || '');
  if (!/^[a-z_]*magazine[a-z_]*_francaise$/.test(r)) return [];
  if (r === 'adult_magazine_francaise') return [];
  if (r === 'comics_magazine_francaise') return ['bd', 'comics'];
  return ['presse'];
}

/** Les rayons que ce site sert, tous confondus. */
export const RAYONS_DOWNMAGAZ: readonly string[] = ['presse', 'bd', 'comics'];

export interface FicheDownmagaz {
  rubrique: string;
  /** `124426-investir-12-septembre-2026-no-2749`, tel que dans l'adresse. */
  slug: string;
}

/** `https://fr.downmagaz.net/<rubrique>/<id>-<slug>.html` -> rubrique + slug. */
export function ficheDeLAdresse(url: string): FicheDownmagaz | null {
  const s = String(url || '');
  if (!s.startsWith(`${BASE_DOWNMAGAZ}/`)) return null;
  const reste = s.slice(BASE_DOWNMAGAZ.length + 1);
  const barre = reste.indexOf('/');
  if (barre <= 0) return null;
  const rubrique = reste.slice(0, barre);
  const fichier = reste.slice(barre + 1);
  if (!fichier.endsWith('.html') || fichier.includes('/')) return null;
  const slug = fichier.slice(0, -'.html'.length);
  if (!/^\d+-[a-z0-9-]+$/.test(slug)) return null;
  return { rubrique, slug };
}

/**
 * Les fiches d'un sitemap.
 *
 * PAS D'AUTOMATE SUR LE DOCUMENT ENTIER. Celui des fiches pese 8,4 Mo, et ce depot a deja
 * fait tomber la machine avec un motif a quantificateurs sur du contenu de cette forme.
 * On avance par `indexOf`, et le decoupage ne porte que sur une adresse a la fois.
 */
export function fichesDuSitemapDownmagaz(xml: string): FicheDownmagaz[] {
  const t = String(xml || '');
  const out: FicheDownmagaz[] = [];
  let i = t.indexOf('<loc>');
  while (i >= 0) {
    const j = t.indexOf('</loc>', i);
    if (j < 0) break;
    const f = ficheDeLAdresse(t.slice(i + 5, j).trim());
    if (f) out.push(f);
    i = t.indexOf('<loc>', j);
  }
  return out;
}

/** Le numero de la fiche, qui suffit a la retrouver : `index.php?newsid=<id>`. */
export function idDuSlug(slug: string): string | null {
  const m = /^(\d{1,9})-/.exec(String(slug || ''));
  return m ? m[1] : null;
}

/**
 * Le titre lisible, tire du slug : `124426-investir-12-septembre` -> « Investir 12 septembre ».
 *
 * `amp` ISOLE EST UNE ESPERLUETTE. Le site fabrique ses slugs a partir du titre ENCODE
 * EN HTML, et « Air & Cosmos » y devient `air-amp-cosmos` : l'ecran affichait « Air amp
 * cosmos ». Seul le mot entier est rendu, jamais une syllabe.
 */
export function titreDuSlugDownmagaz(slug: string): string {
  const sansId = String(slug || '').replace(/^\d+-/, '');
  const phrase = sansId.split('-').filter(Boolean).map((m) => (m === 'amp' ? '&' : m)).join(' ');
  return phrase ? phrase.charAt(0).toUpperCase() + phrase.slice(1) : '';
}

/**
 * Le rang de tri d'une fiche : son numero.
 *
 * Le moteur les attribue dans l'ordre de publication, et c'est ce qui permet de rendre
 * le dernier numero paru EN TETE plutot que dans l'ordre ou le sitemap les range.
 */
export function rangDuSlug(slug: string): number | undefined {
  const id = idDuSlug(slug);
  return id ? Number(id) : undefined;
}

/**
 * Les fiches d'une PAGE DE LISTE — la page d'accueil et ses suivantes, `/page/<n>/`.
 *
 * POURQUOI ELLES EXISTENT ICI. Le sitemap du site est FIGE : mesure du 2026-09-11, son
 * dernier numero est 111 387 quand le site en est a 124 426. Les trois adresses sans
 * rubrique qu'il porte (`111388-11.html`, `111389-trbt…`) marquent l'endroit ou sa
 * generation a casse, mi-novembre 2025. Les pages de liste, que le `robots.txt`
 * n'interdit pas, sont le seul chemin autorise vers les treize mille fiches suivantes.
 *
 * SEULE LA LISTE COMPTE, pas la page entiere : chaque page porte aussi une colonne
 * laterale — les plus lus, les derniers ajouts — identique d'une page a l'autre. La lire
 * faisait croire que les pages 2 et 3 se recouvraient. La liste commence a
 * `id="dle-content"` et s'arrete a la colonne `lside` ; elle compte 33 fiches par page.
 */
export function fichesDeLaListe(html: string): FicheDownmagaz[] {
  const t = String(html || '');
  const debut = t.indexOf('id="dle-content"');
  if (debut < 0) return [];
  const fin = t.indexOf('class="lside"', debut);
  const zone = t.slice(debut, fin > debut ? fin : undefined);
  const out: FicheDownmagaz[] = [];
  const vus = new Set<string>();
  const cle = `href="${BASE_DOWNMAGAZ}/`;
  let i = zone.indexOf(cle);
  while (i >= 0) {
    const j = zone.indexOf('"', i + 6);
    if (j < 0) break;
    const f = ficheDeLAdresse(zone.slice(i + 6, j));
    if (f && !vus.has(f.slug)) { vus.add(f.slug); out.push(f); }
    i = zone.indexOf(cle, j);
  }
  return out;
}

/** L'adresse d'une page de liste. La premiere est la page d'accueil. */
export function urlPageListe(n: number): string {
  return n <= 1 ? `${BASE_DOWNMAGAZ}/` : `${BASE_DOWNMAGAZ}/page/${n}/`;
}

export function motsDuSlugDownmagaz(slug: string): string[] {
  return normaliserTitre(titreDuSlugDownmagaz(slug)).split(' ').filter(Boolean);
}

/** L'adresse d'une fiche par son seul numero. Le moteur la sert directement. */
export function urlFicheDownmagaz(id: string): string {
  return `${BASE_DOWNMAGAZ}/index.php?newsid=${encodeURIComponent(id)}`;
}

export interface DescriptionFiche {
  titre: string | null;
  format: string | null;
  pages: number | null;
  taille: number | null;
}

/**
 * Ce que la fiche dit de son fichier, dans sa balise `description`.
 *
 * Forme constante sur les douze fiches mesurees, des plus recentes aux plus anciennes :
 * « Investir - 12 Septembre 2026 (No. 2749) Français | PDF | 36 Pages | 10 MB ». Le
 * format, les pages et la taille sont ANNONCES par le site ; rien n'est deduit du nom.
 */
export function lireDescription(html: string): DescriptionFiche {
  const t = String(html || '');
  const vide: DescriptionFiche = { titre: null, format: null, pages: null, taille: null };
  const cle = '<meta name="description" content="';
  const i = t.indexOf(cle);
  if (i < 0) return vide;
  const j = t.indexOf('"', i + cle.length);
  if (j < 0) return vide;
  const d = decoderEntites(t.slice(i + cle.length, j));
  const parts = d.split('|').map((p) => p.trim());
  // Le titre est ce qui precede la langue, dans le premier segment.
  const titre = parts[0] ? parts[0].replace(/\s+(Français|Francais|French|English)$/i, '').trim() : null;
  const format = parts.find((p) => /^(PDF|EPUB|CBZ|CBR)$/i.test(p))?.toLowerCase() ?? null;
  const pagesBrut = parts.find((p) => /^\d+\s+Pages?$/i.test(p));
  const tailleBrut = parts.find((p) => /^[\d.,]+\s*(KB|MB|GB)$/i.test(p));
  return {
    titre: titre || null,
    format,
    pages: pagesBrut ? Number.parseInt(pagesBrut, 10) : null,
    taille: tailleBrut ? octets(tailleBrut) : null,
  };
}

function octets(s: string): number | null {
  const m = /^([\d.,]+)\s*(KB|MB|GB)$/i.exec(s.trim());
  if (!m) return null;
  const n = Number(m[1].replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0) return null;
  const facteur = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 }[m[2].toUpperCase() as 'KB' | 'MB' | 'GB'];
  return Math.round(n * facteur);
}

function decoderEntites(s: string): string {
  return s
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

/**
 * Les liens d'hebergeurs d'une fiche, tels qu'elle les publie dans `data-url`.
 *
 * `hebergeur` porte l'HOTE EXACT du lien — `turbobita.net` — et pas un nom d'affichage :
 * c'est lui que le circuit de debridage compare aux domaines que TorBox et AllDebrid
 * declarent. Mesure du 2026-09-11 : TorBox declare `turbobita.net` parmi les domaines de
 * Turbobit, et c'est ce qui rend ces fiches lisibles.
 *
 * SEULS LES LIENS WEB PUBLICS SONT GARDES. Une adresse qui ne se lit pas, un autre
 * protocole, ou un lien vers le site lui-meme ne sont pas des hebergeurs.
 */
export function liensDeLaFiche(html: string, nomFichier?: string, taille?: number): LienDdl[] {
  const t = String(html || '');
  const out: LienDdl[] = [];
  const vus = new Set<string>();
  const cle = 'data-url="';
  let i = t.indexOf(cle);
  while (i >= 0) {
    const j = t.indexOf('"', i + cle.length);
    if (j < 0) break;
    const brut = decoderEntites(t.slice(i + cle.length, j).trim());
    i = t.indexOf(cle, j);
    let u: URL;
    try { u = new URL(brut); } catch { continue; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') continue;
    const hote = u.hostname.toLowerCase();
    if (!hote || !hote.includes('.') || hote.endsWith('downmagaz.net')) continue;
    if (vus.has(u.href)) continue;
    vus.add(u.href);
    out.push({
      hebergeur: hote.replace(/^www\./, ''),
      url: u.href,
      ...(nomFichier ? { nomFichier } : {}),
      ...(taille ? { taille } : {}),
    });
  }
  return out;
}

export interface ParcoursListes {
  /** Le HTML d'une page de liste, ou `null` quand elle n'a pas pu etre lue. */
  lirePage: (n: number) => Promise<string | null>;
  /** L'index connait-il deja cette fiche ? */
  connait?: (rubrique: string, slug: string) => boolean;
  ecrire: (fiches: FicheDownmagaz[]) => void;
  maxPages: number;
  /** Combien de pages DE SUITE sans rien de nouveau avant de s'arreter. */
  arretApres: number;
  pause?: () => Promise<void>;
}

/**
 * Lit les pages de liste de downmagaz jusqu'a retomber sur du connu.
 *
 * La regle d'arret — plusieurs pages connues de suite, arret net sur une page vide — vit
 * dans `parcours-pages.ts`, partagee avec worldivx. Ne reste ici que ce qui est propre au
 * site : ce qu'est une fiche dans sa page, et sa cle.
 */
export async function parcourirListes(o: ParcoursListes): Promise<{ pages: number; nouvelles: number }> {
  return parcourirPages<FicheDownmagaz>({
    lirePage: o.lirePage,
    extraire: fichesDeLaListe,
    cle: (f) => [f.rubrique, f.slug],
    connait: o.connait,
    ecrire: o.ecrire,
    maxPages: o.maxPages,
    arretApres: o.arretApres,
    pause: o.pause,
  });
}
