// LibGen — lire sa page de resultats, et en tirer le lien du fichier.
//
// CE QUE LA SOURCE APPORTE, mesure du 2026-09-15 sur `libgen.li` : des LIVRES et de la
// PRESSE, dont une part FRANCAISE reelle des qu'on cherche un titre francais — sur cent
// resultats, 41 pour Michel Bussi, 35 pour « Le Monde ». Le reste est surtout en anglais, en
// espagnol et en italien. Ses albums et ses mangas existent aussi, mais leurs fichiers ne
// s'ouvrent plus : voir `RUBRIQUES_PAR_FAMILLE` pour la mesure qui les a fait ecarter.
//
// SA RECHERCHE N'A PAS DE FILTRE DE LANGUE. Son formulaire propose les colonnes, les objets,
// les rubriques et le nombre de resultats — rien pour la langue. On demande donc cent
// resultats et on ne garde QUE le francais, lu dans la colonne dediee : c'est ce que veut
// l'utilisateur, et une source francophone qui rendrait de l'espagnol serait du bruit.
//
// UN PIEGE DANS LA PREMIERE CELLULE. Le lien vers l'edition porte une infobulle dont
// l'attribut `title` contient du HTML — « …ID: 102086604<br>BUSSI, Michel - Grave dans le
// sable… ». Retirer les balises au motif `<[^>]+>` s'arrete sur le `>` de ce `<br>` et laisse
// passer un morceau d'attribut dans le titre : « Grave dans le sable (2014…)" href="editio ».
// Le titre se lit donc dans le TEXTE du lien, et seulement la.
//
// Module pur : aucun reseau ici.

import type { Format } from '../types';

export const BASE_LIBGEN = 'https://libgen.li';

/**
 * Les rubriques de LibGen que sert chaque rayon, telles que son formulaire les nomme :
 * `f` Fiction, `l` Libgen (hors fiction), `m` Magazines.
 *
 * Mesure du 2026-09-15 : Michel Bussi rend 100 resultats en Fiction et 13 en Libgen, d'ou les
 * deux pour les livres ; « Le Monde » rend ses numeros en Magazines. `a` (articles
 * scientifiques), `r` (fiction russe) et `s` (normes) ne servent aucun rayon. L'audio
 * n'existe pas chez LibGen.
 *
 * LA RUBRIQUE COMICS EST ECARTEE, et ce n'est pas un oubli. Mesure du 2026-09-16, sur des
 * fichiers pris dans les resultats francais et sondes d'un octet : presse 5 sur 5 servis,
 * livres 4 sur 5, comics 2 sur 5, mangas 0 SUR 5 — et 18 essais de suite sur trois mangas
 * ont tous rendu 503. Les domaines freres (.gl, .vg, .la, .bz) n'y changent rien : ils
 * menent au meme serveur. Proposer des resultats dont neuf sur dix mourront a l'ouverture
 * coute plus qu'ils ne rapportent ; le rayon Comics est servi par Comics Tracker, et les
 * mangas par les autres sources. Ecarte par Loo le 2026-09-16.
 */
const RUBRIQUES_PAR_FAMILLE: Record<string, readonly string[]> = {
  livres: ['f', 'l'],
  presse: ['m'],
};

/** Les rubriques a demander pour ce rayon. Vide : LibGen ne sert pas ce rayon. */
export function rubriquesDeFamille(famille: string): readonly string[] {
  return RUBRIQUES_PAR_FAMILLE[String(famille || '')] ?? [];
}

/** L'adresse d'une recherche : cent fichiers, dans ces rubriques. */
export function urlRechercheLibgen(terme: string, rubriques: readonly string[]): string {
  const p = new URLSearchParams();
  p.set('req', terme);
  for (const c of ['t', 'a', 's', 'y', 'p', 'i']) p.append('columns[]', c);
  // Les FICHIERS seulement : ce sont eux qui portent un md5, donc un lien de telechargement.
  p.append('objects[]', 'f');
  for (const r of rubriques) p.append('topics[]', r);
  p.set('res', '100');
  p.set('filesuns', 'all');
  return `${BASE_LIBGEN}/index.php?${p.toString()}`;
}

