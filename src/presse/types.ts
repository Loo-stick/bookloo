// Le kiosque de presse : ce qu'est un numero, et ce qu'un site doit savoir en rendre.
//
// POURQUOI CE MODULE EST SEPARE DU RESTE. L'interface `Source` du projet est batie pour
// CHERCHER un titre : elle prend une requete, un budget, une oeuvre a rapprocher, et ses
// resultats sont dedoublonnes par empreinte. Un kiosque n'a ni requete, ni oeuvre, ni
// empreinte — on ne cherche pas un journal, on regarde ce qui vient de paraitre. Y faire
// entrer la presse deformerait une machinerie eprouvee, pour rien.

export type Rubrique = 'journaux' | 'magazines';
export type IdSite = 'wawacity' | 'zone-ebook' | 'bookys';

export const RUBRIQUES: Rubrique[] = ['journaux', 'magazines'];

export interface Numero {
  site: IdSite;
  id: string;
  /** Le nom du titre SEUL — « Les Echos Week-end » — sans sa date. */
  titre: string;
  rubrique: Rubrique;
  /**
   * `2026-08-28`, ou `2026-09` quand le site ne donne que le mois.
   *
   * UNE CHAINE, ET NON UN `Date`. Un mensuel n'a pas de jour : « Cahiers du Cinema -
   * Septembre 2026 » n'est pas paru le premier du mois, et lui en inventer un serait une
   * precision fausse — qui se propagerait ensuite dans le tri et l'affichage. Les chaines
   * ISO s'ordonnent d'elles-memes, ce qui rend le tri exact sans conversion.
   *
   * `null` quand aucune date n'est reconnue : voir `separerTitreDate`, qui refuse de
   * deviner.
   */
  date: string | null;
  /** Le titre tel que le site l'ecrit, garde pour l'affichage et pour le diagnostic. */
  brut: string;
  taille?: number;
}

/**
 * Un site de presse. UNE SEULE METHODE, et c'est voulu.
 *
 * Tout ce qu'un kiosque doit savoir faire, c'est rendre les derniers parus d'une rubrique.
 * La recuperation d'un numero ne passe pas par ici : elle emprunte l'identite
 * `ddl:<site>:<id>` et tout le chemin debrideur deja eprouve.
 */
/**
 * Ce que la route sait de la personne qui cherche.
 *
 * DEUX SITES SUR TROIS N'EN ONT PAS BESOIN, et c'est pourquoi il est facultatif : wawacity
 * et bookys repondent a tout le monde. Zone-ebook, lui, ne CHERCHE que pour ses membres —
 * il lui faut donc de quoi ouvrir une session, et de quoi la retenir par utilisateur.
 */
export interface ContexteKiosque {
  userId: number;
  /** Les cles de cet utilisateur, deja dechiffrees par la route. */
  cles: Record<string, string | undefined>;
}

export interface Kiosque {
  id: IdSite;
  libelle: string;
  dernieres(rubrique: Rubrique, signal?: AbortSignal): Promise<Numero[]>;
  /**
   * Ce site sait-il chercher ?
   *
   * FAUX N'EST PAS UNE PANNE, et c'est pourquoi cela se declare au lieu de se deviner. Un
   * site qui ne sait pas chercher doit le DIRE : rendre une liste vide se lirait « rien
   * ne correspond », ce qui est faux, et rendre ses derniers parus se lirait « voici tes
   * resultats », ce qui est pire.
   */
  chercheable: boolean;
  /**
   * Cherche un titre dans les DEUX rubriques a la fois.
   *
   * Parcourir suffit pour « qu'est-ce qui est paru cette semaine », mais pas pour « je
   * veux les Cahiers du Cinema » : un mensuel sort du kiosque en trois jours. La rubrique
   * de chaque resultat se lit DANS le resultat — une recherche ne sait pas ou elle
   * cherche, et chez Wawacity elle rend aussi des romans et des BD, qu'il faut ecarter.
   *
   * SANS CONTEXTE UTILISABLE, ON REND UNE LISTE VIDE plutot que les derniers parus : une
   * liste vide se lit « rien ne correspond », des parutions se liraient « voici tes
   * resultats ». Et `chercheable` reste vrai — le site SAIT chercher ; c'est ce compte-la
   * qui n'est pas renseigne.
   */
  chercher(terme: string, ctx?: ContexteKiosque, signal?: AbortSignal): Promise<Numero[]>;
}
