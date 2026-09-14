// Le contrat d'un catalogue : chercher une oeuvre, en lire la fiche. Rien d'autre.
//
// Deux methodes suffisent parce que tout le reste du pipeline — releases, rapprochement,
// bibliotheque, visionneuse — travaille sur une `Oeuvre`, pas sur le service qui l'a
// fournie. C'est ce qui permet d'ajouter un catalogue sans toucher au reste.

import type { Oeuvre } from './mangadex';

export type { Oeuvre };

/**
 * Ce qu'on cherche : un TITRE ou un AUTEUR.
 *
 * Ce n'est pas un raffinement d'interface. « Stephen King » tape dans un moteur de titres
 * rend des livres SUR lui, pas DE lui — mesure du 2026-08-24, sur Booknode comme sur
 * Open Library. Les deux services savent repondre correctement, mais par une autre porte.
 */
export type ModeRecherche = 'titre' | 'auteur';

export interface Catalogue {
  id: 'mangadex' | 'comicvine' | 'openlibrary' | 'booknode' | 'bnf';
  /**
   * LE CONTRAT, ET IL VAUT POUR LES QUATRE : une liste vide dit « j'ai repondu, je ne
   * connais pas ce titre ». Un echec LEVE. Les confondre fait afficher « ce catalogue ne
   * connait pas ce titre » a l'utilisateur pendant qu'un service est en panne, et c'est
   * le seul diagnostic qu'il puisse lire.
   */
  chercher(q: string, mode: ModeRecherche, signal?: AbortSignal): Promise<Oeuvre[]>;
  fiche(id: string, signal?: AbortSignal): Promise<Oeuvre | null>;
}

/** Prefixe court par catalogue. `md:` existe deja en base : il ne bouge pas. */
export const PREFIXES: Record<string, string> = {
  mangadex: 'md', comicvine: 'cv', openlibrary: 'ol', booknode: 'bn', bnf: 'bnf',
};

/**
 * Origines d'ou proviennent les couvertures, PAR CATALOGUE.
 *
 * POURQUOI CETTE LISTE EXISTE ICI. La CSP du serveur n'autorise que ce qu'elle enumere.
 * ComicVine a ete ajoute sans y toucher : ses couvertures partaient bien, et le
 * navigateur les bloquait en silence — aucune erreur, juste des cartes sans image.
 *
 * En la posant a cote des catalogues, la CSP se construit A PARTIR d'elle : ajouter un
 * catalogue et oublier sa politique devient impossible, au lieu d'etre le defaut par
 * defaut.
 */
export const HOTES_IMAGES: Record<string, string[]> = {
  mangadex: ['https://uploads.mangadex.org'],
  comicvine: ['https://comicvine.gamespot.com'],
  // PLUSIEURS ORIGINES POUR UN SEUL CATALOGUE, ET C'EST INDISPENSABLE. Open Library ne
  // sert pas ses couvertures : il REDIRIGE vers archive.org, qui redirige a son tour vers
  // un noeud dont le sous-domaine change a chaque image (ia600505, ia800100, ia902809…).
  // La CSP s'applique a chaque etape de la redirection, pas seulement a l'adresse
  // demandee. N'autoriser que covers.openlibrary.org bloquait donc TOUTES les
  // couvertures — verifie au navigateur : image 0x0, et un HTTP 200 dans l'onglet reseau.
  openlibrary: ['https://covers.openlibrary.org', 'https://archive.org', 'https://*.us.archive.org'],
  // VIDE PARCE QU'IL N'Y A RIEN A MONTRER. Une notice BnF decrit un PERIODIQUE — son
  // titre, son ISSN, sa plage de parution — et un periodique n'a pas de couverture : ses
  // numeros en ont, chacun la sienne, et le catalogue ne les repertorie pas.
  bnf: [],
  // VIDE, ET C'EST DELIBERE. Le CDN de Booknode refuse le hotlinking — 403 sans
  // `Referer: https://booknode.com/`, 200 avec. Aucune CSP ne peut y remedier : le
  // navigateur enverra toujours l'adresse de Mangaloo. Les couvertures passent donc par
  // /api/couverture, c'est-a-dire par 'self', et aucune origine externe n'est requise.
  booknode: [],
};