/** Les extensions dont on sait faire quelque chose, et ce qu'elles valent ici. */
const FORMATS: Record<string, Format> = {
  epub: 'epub',
  pdf: 'pdf',
  cbz: 'cbz',
  cbr: 'cbr',
  // UN RAR EST UN ALBUM quand il en sort un de Fiction ou de Magazines. La sonde relit de
  // toute facon les premiers octets avant de proposer « Lire ».
  rar: 'cbr',
  mobi: 'kindle',
  azw3: 'kindle',
  azw: 'kindle',
};

/** Le format d'une extension, ou `null` quand on n'en ferait rien (fb2, djvu, doc, txt…). */
export function formatLibgen(extension: string): Format | null {
  return FORMATS[String(extension || '').trim().toLowerCase()] ?? null;
}

/** Vrai quand la colonne de langue annonce du francais, meme parmi d'autres langues. */
export function estFrancais(langue: string): boolean {
  return /\bfrench\b/i.test(String(langue || ''));
}

/** « 460 kB », « 7 MB », « 1.2 GB » -> octets. `undefined` quand c'est illisible. */
export function tailleLibgen(texte: string): number | undefined {
  const m = /^([\d.,]+)\s*(B|kB|KB|MB|GB)$/i.exec(String(texte || '').trim());
  if (!m) return undefined;
  const n = Number(m[1].replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const facteur = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 }[m[2].toLowerCase() as 'b' | 'kb' | 'mb' | 'gb'];
  return Math.round(n * facteur);
}

