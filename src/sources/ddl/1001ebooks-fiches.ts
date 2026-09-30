// 1001ebooks — lire son inventaire, sans jamais interroger sa recherche.
//
// POURQUOI PAR LES SITEMAPS ET PAS PAR LA RECHERCHE. Le site l'ecrit dans son
// `robots.txt`, et il est explicite :
//
//     Disallow: /recherche      Disallow: /*?s=
//     Disallow: /*?cat=         Disallow: /*?page=
//
// Sa recherche et sa pagination sont donc fermees aux automates. Ce qu'il AUTORISE, et
// qu'il annonce lui-meme dans ce fichier, c'est son sitemap. On construit donc l'index
// localement a partir de ce qu'il publie pour ca, et on cherche dedans — aucune requete
// ne part vers un chemin interdit.
//
// CE QU'IL Y A DEDANS, mesure du 2026-09-08 sur les 28 sitemaps de fiches : 53 988
// adresses publiees pour 47 501 fiches REELLES — les sitemaps se recouvrent, et compter
// les adresses surestime de sept mille. Soit 43 528 livres et 3 973 numeros de presse,
// ces derniers repartis sur 888 periodiques distincts : L'Equipe (125 numeros), Le
// Parisien (125), Mediapart (114), Le Figaro (101), Elle (27).
//
// Et AUCUN manga ni comics : ce site sert deux rayons, pas six, et le brancher aux
// autres ne rendrait que du bruit.

import { normaliserTitre } from '../torrent/release';

export const BASE_1001 = 'https://1001ebooks.app';

/**
 * Les rayons que ce site sert, par sa propre categorie d'adresse.
 *
 * Une categorie absente de cette table n'est pas une erreur : c'est une fiche qui ne
 * nous concerne pas, et elle est simplement ignoree.
 */
const FAMILLE_DE_CATEGORIE: Record<string, string> = {
  romans: 'livres',
  livres: 'livres',
  magazines: 'presse',
  journaux: 'presse',
};

export function familleDeCategorie(categorie: string): string | null {
  return FAMILLE_DE_CATEGORIE[String(categorie || '')] ?? null;
}

/** Les categories qui servent cette famille. Vide : ce site n'a rien pour ce rayon. */
export function categoriesDeFamille(famille: string): string[] {
  return Object.keys(FAMILLE_DE_CATEGORIE).filter((c) => FAMILLE_DE_CATEGORIE[c] === famille);
}

export interface FicheMille {
  categorie: string;
  slug: string;
}

/**
 * Les fiches d'un sitemap.
 *
 * PAS D'AUTOMATE SUR LE DOCUMENT ENTIER. Un sitemap fait 279 Ko sur une poignee de
 * lignes, et ce depot a deja fait tomber la machine avec un motif a quantificateurs sur
 * du contenu de cette forme. On avance donc par `indexOf`, comme la note du projet
 * l'impose, et on ne fait porter le decoupage que sur une adresse a la fois.
 */
export function fichesDuSitemap(xml: string): FicheMille[] {
  const t = String(xml || '');
  const out: FicheMille[] = [];
  let i = t.indexOf('<loc>');
  while (i >= 0) {
    const j = t.indexOf('</loc>', i);
    if (j < 0) break;
    const url = t.slice(i + 5, j).trim();
    const f = ficheDeLUrl(url);
    if (f) out.push(f);
    i = t.indexOf('<loc>', j);
  }
  return out;
}

/** `https://1001ebooks.app/journaux/le-monde-08-septembre-2026` -> categorie + slug. */
export function ficheDeLUrl(url: string): FicheMille | null {
  const s = String(url || '');
  if (!s.startsWith(`${BASE_1001}/`)) return null;
  const reste = s.slice(BASE_1001.length + 1);
  const barre = reste.indexOf('/');
  if (barre <= 0) return null;
  const categorie = reste.slice(0, barre);
  const slug = reste.slice(barre + 1).replace(/\/+$/, '');
  if (!slug || slug.includes('/')) return null;
  if (!FAMILLE_DE_CATEGORIE[categorie]) return null;
  return { categorie, slug };
}

