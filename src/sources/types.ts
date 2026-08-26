// Types des sources, orientes manga.
//
// La difference de fond avec Dramallyu tient en une ligne : la-bas une requete part
// d'un `tmdbId`, ici d'un TITRE. TMDB ne connait pas les manga, et les scans circulent
// sous trois romanisations. Toute la precision qu'on perd en abandonnant l'identifiant,
// il faut la regagner sur les titres alternatifs et le rapprochement.

import type { Famille } from '../familles/table';

export type Langue = 'FR' | 'VOSTFR' | 'EN' | 'JA' | 'inconnue';
/**
 * `audio` couvre mp3, m4b, flac et les autres : le projet ne distingue les formats que
 * par ce qu'il sait en FAIRE, et il ne sait rien faire d'aucun d'eux. Les separer serait
 * une precision sans usage.
 */
export type Format = 'cbz' | 'cbr' | 'pdf' | 'epub' | 'kindle' | 'audio' | 'inconnu';

/** Plage de tomes couverte par une release. `fin` absent = tome unique. */
export interface PlageTomes {
  debut: number;
  fin?: number;
  integrale: boolean;
}

export type NomCle = 'c411' | 'tr4ker' | 'ygg' | 'g3mini' | 'v3x';

export interface Query {
  /** Toutes les formes du titre, la plus probable en premier. */
  titres: string[];
  /** Identifiant MangaDex quand la recherche part d'une fiche. */
  mangadexId?: string;
  /**
   * ISBN, quand la fiche le connait.
   *
   * Aucun tracker ne l'indexe — c'est Z-Library qui s'en sert, et c'est la seule requete
   * EXACTE qu'on puisse lui adresser. Les autres sources l'ignorent simplement.
   */
  isbn?: string;
  /** Tous les ISBN connus de l'oeuvre. Sert au rapprochement EXACT, pas a la requete. */
  isbns?: string[];
}

export interface Candidate {
  source: string;
  /**
   * Identite d'une release SANS infohash (lien direct).
   *
   * De la forme `ddl:<site>:<id>`, elle ne peut pas entrer en collision avec un hash de
   * quarante caracteres hexadecimaux, et traverse le pipeline existant sans le modifier.
   */
  identite?: string;
  /** Sources supplementaires ou la meme release a ete trouvee (dedoublonnage). */
  aussiSur?: string[];
  /**
   * Adresse ou la release s'obtient HORS de Mangaloo.
   *
   * Pour Telegram : le message d'origine. Les octets vont alors du canal au client de
   * l'utilisateur SANS passer par ce serveur — c'est le chemin le moins couteux, et le
   * seul qui rende le fichier d'origine intact.
   */
  lienExterne?: string;
  titre: string;
  hash?: string;
  /** Lien vers le .torrent. Indispensable sur tracker prive : un hash nu n'y ouvre rien. */
  torrentUrl?: string;
  taille?: number;
  seeders?: number;
  categorie?: string;
  /** Fourni tel quel par Gemini (`num_file`), deduit du .torrent ailleurs. */
  nbFichiers?: number;
  tomes?: PlageTomes;
  langue: Langue;
  format: Format;
  /**
   * D'ou vient le fichier : une source officielle, ou un livre papier scanne.
   *
   * Convention de nommage Tr4ker : RETAiL, SCAN, HYBRiD. Ca ne sert a aucun filtrage —
   * c'est un renseignement pour choisir entre deux editions du meme livre, la ou le
   * titre, le format et la taille ne suffisent pas a departager.
   */
  provenance?: 'retail' | 'scan' | 'hybride';
  /**
   * Les ISBN que la SOURCE annonce pour ce fichier.
   *
   * Quand ils recoupent ceux de la fiche, ce n'est plus une ressemblance de titre : c'est
   * le meme livre. Le rapprochement devient exact au lieu d'etre approche.
   */
  isbns?: string[];
  /**
   * L'edition, en une ligne : « Albin Michel · 2023 · 449 p. ».
   *
   * POURQUOI CE CHAMP EXISTE. Une recherche « Holly » rend trente resultats tous
   * intitules « Holly » : le titre ne les distingue pas, et le format non plus puisqu'ils
   * sont tous en epub. L'editeur, l'annee et la pagination, si — « Albin Michel, 2023,
   * 449 pages » et « De Saxus, 2025, 143 pages » ne sont pas le meme livre.
   *
   * Ces informations avaient d'abord ete collees au TITRE. C'etait une faute : le
   * rapprochement note le titre, et « Holly — Stephen King » tombait de 0,90 a 0,45,
   * sous le seuil. Une donnee d'affichage n'a rien a faire dans un champ qui sert a
   * comparer.
   */
  edition?: string;
  /** Rapprochement avec la fiche, 0..1. Absent en recherche libre. */
  score?: number;
  /** Au-dessus du seuil de rapprochement. Absent en recherche libre. */
  certain?: boolean;
  /**
   * Cle de tri, calculee par le serveur.
   *
   * Le navigateur se contente d'inserer en ordre croissant : la regle — plage de tomes
   * la plus large, puis seeders — ne s'ecrit qu'ici, et le client n'a pas a la
   * comprendre ni a la dupliquer.
   */
  rang?: number;
}

export type EtatSource = 'repondu' | 'vide' | 'echec' | 'cle-absente';

export interface ResultatSource {
  source: string;
  label: string;
  etat: EtatSource;
  candidats: Candidate[];
}

export interface SearchContext {
  cles: Partial<Record<NomCle, string>>;
  signal?: AbortSignal;
  /**
   * Famille interrogee.
   *
   * Absente, chaque source garde ses categories d'origine — celles du manga. C'est ce
   * qui permet aux appels existants de continuer a fonctionner sans etre modifies.
   */
  famille?: Famille;
}

export interface Source {
  id: string;
  label: string;
  /** Absent pour une source publique : Nyaa et Knaben n'authentifient pas. */
  cleRequise?: NomCle;
  search(q: Query, ctx: SearchContext): Promise<Candidate[]>;
}
