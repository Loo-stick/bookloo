// Reglages a chaud. L'ADRESSE d'un indexeur appartient a l'operateur, la CLE appartient
// a l'utilisateur : un domaine qui bouge se corrige dans config/ sans rebuild ni
// redemarrage, et aucune cle ne se retrouve dans un fichier de configuration.

import { makeEndpointConfig } from './endpoint-config';

export interface IndexeurTorznab {
  enabled: boolean;
  url: string;
  categories: number[];
}

export interface IndexeurUnit3d {
  enabled: boolean;
  url: string;
  categorie: number;
}

export interface SourcePublique {
  enabled: boolean;
  url: string;
  /** Categories propres a la source, sous sa forme a elle. */
  categories: (string | number)[];
}

export interface Settings {
  sources: Record<string, boolean>;
  fanoutBudgetMs: number;
  maxResultats: number;
  torznab: Record<string, IndexeurTorznab>;
  unit3d: Record<string, IndexeurUnit3d>;
  nyaa: SourcePublique;
  knaben: SourcePublique;
  telegram: SourceTelegram;
  comicvine: { cle: string };
  /**
   * FlareSolverr : l'adresse appartient a l'OPERATEUR, comme la facade Telegram.
   *
   * Booknode est derriere un pare-feu Cloudflare qui refuse l'acces direct — HTTP 403,
   * « you have been blocked ». Ce n'est pas un defi JavaScript qu'on contourne avec un
   * en-tete : il faut un vrai navigateur, et c'est ce que FlareSolverr fournit.
   *
   * Vide, le catalogue Booknode n'existe simplement pas et la famille Livres est servie
   * par Open Library seul. Rien ne casse, la fiche est juste moins riche.
   */
  flaresolverr: { url: string };
  /**
   * Z-Library : seul le DOMAINE est ici. Les identifiants appartiennent a chaque
   * utilisateur et vivent chiffres dans la table `cles`.
   *
   * Le domaine est un reglage et non une constante parce que ces domaines sont saisis
   * regulierement. Mesure du 2026-08-24 depuis ce serveur : z-library.ec, z-lib.gd et
   * z-lib.gl repondent ; z-lib.fm, z-lib.sk et z-library.sk sont injoignables. Le jour ou
   * le defaut tombe, un champ se modifie au lieu d'un deploiement.
   */
  zlibrary: { domaine: string };
  /**
   * Google Books : la cle appartient a l'OPERATEUR, comme celle de ComicVine.
   *
   * Elle ne sert QU'A une chose : recuperer les ISBN de toutes les editions d'un livre.
   * Mesure du 2026-08-24 — Booknode ne donne que l'ISBN de l'edition poche, qui ne recoupe
   * JAMAIS ce que Z-Library indexe (0 sur 7). Google Books rend les ISBN de toutes les
   * editions, dont celle de l'editeur d'origine : 4 recoupements sur 4 cas aboutis.
   *
   * Vide, les fiches n'ont pas d'ISBN et le rapprochement se fait au titre, comme avant.
   */
  googlebooks: { cle: string };
}

/**
 * Source Telegram : l'ADRESSE et le SECRET appartiennent tous deux a l'OPERATEUR.
 *
 * C'est ce qui la distingue d'un tracker, ou la cle appartient a l'utilisateur. Ici
 * l'acces vient d'un bot d'indexation heberge a cote ; un utilisateur n'a rien a
 * renseigner, et ne peut rien y faire si l'operateur ne l'heberge pas.
 */
export interface SourceTelegram {
  url: string;
  secret: string;
}

