// worldivx — lire une page de liste, et n'en rien demander de plus.
//
// CE QU'EST CE SITE. Un site public francophone : aucun compte, aucune cle, et des
// magnets qui n'annoncent que des trackers publics ouverts. Son `robots.txt` autorise
// tout. Il sert surtout films et series ; pour ce projet, deux categories comptent,
// mesurees le 2026-09-14 :
//
//   - `ebooks` : ≈ 2 328 fiches, toutes en sous-categorie « Magasines » — la presse du jour
//     en PDF, Le Monde, Liberation, Les Echos, L'Equipe… ;
//   - `livres` : ≈ 279 fiches, de l'epub surtout, un peu de PDF.
//
// Ni BD, ni mangas, ni comics, ni livres audio : `/category/bd`, `/mangas`, `/comics`,
// `/magazines`, `/audio` rendent tous une page vide.
//
// L'EMPREINTE EST DANS LA LIGNE, et c'est ce qui rend la source legere. La fiche d'une
// release pese 644 Ko ; mais le site nomme la VIGNETTE de chaque release d'apres son
// empreinte — `zimage.cc/uploads/screen/<empreinte>.webp` — et cette vignette figure dans
// la ligne de liste. Verifie sur quatre fiches : empreinte identique a celle du formulaire
// de la fiche. Et presente sur 377 lignes sur 377, toutes categories confondues. La ligne
// donne aussi la taille, les seeders et la sous-categorie.
//
// UNE PRECAUTION : c'est une convention de nommage, pas un champ. Si le site la change,
// les lignes cessent de fournir une empreinte ; elles sont alors IGNOREES plutot que
// devinees, et l'index se vide de lui-meme a la reconstruction suivante — ce qui se voit.
//
// Module pur : aucun reseau ici.

import { normaliserTitre } from './release';

export const BASE_WORLDIVX = 'https://www.worldivx.cc';
export const TAILLE_PAGE = 50;

/** Les categories du site qui servent un rayon de ce projet. */
export const CATEGORIES_WORLDIVX: readonly string[] = ['ebooks', 'livres'];

export interface LigneWorldivx {
  id: number;
  /** Le nom de la release, tel que le site l'ecrit. */
  nom: string;
  /** L'empreinte, en minuscules. */
  hash: string;
  taille?: number;
  seeders?: number;
  /** « Ebooks », « Livres »… */
  categorie: string;
  /** « Magasines », « Epub », « PDF »… */
  sousCategorie?: string;
}

/**
 * Les rayons d'une categorie, qu'on la lise dans l'adresse (`ebooks`) ou dans la ligne
 * (« Ebooks »). Toute autre categorie ne sert aucun rayon de ce projet.
 */
export function famillesDeCategorie(categorie: string): string[] {
  const c = normaliserTitre(String(categorie || ''));
  if (c === 'ebooks') return ['presse'];
  if (c === 'livres') return ['livres'];
  return [];
}

/**
 * L'adresse de la page `n` d'une categorie.
 *
 * LES DECALAGES COMMENCENT A 1 : la page 2 est `/51`, la page 3 `/101`. C'est la forme des
 * liens de pagination du site, et celle qu'aiosources utilise depuis sa premiere
 * aspiration. Un decalage compte a partir de 0 sauterait ou doublerait une ligne par page.
 */
export function urlPageCategorie(categorie: string, n: number): string {
  const c = encodeURIComponent(categorie);
  return n <= 1 ? `${BASE_WORLDIVX}/category/${c}` : `${BASE_WORLDIVX}/category/${c}/${1 + TAILLE_PAGE * (n - 1)}`;
}

/** Le `.torrent` public d'une release. Il se decode, et ne porte aucun passkey. */
export function urlTorrentWorldivx(hash: string): string {
  return `${BASE_WORLDIVX}/get_torrents/${encodeURIComponent(String(hash || '').toLowerCase())}`;
}