function decoderEntites(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** Le texte d'une cellule SIMPLE — sans attribut piege. Voir la note en tete de fichier. */
function texte(html: string): string {
  return decoderEntites(String(html || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

export interface LigneLibgen {
  md5: string;
  titre: string;
  serie?: string;
  /** Le numero d'un album ou d'un magazine, lu dans « #58 ». */
  numero?: number;
  auteur: string;
  editeur: string;
  annee?: string;
  langue: string;
  pages?: string;
  taille?: number;
  extension: string;
  isbns: string[];
}

/** Les ISBN que LibGen ecrit en vert sous le titre, separes par des points-virgules. */
function isbnsDe(cellule: string): string[] {
  const vert = /<font color="green">([^<]*)<\/font>/i.exec(cellule);
  if (!vert) return [];
  return [...new Set(vert[1].split(/[;,\s]+/)
    .map((x) => x.trim().toUpperCase())
    .filter((x) => /^(?:97[89])?\d{9}[\dX]$/.test(x)))];
}

/**
 * Les lignes d'une page de resultats.
 *
 * Une ligne compte neuf cellules : titre, auteur, editeur, annee, langue, pages, taille,
 * extension, miroirs. Le md5 vient du lien LibGen des miroirs — sans lui, pas de fichier,
 * donc pas de ligne.
 *
 * DEUX FORMES DE PREMIERE CELLULE, relevees le 2026-09-15 :
 *   - un livre : `<b>Michel Bussi #7</b><br><a … href="edition.php?id=…">Grave dans le sable</a>` ;
 *   - un album ou un magazine : `<b><a href="series.php?id=…">One Piece </a><a …
 *     href="edition.php?id=…"><i> #58</i></a></b>`. Le titre est alors la SERIE suivie du
 *     numero, et la cellule « annee » porte la date de parution, « 2020 Juin ».
 * Et deux formes de lien miroir : `/ads.php?md5=` pour les livres et la presse,
 * `/get.php?md5=` sans cle pour les comics. Le md5 se lit dans l'un comme dans l'autre, et
 * `ads.php` rend bien un lien avec cle pour un md5 de comics.
 */
export function lignesDeLaRecherche(html: string): LigneLibgen[] {
  const out: LigneLibgen[] = [];
  const vus = new Set<string>();
  for (const bloc of String(html || '').split('<tr').slice(1)) {
    const cellules = [...bloc.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]);
    if (cellules.length < 9) continue;

    const md5 = (/(?:ads|get)\.php\?md5=([0-9a-fA-F]{32})/.exec(cellules[8]) || [])[1]?.toLowerCase();
    if (!md5 || vus.has(md5)) continue;

    // LE TEXTE DU LIEN D'EDITION, jamais la cellule entiere : voir la note en tete. Le `href`
    // vient APRES l'infobulle dans la balise, donc ce qui suit son `>` est bien le contenu.
    const edition = texte((/href="edition\.php\?id=\d+"[^>]*>([\s\S]*?)<\/a>/.exec(cellules[0]) || [])[1] || '');
    const serieLiee = decoderEntites((/href="series\.php\?id=\d+"[^>]*>([^<]*)<\/a>/.exec(cellules[0]) || [])[1] || '')
      .replace(/\s+/g, ' ').trim();
    // « #58 », mais aussi « #3 bis » et « #1 2003-jul » : le numero est en tete. LES DATES
    // ABREGEES — « 2003-jul », « 2020-6 », « 2022-apr 7 » — doublent celle de la colonne annee
    // et la faussaient : « 2020-6 Juin 2020 » se lisait « 6 juin 2020 ». Elles sont retirees.
    const numero = /^#\s*(\d{1,5})\b/.exec(edition);
    const editionNette = edition
      .replace(/(?:^|\s)\d{4}-(?:\d{1,2}|[a-z]{3})\b(?:\s+\d{1,2}\b)?/gi, ' ')
      .replace(/\s+/g, ' ').trim();
    const titre = serieLiee ? `${serieLiee} ${editionNette}`.trim() : edition;
    if (!titre) continue;

    const serie = serieLiee
      || decoderEntites((/<b>([^<]+)<\/b>/.exec(cellules[0]) || [])[1] || '').trim();
    // « 2020 Juin » -> « Juin 2020 », « 2022 Avril 7 » -> « 7 Avril 2022 » : la lecture des
    // dates de presse attend le jour, puis le mois, puis l'annee.
    const brute = texte(cellules[3]);
    const jma = /^(\d{4})\s+(\p{L}+)\s+(\d{1,2})$/u.exec(brute);
    const annee = jma ? `${jma[3]} ${jma[2]} ${jma[1]}` : brute.replace(/^(\d{4})\s+(\S.*)$/, '$2 $1');
    const pages = texte(cellules[5]);
    vus.add(md5);
    out.push({
      md5,
      titre,
      serie: serie || undefined,
      numero: numero ? Number(numero[1]) : undefined,
      auteur: texte(cellules[1]),
      editeur: texte(cellules[2]),
      annee: annee || undefined,
      langue: texte(cellules[4]),
      // « 0 » : LibGen ne connait pas le nombre de pages.
      pages: pages && pages !== '0' ? pages : undefined,
      taille: tailleLibgen(texte(cellules[6])),
      extension: texte(cellules[7]).toLowerCase(),
      isbns: isbnsDe(cellules[0]),
    });
  }
  return out;
}

/** Une identite LibGen : `ddl:libgen:<md5>`, le md5 en minuscules. */
export function estIdentiteLibgen(x: string): boolean {
  return /^ddl:libgen:[a-f0-9]{32}$/.test(String(x || ''));
}

export function md5Libgen(identite: string): string {
  return String(identite || '').slice('ddl:libgen:'.length);
}

/**
 * Le lien `get.php` d'une page `ads.php`, RECONSTRUIT plutot que recopie.
 *
 * On ne reprend de la page que la cle, verifiee, et on refabrique l'adresse sur l'hote de
 * LibGen avec le md5 DEMANDE. Une page qui citerait un autre md5, un autre hote ou une cle
 * etrange ne peut donc pas diriger la requete suivante ailleurs.
 */
export function lienGetDepuisAds(html: string, md5: string): string | null {
  const m = /get\.php\?md5=([0-9a-fA-F]{32})&(?:amp;)?key=([A-Za-z0-9_-]{1,128})/.exec(String(html || ''));
  if (!m || m[1].toLowerCase() !== md5) return null;
  return `${BASE_LIBGEN}/get.php?md5=${md5}&key=${m[2]}`;
}

/**
 * L'adresse du fichier vers laquelle `get.php` redirige, si elle est acceptable.
 *
 * Mesure du 2026-09-15 : un 307 vers `cdn2.booksdl.lc`, qui honore les plages. On n'accepte
 * que du HTTPS, sans identifiants dans l'adresse. Le controle des adresses INTERNES, qui
 * demande une resolution DNS, est fait par l'appelant avec `verifierUrlSortante`.
 */
export function adresseCdnAcceptable(location: string | undefined, depuis: string): string | null {
  if (!location) return null;
  let u: URL;
  try { u = new URL(location, depuis); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || !u.hostname.includes('.')) return null;
  return u.href;
}
