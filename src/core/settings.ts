// Reglages a chaud. L'ADRESSE d'un indexeur appartient a l'operateur, la CLE appartient
// a l'utilisateur : un domaine qui bouge se corrige dans config/ sans rebuild ni
// redemarrage, et aucune cle ne se retrouve dans un fichier de configuration.

import {
  existsSync, readFileSync, writeFileSync, renameSync, chmodSync, unlinkSync, mkdirSync,
  accessSync, constants,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { makeEndpointConfig } from './endpoint-config';
import { ErreurLisible } from './erreur-lisible';

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
   * LES SITES EN LIEN DIRECT, DONT LE DOMAINE TOURNE.
   *
   * Ils etaient ecrits EN DUR dans le code — et `zone-ebook.com` deux fois, dans
   * `sources/ddl/` et dans `presse/` : le jour ou l'un changeait, l'autre restait. Un
   * changement de domaine demandait donc un rebuild, pour un site qui en change seul.
   *
   * `wawacity` avait son propre fichier de config. Deux endroits pour la meme decision
   * finissent par diverger : il rejoint les autres ici, et son fichier disparait.
   */
  ddl: {
    wawacity: { base: string };
    zoneEbook: { base: string };
    bookys: { base: string };
    worldivx: { base: string };
  };
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
  // MODE DIRECT (2026-09-29) : le compte de l'hebergeur, un par instance. `session` est
  // une StringSession GramJS — un acces COMPLET au compte, qui ne repart jamais vers le
  // navigateur et n'entre dans aucun journal.
  apiId: number;
  apiHash: string;
  telephone: string;
  session: string;
  canaux: string[];
  // L'INTERRUPTEUR du mode direct, distinct des trois pieces ci-dessus : avoir un compte
  // connecte pour moissonner ne doit pas basculer la lecture et la recherche de production.
  direct: boolean;
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
  telegram: {
    url: '', secret: '',
    // MODE DIRECT (2026-09-29) : le compte de l'hebergeur, un par instance. `session` est
    // une StringSession GramJS — un acces COMPLET au compte, qui ne repart jamais vers le
    // navigateur et n'entre dans aucun journal.
    apiId: 0, apiHash: '', telephone: '', session: '', canaux: [] as string[],
    direct: false,
  },
  // Cle ComicVine : elle appartient a l'OPERATEUR, comme l'adresse de la facade Telegram.
  // Vide, les familles Comics et BD retombent sur la recherche libre — elles ne
  // disparaissent pas, leurs releases existent toujours sur les trackers.
  comicvine: { cle: '' },
  // Depuis le conteneur, FlareSolverr se joint par la passerelle du pont Docker : il
  // publie sur 0.0.0.0 mais vit sur un autre reseau, donc son NOM ne resout pas.
  flaresolverr: { url: '' },
  zlibrary: { domaine: 'z-library.ec' },
  ddl: {
    wawacity: { base: 'https://www.wawacity.estate' },
    zoneEbook: { base: 'https://zone-ebook.com' },
    // Le « www7 » fait partie du domaine, et c'est precisement ce qui tourne.
    bookys: { base: 'https://www7.bookys-ebooks.com' },
    // DEUXIEME DEMENAGEMENT EN UN MOIS. Mesure du 2026-09-28 : `www.worldivx.cc` redirige
    // en cascade vers `worldivx.ws`, qui n'est plus qu'une page d'acces vers des
    // passerelles publicitaires — ses listes rendent 404 et ses `.torrent` echouent. Le
    // miroir ci-dessous sert les memes pages (50 lignes par page, pagination intacte) et
    // rend bien un `application/x-bittorrent`. D'ou son entree dans les reglages : le
    // prochain changement ne demandera plus de reconstruire l'image.
    worldivx: { base: 'https://worldivx.proxy-site.cc' },
  },
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

/**
 * DIT SI LES REGLAGES SONT INSCRIPTIBLES, et pourquoi ils ne le sont pas.
 *
 * Rend `null` quand tout va bien, sinon la phrase a montrer. Le dossier des reglages est un
 * montage lie depuis l'hote : sa propriete est celle de l'hote, et le `chown` de l'image ne s'y
 * applique pas. Un dossier cree par Docker appartient a root, et le conteneur — qui tourne sous
 * un utilisateur non privilegie — ne peut y ecrire aucun reglage.
 */
export function motifReglagesNonInscriptibles(): string | null {
  const dossier = dirname(cheminSettings);
  try {
    mkdirSync(dossier, { recursive: true });
    accessSync(existsSync(cheminSettings) ? cheminSettings : dossier, constants.W_OK);
    return null;
  } catch {
    return `le dossier des reglages (${dossier}) n est pas accessible en ecriture par`
      + ' l application : aucun reglage d instance ne peut etre enregistre';
  }
}

function borner(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

export function getSettings(): Settings {
  const brut = store.get() as Partial<Settings>;
  return {
    sources: { ...DEFAUTS.sources, ...(brut.sources || {}) },
    fanoutBudgetMs: borner(Number(brut.fanoutBudgetMs) || DEFAUTS.fanoutBudgetMs, 2000, 20000),
    // LA BORNE HAUTE VAUT LE DEFAUT, ET PAS MOINS. Elle valait 500 pour un defaut de
    // 2000 : le plafond documente etait inatteignable, et un admin qui saisissait 1500
    // voyait sa valeur ramenee a 500 sans que rien ne le dise. Signale par une revue de
    // code le 2026-08-29.
    maxResultats: borner(Number(brut.maxResultats) || DEFAUTS.maxResultats, 10, 2000),
    torznab: { ...DEFAUTS.torznab, ...(brut.torznab || {}) },
    unit3d: { ...DEFAUTS.unit3d, ...(brut.unit3d || {}) },
    telegram: { ...DEFAUTS.telegram, ...(brut.telegram || {}) },
    comicvine: { ...DEFAUTS.comicvine, ...(brut.comicvine || {}) },
    flaresolverr: { ...DEFAUTS.flaresolverr, ...(brut.flaresolverr as object || {}) },
    zlibrary: { ...DEFAUTS.zlibrary, ...(brut.zlibrary as object || {}) },
    googlebooks: { ...DEFAUTS.googlebooks, ...(brut.googlebooks as object || {}) },
    nyaa: { ...DEFAUTS.nyaa, ...(brut.nyaa || {}) },
    knaben: { ...DEFAUTS.knaben, ...(brut.knaben || {}) },
    // CHAQUE SITE SEPAREMENT, et non `{ ...DEFAUTS.ddl, ...brut.ddl }` : une config qui
    // ne corrige QUE wawacity effacerait sinon les deux autres, qui retomberaient sur
    // `undefined` plutot que sur leur defaut.
    ddl: {
      wawacity: { ...DEFAUTS.ddl.wawacity, ...(brut.ddl?.wawacity || {}) },
      zoneEbook: { ...DEFAUTS.ddl.zoneEbook, ...(brut.ddl?.zoneEbook || {}) },
      bookys: { ...DEFAUTS.ddl.bookys, ...(brut.ddl?.bookys || {}) },
      worldivx: { ...DEFAUTS.ddl.worldivx, ...(brut.ddl?.worldivx || {}) },
    },
  };
}

/**
 * Pose UNE valeur dans le fichier de reglages, puis recharge.
 *
 * `reglages-sources.ts` fait deja ce geste pour les adresses, avec sa propre table de
 * chemins autorises ; cette fonction-ci sert les reglages Telegram, dont la session, qui
 * n'a rien a faire dans une table d'adresses affichee a l'ecran.
 *
 * Ecriture atomique : d'abord un fichier temporaire, puis renommage. Mode 0o600 applique
 * au fichier temporaire ET a la cible apres ecriture, car writeFileSync ne change pas les
 * droits d'un fichier qui existe deja. Cela protege les secrets meme si le fichier de
 * reglages a ete cree en 0o644 par une version anterieure.
 */
export function ecrireReglage(chemin: readonly string[], valeur: unknown): void {
  const brut = existsSync(cheminSettings)
    ? (JSON.parse(readFileSync(cheminSettings, 'utf8')) as Record<string, unknown>)
    : {};
  let n = brut;
  for (const c of chemin.slice(0, -1)) {
    if (typeof n[c] !== 'object' || n[c] === null) n[c] = {};
    n = n[c] as Record<string, unknown>;
  }
  n[chemin[chemin.length - 1]!] = valeur;

  // Ecriture atomique : fichier temporaire puis renommage. Le renommage est atomique
  // sur le meme systeme de fichiers, contrairement a une sequence lire-modifier-ecrire
  // qui peut laisser un JSON tronque en cas de coupure.
  const dir = dirname(cheminSettings);
  let tempDir = dir;
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // Fallback vers tmpdir() si on ne peut pas creer/acceder au dossier de la cible.
    tempDir = tmpdir();
  }
  const temp = `${tempDir}/.settings-${randomBytes(8).toString('hex')}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(brut, null, 2), { mode: 0o600 });
    renameSync(temp, cheminSettings);
    // Appliquer explicitement 0o600 a la cible : writeFileSync ne change pas les droits
    // d'un fichier preexistant. Une instance en 0o644 reste en 0o644, exposant les cles
    // de l'hebergeur. Ce probleme est corrige ici.
    chmodSync(cheminSettings, 0o600);
  } catch (e) {
    // Nettoyer le fichier temporaire en cas d'erreur durant l'ecriture ou le renommage.
    try {
      if (existsSync(temp)) unlinkSync(temp);
    } catch {
      // Echec du nettoyage - pas grave, le fichier sera oublie.
    }
    // UN REFUS DE DROITS N'EST PAS UNE ERREUR INTERNE : c'est un fait d'exploitation que seule
    // la personne qui heberge peut corriger, et « erreur interne » la laissait sans recours.
    const code = (e as { code?: string } | null)?.code;
    if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') {
      throw new ErreurLisible(`${motifReglagesNonInscriptibles()
        ?? 'les reglages n ont pas pu etre ecrits'}. Verifiez les droits du dossier monte.`);
    }
    throw e;
  }
  rechargerSettings();
}
