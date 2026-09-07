// Le kiosque : ce qui bouge dans un rayon, quelle qu'en soit la source.
//
// POURQUOI CE MODULE EST SEPARE DE `presse/`. Un kiosque de presse repond « quels numeros
// sont parus dans cette rubrique » — une rubrique, une date, un numero. Celui-ci repond
// « qu'est-ce qui bouge dans ce rayon », ce qui n'a ni rubrique ni numero, et vaut pour
// six familles. Les faire entrer dans la meme interface deformerait les deux ; l'en-tete
// de `presse/types.ts` tient deja ce raisonnement dans l'autre sens.

import type { Famille } from '../familles/table';

/**
 * Une entree du kiosque.
 *
 * UNE SEULE FORME POUR LES DEUX SECTIONS, et c'est voulu : « en tendance » et « vient de
 * sortir » different par le TRI, pas par la nature. Deux types auraient impose deux
 * rendus, deux tests et deux facons de se tromper.
 */
export interface Entree {
  /** Ce qui identifie l'entree chez sa source. Sert au dedoublonnage et a la cle DOM. */
  id: string;
  /** Le nom de l'oeuvre, tel qu'on l'affiche. */
  titre: string;
  /** La source qui l'a rendue — affichee, et utile au diagnostic. */
  source: string;
  /**
   * Quand, en ISO. `null` quand la source ne le dit pas.
   *
   * UNE CHAINE, PAS UN `Date` : les chaines ISO s'ordonnent d'elles-memes, et c'est la
   * meme decision que pour les parutions de presse, ou elle est deja motivee.
   */
  quand: string | null;
  /** Le detail court : « ch. 214 », « T12 », « 26 aout 2026 ». Vide si rien a dire. */
  detail?: string;
  /** L'etat de l'oeuvre chez la source : « en cours », « termine ». */
  etat?: string;
  couverture?: string;
  /**
   * L'identite d'OEUVRE, quand il y en a une — et seulement alors.
   *
   * UNE RELEASE N'EST PAS UNE OEUVRE. `ddl:wawacity:123` designe un depot, pas un titre du
   * catalogue : le poser ici faisait ouvrir `/oeuvre.html?id=ddl:…`, ou la route ne
   * reconnait aucun catalogue et repond « oeuvre introuvable ». Signale a l'usage.
   *
   * Une entree sans `oeuvre` se clique quand meme : l'ecran cherche alors son TITRE.
   */
  oeuvre?: string;
  /** Le rayon d'ou elle vient, pour que la recherche parte dans la bonne famille. */
  famille?: string;
}

/**
 * Une source du kiosque.
 *
 * DEUX METHODES, ET UNE SOURCE PEUT N'EN SERVIR QU'UNE. MangaDex sait classer par suivis
 * ET rendre les derniers chapitres ; un tracker ne saurait que le second. Rendre une liste
 * vide n'est pas un echec, c'est une reponse — la meme regle que pour les catalogues, ou
 * elle est ecrite depuis le premier jour.
 */
export interface SourceKiosque {
  id: string;
  libelle: string;
  /** Les rayons que cette source alimente. Un rayon absent n'est jamais interroge. */
  familles: string[];
  tendances?(famille: Famille, signal?: AbortSignal): Promise<Entree[]>;
  nouveautes?(famille: Famille, signal?: AbortSignal): Promise<Entree[]>;
}

/** Les deux sections servies. « A paraitre » n'a aucune source : voir `index.ts`. */
export type Section = 'tendances' | 'nouveautes';