/** L'adresse publique d'une fiche : la seule que l'application donnera jamais. */
export function urlFiche(f: FicheMille): string {
  return `${BASE_1001}/${f.categorie}/${f.slug}`;
}

/**
 * Le suffixe d'unicite que le site ajoute a certains slugs, quand il y en a un.
 *
 * `stephen-king-shining-gz6p7` porte cinq caracteres qui ne veulent rien dire. Mesure du
 * 2026-09-08 : 611 slugs finissent par un groupe de cinq melant lettres et chiffres, et
 * les retirer tous en detruirait 35 qui sont du VRAI vocabulaire — `tome1`, `epub2`,
 * `tome3`. Le depart se fait au nombre de chiffres : les parasites en ont au moins deux
 * (`xcu32`, `87cqe`, `l6ab4`), les mots un seul.
 *
 * ET ON PENCHE VERS GARDER. Il reste un parasite sur 611 (`pc6jw`) que cette regle
 * conserve. C'est le bon sens de l'erreur : garder du bruit est disgracieux, retirer un
 * mot du titre serait faux.
 */
export function sansSuffixeDUnicite(slug: string): string {
  const s = String(slug || '');
  const tiret = s.lastIndexOf('-');
  if (tiret < 0) return s;
  const fin = s.slice(tiret + 1);
  if (fin.length !== 5) return s;
  if (!/^[a-z0-9]+$/.test(fin)) return s;
  const chiffres = fin.replace(/[^0-9]/g, '').length;
  if (chiffres < 2 || chiffres === fin.length) return s;
  return s.slice(0, tiret);
}

/** Le titre lisible d'une fiche : le slug rendu a ses mots. */
export function titreDuSlug(slug: string): string {
  // `amp` ISOLE EST UNE ESPERLUETTE que le slug a gardee de l'encodage HTML — « Ryan &
  // Kansa » y devient `ryan-amp-kansa`. Meme defaut, meme correction que chez downmagaz.
  const mots = sansSuffixeDUnicite(slug).split('-').filter(Boolean).map((m) => (m === 'amp' ? '&' : m));
  if (!mots.length) return '';
  const phrase = mots.join(' ');
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}

/** Les mots d'un slug, normalises comme partout ailleurs dans le depot. */
export function motsDuSlug(slug: string): string[] {
  return normaliserTitre(sansSuffixeDUnicite(slug).replace(/-/g, ' ')).split(' ').filter(Boolean);
}

/**
 * Cette fiche repond-elle a ces mots ?
 *
 * PAR MOTS ENTIERS, JAMAIS PAR SOUS-CHAINE. Chercher « elle france » dans le texte du
 * slug rendait `michelle-frances-la-petite-amie` — « mich[elle-france]s » — et une
 * recherche « berserk » rendait `liee-au-berserker`. Le rapprochement par titre notait
 * ensuite ces faux voisins, mais les faire remonter du tout est deja une faute.
 *
 * Tous les mots demandes doivent etre presents ; leur ORDRE ne compte pas, parce que le
 * site met l'auteur devant — « Shining » de Stephen King s'appelle chez lui
 * `stephen-king-shining`.
 */
export function ficheRepond(motsFiche: readonly string[], motsDemandes: readonly string[]): boolean {
  if (!motsDemandes.length) return false;
  const presents = new Set(motsFiche);
  return motsDemandes.every((m) => presents.has(m));
}

/** Les mots utiles d'une demande : les tres courts n'apportent rien et ramenent tout. */
export function motsDemandes(titre: string): string[] {
  return normaliserTitre(String(titre || ''))
    .split(' ')
    .filter((m) => m.length >= 2);
}