/** « 25.21 MB » -> octets, en unites binaires. `undefined` quand c'est illisible. */
export function tailleWorldivx(texte: string | null | undefined): number | undefined {
  if (!texte) return undefined;
  const m = /^([\d.,]+)\s*([KMGT]?)o?B?$/i.exec(texte.trim());
  if (!m) return undefined;
  const valeur = Number(m[1].replace(',', '.'));
  if (!Number.isFinite(valeur) || valeur < 0) return undefined;
  const puissance = { '': 0, K: 1, M: 2, G: 3, T: 4 }[m[2].toUpperCase() as '' | 'K' | 'M' | 'G' | 'T'] ?? 0;
  return Math.round(valeur * 1024 ** puissance);
}

/**
 * Le texte que la protection d'adresses e-mail de Cloudflare a masque.
 *
 * Cloudflare remplace dans le HTML tout ce qui ressemble a `quelque@chose` par un
 * `<span class="__cf_email__" data-cfemail="…">`. Des noms de release y tombent — le
 * groupe « Dm@r », releve par aiosources. Le premier octet est la cle, les suivants le
 * texte XORe par elle.
 */
export function decoderCfEmail(hex: string): string {
  const h = String(hex || '');
  if (h.length < 2 || h.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(h)) return '';
  const cle = parseInt(h.slice(0, 2), 16);
  let out = '';
  for (let i = 2; i < h.length; i += 2) out += String.fromCharCode(parseInt(h.slice(i, i + 2), 16) ^ cle);
  return out;
}

function decoderEntites(s: string): string {
  return s
    .replace(/&#0?39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/**
 * Les lignes d'une page de liste.
 *
 * SEULES LES CELLULES `liste-accueil-nom` COMPTENT : un widget « Top », present sur toutes
 * les pages, pointe aussi vers des fiches. On decoupe donc la page par ligne de tableau et
 * on ne lit que les lignes qui portent cette cellule — ce qui garde aussi chaque motif sur
 * quelques kilo-octets, jamais sur les 700 Ko de la page.
 *
 * UNE LIGNE SANS EMPREINTE EST IGNOREE : sans elle, ce n'est pas un candidat torrent, et
 * la retrouver demanderait d'ouvrir la fiche.
 */
export function lignesDeLaListe(html: string): LigneWorldivx[] {
  const out: LigneWorldivx[] = [];
  const vus = new Set<number>();
  for (const bloc of String(html || '').split('<tr')) {
    if (!bloc.includes('liste-accueil-nom')) continue;
    const lien = /href="\/detail\/(\d+)"\s*>([\s\S]*?)(?:<span class="WinOption1"|<\/a>)/.exec(bloc);
    if (!lien) continue;
    const id = Number(lien[1]);
    if (!Number.isSafeInteger(id) || id <= 0 || vus.has(id)) continue;

    const nom = decoderEntites(
      lien[2]
        .replace(/<span class="__cf_email__"[^>]*data-cfemail="([0-9a-fA-F]+)"[^>]*>[\s\S]*?<\/span>/g,
          (_t, hex: string) => decoderCfEmail(hex))
        .replace(/<[^>]+>/g, ' '),
    ).replace(/\s+/g, ' ').trim();
    const empreinte = /zimage\.cc\/uploads\/screen\/([0-9a-fA-F]{40})\./.exec(bloc);
    if (!nom || !empreinte) continue;

    const taille = /liste-accueil-taille"[^>]*>([^<]+)</.exec(bloc);
    const seeders = /Seeders:\s*(\d+)/.exec(bloc);
    const categorie = /liste-accueil-type"\s+title="([^"]+)"/.exec(bloc);
    const sous = /Sous-Cat[^:]*:\s*([^<]+)</.exec(bloc);

    vus.add(id);
    out.push({
      id,
      nom,
      hash: empreinte[1].toLowerCase(),
      taille: tailleWorldivx(taille?.[1]),
      seeders: seeders ? Number(seeders[1]) : undefined,
      categorie: categorie ? decoderEntites(categorie[1]).trim() : '',
      sousCategorie: sous ? decoderEntites(sous[1]).trim() : undefined,
    });
  }
  return out;
}
