// Le registre du kiosque : quelle source alimente quel rayon.
//
// UNE SEULE TABLE, et elle est la reponse a « pourquoi ce rayon est vide ». Un rayon sans
// source le DIT ; il n'emprunte pas les entrees d'un autre, et il ne reste pas muet.

import { familleParId, type Famille } from '../familles/table';
import { mangadexKiosque } from './mangadex';
import { presseKiosque } from './presse';
import { sourcesKiosque } from './sources';
import type { ClesEnClair } from '../auth/cles-utilisateur';
import type { Entree, Section, SourceKiosque } from './types';

export type { Entree, Section, SourceKiosque };

/**
 * Les sources du kiosque, dans l'ordre ou on les interroge.
 *
 * MANGADEX SEUL POUR L'INSTANT, et c'est mesure plutot que provisoire : le 2026-09-02,
 * AniList rendait 403 (service desactive), Jikan 504 deux fois, MangaUpdates n'avait que
 * J-1 et J. Ajouter un rayon reviendra a ecrire un adaptateur, pas a toucher a l'ecran.
 */
export const SOURCES: SourceKiosque[] = [mangadexKiosque, presseKiosque];

/**
 * Les sources du kiosque POUR CET UTILISATEUR.
 *
 * `sourcesKiosque` est fabriquee par appel parce qu'elle porte les cles de la personne
 * connectee : une instance partagee aurait fige celles du premier venu. Les deux autres
 * n'en ont pas besoin — MangaDex et les sites de presse repondent a tout le monde.
 */
export function sourcesDe(cles: ClesEnClair, userId: number): SourceKiosque[] {
  return [...SOURCES, sourcesKiosque(cles, userId)];
}

/** Les sources qui servent ce rayon pour cette section. Vide = rayon non servi. */
export function sourcesPour(
  famille: Famille,
  section: Section,
  toutes: SourceKiosque[] = SOURCES,
): SourceKiosque[] {
  return toutes.filter((s) => s.familles.includes(famille.id) && typeof s[section] === 'function');
}

/**
 * Ce rayon est-il servi, tout court ?
 *
 * SERT A LE DIRE A L'ECRAN. Sans cette question, un rayon sans source affichait une page
 * vide, qui se lit « c'est casse » et non « personne ne couvre ce rayon ».
 */
export function rayonServi(famille: Famille, toutes: SourceKiosque[] = SOURCES): boolean {
  return sourcesPour(famille, 'tendances', toutes).length > 0
    || sourcesPour(famille, 'nouveautes', toutes).length > 0;
}

/**
 * Les onglets du kiosque. QUATRE, pas six, et c'est une decision mesuree.
 *
 * BD, COMICS ET MANGAS SONT UN SEUL RAYON ICI parce que les sources ne les distinguent
 * pas. Releve dans la table des familles : `7030` vaut chez c411 comme chez tr4ker pour
 * les trois ; v3x n'a que `7000`, la branche Livres entiere — « l'API de V3X ne filtre
 * qu'au premier niveau », dit deja le commentaire ; et la section `bd-comics-mangas` de
 * zone-ebook les mele par construction.
 *
 * POUR UNE RECHERCHE CELA NE SE VOIT PAS : le titre demande discrimine. En PARCOURANT il
 * n'y a pas de titre, et l'etagere « mangas » d'un tracker qui n'en a pas EST son etagere
 * « bande dessinee ». Trois onglets auraient promis un tri que personne ne fait.
 *
 * LA TABLE DES FAMILLES NE BOUGE PAS : la recherche garde ses six rayons, ou la
 * distinction a un sens. C'est une decision d'AFFICHAGE du kiosque, pas du modele.
 */
export interface RayonKiosque {
  id: string;
  libelle: string;
  /** Les familles reunies sous cet onglet. Une seule, le plus souvent. */
  familles: string[];
}

export const RAYONS_KIOSQUE: RayonKiosque[] = [
  { id: 'dessine', libelle: 'BD · Comics · Mangas', familles: ['bd', 'comics', 'mangas'] },
  { id: 'livres', libelle: 'Livres', familles: ['livres'] },
  { id: 'audio', libelle: 'Audiobook', familles: ['audio'] },
  { id: 'presse', libelle: 'Presse', familles: ['presse'] },
];

/** Le rayon demande, ou `null`. Jamais de rayon par defaut. */
export function rayonParId(id: unknown): RayonKiosque | null {
  return typeof id === 'string'
    ? RAYONS_KIOSQUE.find((r) => r.id === id) ?? null
    : null;
}

/** Les familles d'un rayon, resolues par la table — jamais une liste ecrite deux fois. */
export function famillesDe(rayon: RayonKiosque): Famille[] {
  return rayon.familles.map(familleParId).filter((f): f is Famille => f !== null);
}

/** Les onglets, et lesquels sont servis. Tous y figurent, servis ou non. */
export function rayons(toutes: SourceKiosque[] = SOURCES): { id: string; libelle: string; servi: boolean }[] {
  return RAYONS_KIOSQUE.map((r) => ({
    id: r.id,
    libelle: r.libelle,
    servi: famillesDe(r).some((f) => rayonServi(f, toutes)),
  }));
}

/**
 * POURQUOI « A PARAITRE » N'A AUCUNE SOURCE, et pourquoi c'est ecrit ici.
 *
 * Mesure du 2026-09-02, sur les cinq pistes possibles : AniList repond 403, Jikan 504,
 * les 312 chapitres « futurs » de MangaDex portent tous la date sentinelle 2037-12-31 et
 * aucun n'est en francais, `releases/days` de MangaUpdates ne contient que J-1 et J, et
 * hardcover n'annonce que 30 parutions francaises sur 60 jours, des romans.
 *
 * Les seuls calendriers francais — Manga-News, Nautiljon — refusent les robots ou ne
 * portent aucune structure exploitable.
 *
 * L'ECRAN LE DIT AVEC SA RAISON. Une section muette se lit « c'est casse » ; une phrase
 * se lit « c'est ainsi », et elle date la mesure pour qui la reprendra.
 */
/**
 * POURQUOI UNE SECTION PEUT ETRE ABSENTE, et pourquoi elle le dit.
 *
 * Une section qui disparait se lit « c'est casse ». Une section qui s'explique se lit
 * « c'est en chantier », et le lecteur sait s'il doit revenir.
 */
export const MOTIFS_SECTION_ABSENTE: Record<Section, string> = {
  tendances: 'Aucune source ne classe ce rayon par popularite.',
  nouveautes:
    'Aucune de vos sources ne sait encore lister ses derniers ajouts pour ce rayon. '
    + 'Verifiez que la cle du tracker est renseignee dans « Compte », ou que ce rayon '
    + 'declare bien des categories pour vos sources.',
};

export const MOTIF_A_PARAITRE =
  'Aucune source ne l annonce. Mesure du 2026-09-02 : AniList est hors service, Jikan '
  + 'injoignable, MangaDex et MangaUpdates ne portent aucune date future, et les '
  + 'calendriers francais refusent les robots.';
