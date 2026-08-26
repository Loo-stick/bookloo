// Catalogue Booknode, pour la famille Livres.
//
// POURQUOI LUI PLUTOT QU'OPEN LIBRARY SEUL. Deux mesures du 2026-08-24 :
//   — « Holly » (Stephen King, 2023) est INTROUVABLE via Open Library : l'oeuvre existe
//     mais aucune edition francaise n'y est saisie, donc le filtre `language=fre` l'ecarte.
//     Booknode le rend en premiere position, avec le cycle « Holly Gibney » et ses tomes.
//   — Le champ `series` d'Open Library est vide sur TOUS les titres sondes. Booknode
//     publie le nom de la serie et le rang du tome. Sans eux, un pack « Harry Potter
//     INTEGRALE » ne se rapproche d'aucune fiche.
//
// CE QUE CA COUTE, ET POURQUOI OPEN LIBRARY RESTE. Booknode n'a pas d'API : on lit son
// HTML, derriere un pare-feu Cloudflare qui exige FlareSolverr. 2,7 a 5,7 s par page,
// jusqu'a 1,9 Mo. Et un scraping casse sans prevenir. C'est exactement pour ca que
// `livres.ts` garde Open Library en repli : ici, un echec rend une liste vide, jamais
// une exception.
//
// OU S'ACCROCHER DANS LE HTML. Les attributs `data-v-640ffc64` sont des hachages de style
// Vue : ils changent a chaque deploiement de Booknode, s'y fier serait garantir la panne.
// On s'accroche a la classe METIER (`book-name`, `title`), a l'hote du CDN, et pour les
// fiches au bloc schema.org — qui est un contrat public, pas une decision de maquette.

import { pageViaFlaresolverr } from '../core/flaresolverr';
import { urlRelayee } from '../routes/couverture';
import { cached } from '../core/cache';
import { nettoyerForme, type Oeuvre } from './mangadex';
import { isbnsPour, normaliserIsbn } from './googlebooks';
import type { ModeRecherche } from './types';

const BASE = 'https://booknode.com';
const TTL_RECHERCHE_MS = 6 * 60 * 60 * 1000;
const TTL_FICHE_MS = 24 * 60 * 60 * 1000;
// 200, et pas 30 comme dans la premiere version. La bibliographie de Stephen King rend
// 128 livres distincts SUR UNE SEULE PAGE — verifie : `?page=2` renvoie exactement le
// meme contenu, il n'y a pas de pagination a suivre. Un plafond a 30 amputait donc les
// trois quarts de l'oeuvre d'un auteur prolifique, en silence. 200 laisse la marge tout
// en gardant un garde-fou contre une page aberrante.
const MAX_RESULTATS = 200;

/**
 * Un slug de fiche se termine par « _<chiffres> ».
 *
 * PAS DE QUANTIFICATEUR BORNE ICI. La premiere version exigeait `\d{3,7}`, bornee sur
 * les slugs que j'avais sous les yeux — `carrie_0103`, `duma_key_010101`. Les fiches
 * recentes en portent HUIT : « Holly » de Stephen King est `holly_03711335`, et il
 * disparaissait entierement des resultats. Un intervalle deduit d'un echantillon est un
 * pari sur ce qu'on n'a pas regarde.
 *
 * Les series sont ecartees au passage : elles vivent sous /serie/, donc leur chemin
 * contient une barre, et elles n'ont ni release a chercher ni fiche a ouvrir.
 */
function slugDeFiche(url: string): string | null {
  const m = /^https:\/\/booknode\.com\/([a-z0-9_]+)$/.exec(url);
  if (!m) return null;
  return /_\d+$/.test(m[1]) ? m[1] : null;
}