// Categories MESUREES le 2026-08-20, pas devinees. Les caps des indexeurs mentent dans
// les deux sens : `book-search` est annonce et n'existe pas, `cat` fonctionne sans etre
// annonce. Voir la spec § 15.
const DEFAUTS: Settings = {
  sources: {
    yggreborn: true, c411: true, tr4ker: true, g3mini: true, v3x: true,
    nyaa: true, knaben: true, wawacity: true,
  },
  // 8 s : au-dela, l'utilisateur regarde une page qui ne se remplit pas.
  fanoutBudgetMs: 8000,
  // CE N'EST PLUS UN BUDGET D'AFFICHAGE, C'EST UN GARDE-FOU. Le client ne peint plus
  // aucune carte tant qu'aucun filtre n'est choisi : le cout d'un resultat de plus est
  // devenu celui de quelques centaines d'octets dans le flux, pas d'un noeud DOM.
  //
  // Limiter n'avait plus de sens et faisait du mal : sur « Holly », 108 des 120 places
  // partaient en bruit et Z-Library etait ecarte en entier ; sur « Naruto », les trackers
  // remplissaient tout avant que Telegram ne reponde. Chaque source se borne deja
  // elle-meme entre 30 et 100 resultats — ce plafond-ci n'existe que pour le cas ou l'une
  // d'elles deraillerait.
  maxResultats: 2000,
  torznab: {
    // La seule source a granularite fine : 7102 BD, 7103 Mangas, 7104 Comics.
    yggreborn: {
      enabled: true,
      url: 'https://api.yggreborn.org/api',
      categories: [7102, 7103, 7104],
    },
    // C411 replie manga, BD et comics sur 7030 : aucun filtrage plus fin n'existe de
    // ce cote, c'est la requete qui discrimine.
    c411: { enabled: true, url: 'https://c411.org/api', categories: [7030] },
    // V3X ne declare QUE des categories de premier niveau — releve `t=caps` du
    // 2026-08-25 : 1000 Console, 2000 Movies, 3000 Audio, 4000 PC, 5000 TV, 7000 Books,
    // 8000 Other. 7000 est donc toute la granularite qu'il offre, et il n'y a pas de
    // sous-categorie a viser.
    v3x: { enabled: true, url: 'https://api.v3x.club/torznab', categories: [7000] },
    tr4ker: { enabled: true, url: 'https://tr4ker.net/torznab', categories: [7000] },
  },
  unit3d: {
    // Gemini : categorie « Livres » = 12.
    g3mini: { enabled: true, url: 'https://gemini-tracker.org', categorie: 12 },
  },
  // Sources PUBLIQUES : aucune cle, donc actives pour tout le monde.
  // Nyaa, categories Literature : 3_1 traduit en anglais, 3_2 traduit dans une autre
  // langue (le francais y est), 3_3 raw japonais — que les trackers FR n'ont pas.
  // Vide par defaut, et c'est le point : sans bot d'indexation en face, cette source
  // n'existe pas. Elle ne doit alors apparaitre NULLE PART — pas meme en « cle absente »,
  // qui inviterait l'utilisateur a corriger quelque chose dont il n'a pas la main.
  telegram: { url: '', secret: '' },
  // Cle ComicVine : elle appartient a l'OPERATEUR, comme l'adresse de la facade Telegram.
  // Vide, les familles Comics et BD retombent sur la recherche libre — elles ne
  // disparaissent pas, leurs releases existent toujours sur les trackers.
  comicvine: { cle: '' },
  // Depuis le conteneur, FlareSolverr se joint par la passerelle du pont Docker : il
  // publie sur 0.0.0.0 mais vit sur un autre reseau, donc son NOM ne resout pas.
  flaresolverr: { url: '' },
  zlibrary: { domaine: 'z-library.ec' },
  googlebooks: { cle: '' },
  nyaa: { enabled: true, url: 'https://nyaa.si', categories: ['3_1', '3_2', '3_3'] },
  // Knaben, 6000000 = Books (dont Books/Comics).
  knaben: { enabled: true, url: 'https://api.knaben.org/v1', categories: [6000000] },
};

const store = makeEndpointConfig<Record<string, unknown>>(
  'runtime-settings.json',
  'RUNTIME_SETTINGS_CONFIG',
  DEFAUTS as unknown as Record<string, unknown>,
);

export const rechargerSettings = store.reload;
export const cheminSettings = store.path;

function borner(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function getSettings(): Settings {
  const brut = store.get() as Partial<Settings>;
  return {
    sources: { ...DEFAUTS.sources, ...(brut.sources || {}) },
    fanoutBudgetMs: borner(Number(brut.fanoutBudgetMs) || DEFAUTS.fanoutBudgetMs, 2000, 20000),
    maxResultats: borner(Number(brut.maxResultats) || DEFAUTS.maxResultats, 10, 500),
    torznab: { ...DEFAUTS.torznab, ...(brut.torznab || {}) },
    unit3d: { ...DEFAUTS.unit3d, ...(brut.unit3d || {}) },
    telegram: { ...DEFAUTS.telegram, ...(brut.telegram || {}) },
    comicvine: { ...DEFAUTS.comicvine, ...(brut.comicvine || {}) },
    flaresolverr: { ...DEFAUTS.flaresolverr, ...(brut.flaresolverr as object || {}) },
    zlibrary: { ...DEFAUTS.zlibrary, ...(brut.zlibrary as object || {}) },
    googlebooks: { ...DEFAUTS.googlebooks, ...(brut.googlebooks as object || {}) },
    nyaa: { ...DEFAUTS.nyaa, ...(brut.nyaa || {}) },
    knaben: { ...DEFAUTS.knaben, ...(brut.knaben || {}) },
  };
}