/** Decode les entites que Booknode laisse dans ses libelles. */
function texte(brut: string): string {
  return brut
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Vrai si la page demandee n'existe pas.
 *
 * PIEGE VERIFIE : Booknode rend HTTP 200 et 773 Ko de page pour un auteur inconnu. Se
 * fier au code de statut afficherait une liste vide en croyant avoir reussi.
 */
export function pageIntrouvable(html: string): boolean {
  return /<title>\s*Page non trouv/i.test(html);
}

/** Le slug d'une page auteur, deduit du nom. Verifie sur six auteurs reels, accents et
 *  initiales compris. */
export function slugAuteur(nom: string): string {
  return nom
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function oeuvreBrute(id: string, titre: string, couverture?: string, auteur?: string): Oeuvre {
  const t = texte(titre);
  return {
    id, titre: t, titres: [t], formes: [nettoyerForme(t)].filter(Boolean),
    couverture: couverture ? urlRelayee(couverture) : undefined,
    auteur: auteur ? texte(auteur) : undefined,
  };
}

/**
 * Le titre du LIVRE, extrait du libelle Booknode.
 *
 * « Holly Gibney, Tome 1 : L'Outsider » rend « L'Outsider ». Le separateur est un
 * deux-points entoure d'espaces : c'est ainsi que Booknode ecrit ses fiches de serie, et
 * un deux-points colle appartient au titre lui-meme (« Naruto: Shikamaru's Story »).
 *
 * Rend le libelle inchange quand il n'y a rien a retirer.
 */
export function titreCourt(libelle: string): string {
  const i = libelle.indexOf(' : ');
  if (i === -1) return libelle;
  const court = libelle.slice(i + 3).trim();
  // Un titre vide apres decoupe ne vaut pas mieux que le libelle entier.
  return court || libelle;
}

// TOUT SE LIT PAR BLOC, et c'est la seule facon fiable. Le HTML est decoupe sur la classe
// du titre : chaque troncon porte un livre et un seul, avec son auteur et sa couverture.
//
// DEUX DEFAUTS REELS QUE CETTE APPROCHE CORRIGE.
//
// Les couvertures etaient appariees par le SLUG, en reduisant « holly_03711335 » a
// « holly ». Or « holly_02836923 » — le roman d'Albert French — se reduit au meme : les
// deux cartes affichaient la couverture de Stephen King. Un slug identifie un livre, pas
// sa base.
//
// Les auteurs etaient apparies par ORDRE d'apparition. Un livre sans auteur decalait tous
// les suivants, chacun heritant du nom de son voisin.
//
// La couverture PRECEDE le titre dans le balisage : c'est donc la derniere du troncon
// d'AVANT. Verifie sur la page « Holly » : cinq livres, cinq couvertures distinctes et
// justes, dont les deux homonymes — 5984105 pour King, 1161490 pour French.
const COUVERTURE = /https:\/\/cdn1\.booknode\.com\/book_cover\/[^"'\s]+\.(?:webp|jpg|jpeg|png)/g;

/** Le premier lien de fiche d'un troncon, avec son libelle. */
const PREMIER_LIEN = /<a[^>]*href="(https:\/\/booknode\.com\/[a-z0-9_]+)"[^>]*>\s*([^<]+?)\s*<\/a>/;

/** L'auteur d'un troncon. Absent des pages de bibliographie, ou tous les livres sont du
 *  meme auteur — Booknode ne le repete pas. */
const AUTEUR_BLOC = /class="author"[^>]*>([^<]+)</;

/** La derniere couverture d'un texte, ou `undefined`. */
function derniereCouverture(bloc: string): string | undefined {
  const toutes = bloc.match(COUVERTURE);
  return toutes ? toutes[toutes.length - 1] : undefined;
}

/**
 * Les livres d'une page, lus troncon par troncon.
 *
 * Le titre, l'auteur et la couverture d'un livre sortent tous du MEME troncon : aucune
 * correspondance par ordre ni par slug ne peut donc plus deraper.
 */
function collecter(html: string, marqueur: string): Oeuvre[] {
  const blocs = html.split(marqueur);
  const vus = new Set<string>();
  const out: Oeuvre[] = [];

  // Le premier troncon precede le premier livre : il n'appartient a personne.
  for (let i = 1; i < blocs.length && out.length < MAX_RESULTATS; i++) {
    const m = PREMIER_LIEN.exec(blocs[i]);
    if (!m) continue;
    const id = slugDeFiche(m[1]);
    if (!id || vus.has(id)) continue;
    const titre = texte(m[2]);
    if (!titre) continue;
    vus.add(id);
    out.push(oeuvreBrute(id, titre, derniereCouverture(blocs[i - 1]), AUTEUR_BLOC.exec(blocs[i])?.[1]));
  }
  return out;
}

/** Page de recherche par TITRE. PUR, donc testable sans reseau ni FlareSolverr. */
export function parserRecherche(html: string): Oeuvre[] {
  return collecter(html, 'class="book-name"');
}

/**
 * L'auteur d'une page de bibliographie, lu dans son titre.
 *
 * Cette page n'a pas de `class="author"` — tous ses livres sont du meme auteur, Booknode
 * ne le repete donc pas. Mais la grille de resultats a besoin du nom : sans lui, une
 * recherche par auteur rend 128 cartes anonymes.
 */
export function auteurDeBibliographie(html: string): string | undefined {
  const m = /<title>\s*Tous les livres de ([^<|]{2,80}?)\s*(?:\||<)/i.exec(html);
  return m ? texte(m[1]) : undefined;
}

/** Bibliographie d'un auteur. Meme forme, autre balisage : cette page n'emploie pas
 *  `book-name`. PUR. */
export function parserBibliographie(html: string): Oeuvre[] {
  const livres = collecter(html, 'class="title"');
  const auteur = auteurDeBibliographie(html);
  if (!auteur) return livres;
  return livres.map((o) => (o.auteur ? o : { ...o, auteur }));
}

interface LivreLd {
  '@type'?: string;
  name?: string;
  image?: string;
  description?: string;
  datePublished?: string;
  author?: { name?: string }[] | { name?: string };
  isPartOf?: { name?: string; position?: number };
  isbn?: string;
}

/**
 * Fiche d'un livre, lue dans le bloc schema.org. PUR.
 *
 * C'est le seul endroit de Booknode qui soit un CONTRAT : `name`, `description` en
 * francais, `image`, `isbn`, et `isPartOf` avec le nom de la serie. Le reste de la page
 * est une maquette Vue qui peut changer demain.
 */
export function parserFiche(html: string, id: string): Oeuvre | null {
  const m = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
  if (!m) return null;
  let d: LivreLd;
  try { d = JSON.parse(m[1]) as LivreLd; } catch { return null; }
  if (d['@type'] !== 'Book' || typeof d.name !== 'string') return null;

  const titre = texte(d.name);
  if (!titre) return null;
  const serie = typeof d.isPartOf?.name === 'string' ? texte(d.isPartOf.name) : '';
  const court = titreCourt(titre);

  // LE TITRE DU LIVRE SEUL, EN PREMIER. Booknode nomme ses fiches
  // « <Serie>, Tome N : <Titre> ». Envoye tel quel a une source, ce libelle rend n'importe
  // quoi : mesure du 2026-08-24, « Holly Gibney, Tome 1 : L'Outsider » rend chez Z-Library
  // 30 livres dont 3 du bon auteur, en tete desquels des « Geek Girl » de Holly SMALE —
  // le moteur ayant repondu sur le prenom. Le titre seul met le bon livre au rang 1.
  //
  // Les trois formes partent quand meme, dans cet ordre : le titre court trouve le livre,
  // le libelle complet sert au rapprochement, et le nom de la serie est le seul qui
  // retrouve un pack — un [INTEGRALE] ne porte jamais le titre d'un tome.
  const formes: string[] = [];
  for (const f of [court, titre, serie]) {
    const n = nettoyerForme(f);
    if (n && !formes.some((x) => x.toLowerCase() === n.toLowerCase())) formes.push(n);
  }

  const auteur = Array.isArray(d.author) ? d.author[0]?.name : d.author?.name;
  const annee = Number(String(d.datePublished ?? '').slice(0, 4));

  return {
    id,
    titre,
    // LE TITRE COURT EST DANS LES TITRES, ET C'EST INDISPENSABLE. Le rapprochement note
    // les candidats contre ces formes : sans « L'Outsider », les cinq resultats
    // « L'Outsider » etaient tous classes « correspondance incertaine » face a la fiche
    // « Holly Gibney, Tome 1 : L'Outsider », et disparaissaient dans le bloc replie.
    titres: [...new Set([titre, court, serie].filter(Boolean))],
    formes,
    auteur: typeof auteur === 'string' ? texte(auteur) : undefined,
    annee: Number.isFinite(annee) && annee > 0 ? annee : undefined,
    synopsis: typeof d.description === 'string' ? texte(d.description) : undefined,
    couverture: typeof d.image === 'string' && d.image.startsWith('https://')
      ? urlRelayee(d.image)
      : undefined,
    // Seuls les chiffres et un X final : un ISBN mal forme envoye a une source ne rend
    // rien, et il vaut mieux retomber sur le titre que chercher une chaine absurde.
    isbn: typeof d.isbn === 'string' && /^[0-9-]{9,17}[0-9X]$/i.test(d.isbn.trim())
      ? d.isbn.trim().replace(/-/g, '')
      : undefined,
  };
}

async function page(url: string, cle: string, ttl: number, signal?: AbortSignal): Promise<string | null> {
  return cached<string | null>(
    cle, ttl,
    () => pageViaFlaresolverr(url, signal),
    { scope: 'booknode', echec: (v) => v === null, shouldCache: (v) => v !== null },
  );
}

/**
 * Cherche par titre ou par auteur.
 *
 * Rend une liste VIDE sur tout echec, jamais une exception : `livres.ts` doit pouvoir
 * basculer sur Open Library sans avoir a intercepter quoi que ce soit.
 */
export async function chercherBooknode(
  q: string, mode: ModeRecherche = 'titre', signal?: AbortSignal,
): Promise<Oeuvre[]> {
  const requete = q.trim();
  if (!requete) return [];

  if (mode === 'auteur') {
    const slug = slugAuteur(requete);
    if (!slug) return [];
    const html = await page(`${BASE}/auteur/${slug}/livres`, `booknode:auteur:${slug}`,
      TTL_RECHERCHE_MS, signal);
    if (!html || pageIntrouvable(html)) return [];
    return parserBibliographie(html);
  }

  const html = await page(`${BASE}/search?q=${encodeURIComponent(requete)}`,
    `booknode:titre:${requete.toLowerCase()}`, TTL_RECHERCHE_MS, signal);
  if (!html || pageIntrouvable(html)) return [];
  return parserRecherche(html);
}

export async function ficheBooknode(id: string, signal?: AbortSignal): Promise<Oeuvre | null> {
  // Le slug voyage dans un chemin d'URL : tout ce qui n'a pas sa forme est refuse avant
  // d'atteindre le reseau. Meme regle que `slugDeFiche` — aucune borne sur le nombre de
  // chiffres, elle ecartait les fiches recentes.
  if (!/^[a-z0-9_]+$/.test(id) || !/_\d+$/.test(id)) return null;
  const html = await page(`${BASE}/${id}`, `booknode:fiche:${id}`, TTL_FICHE_MS, signal);
  if (!html || pageIntrouvable(html)) return null;
  const o = parserFiche(html, id);
  if (!o) return null;

  // L'ENRICHISSEMENT SE FAIT ICI, PAS DANS LA RECHERCHE. Google Books a rendu 503 sur
  // deux requetes sur six, meme apres quatre reprises : un service qui tombe une fois
  // sur trois n'a rien a faire dans le chemin critique. Ici, il est appele une seule
  // fois par fiche, dont le resultat tient 24 h en cache, et son echec ne coute qu'une
  // fiche sans ISBN — le rapprochement se fait alors au titre, comme avant.
  const isbns = new Set<string>();
  const propre = o.isbn ? normaliserIsbn(o.isbn) : null;
  if (propre) isbns.add(propre);
  for (const x of await isbnsPour(titreCourt(o.titre), o.auteur, signal)) isbns.add(x);
  return isbns.size > 0 ? { ...o, isbns: [...isbns] } : o;
}
