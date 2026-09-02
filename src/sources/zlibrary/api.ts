// Client Z-Library.
//
// TROIS CHOSES MESUREES LE 2026-08-24, ET QU'ON NE DEVINE PAS.
//
// 1. LA RECHERCHE NE DEMANDE AUCUN COMPTE. `/eapi/book/search` repond en anonyme.
//    Exiger une connexion pour chercher obligerait a saisir ses identifiants avant de
//    savoir si la source sert a quelque chose.
//
// 2. LE FILTRE DE LANGUE N'ACCEPTE QUE LA MINUSCULE ANGLAISE. `languages[0]=french`
//    filtre ; `French` et `fr` rendent tout, SANS erreur et sans rien signaler. C'est le
//    pire genre de defaut : la requete reussit et rend n'importe quoi. D'ou la
//    normalisation systematique de l'entree.
//
// 3. LE QUOTA EPUISE SE DEGUISE EN SUCCES. Voir `lienFichier`.
//
// Le domaine est un REGLAGE. Trois domaines sur six sondes etaient injoignables : en
// coder un en dur, c'est promettre un deploiement le jour ou il saute.

import { getSettings } from '../../core/settings';
import { postForm } from '../../core/http';
import { httpGet } from '../../core/http';

const TIMEOUT_MS = 20_000;
export const LIMITE = 30;

// Z-Library refuse les requetes sans agent credible.
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export function domaine(): string {
  return getSettings().zlibrary.domaine.trim().replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

function base(): string {
  return `https://${domaine()}`;
}

function entetes(session?: Session): Record<string, string> {
  const e: Record<string, string> = {
    Accept: 'application/json, text/javascript, */*; q=0.01',
    'User-Agent': UA,
    Referer: `${base()}/`,
  };
  // La session se rejoue en Cookie, comme le fait le site lui-meme.
  if (session) e.Cookie = `remix_userid=${session.id}; remix_userkey=${session.cle}`;
  return e;
}

export interface Session {
  id: string;
  cle: string;
}

export interface LivreZl {
  id?: string | number;
  title?: string;
  author?: string;
  year?: string | number;
  language?: string;
  extension?: string;
  filesize?: number;
  series?: string;
  publisher?: string;
  pages?: string | number;
  /** Tous les ISBN de l'edition, separes par des virgules. */
  identifier?: string;
  cover?: string;
  href?: string;
  hash?: string;
  description?: string;
}

/**
 * Ramene une saisie de langue a la forme que l'API accepte.
 *
 * « French », « FR », « Français », « francais » donnent tous `french`. Sans ca, le
 * filtre est ignore en silence — verifie.
 */
export function normaliserLangue(saisie: string): string {
  const n = saisie.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
  const ALIAS: Record<string, string> = {
    fr: 'french', francais: 'french', french: 'french',
    en: 'english', anglais: 'english', english: 'english',
    ja: 'japanese', japonais: 'japanese', japanese: 'japanese',
  };
  return ALIAS[n] ?? n;
}

/** Erreur portant un message DEJA formule pour l'utilisateur. */
export class ErreurZlibrary extends Error {}

/**
 * Ouvre une session.
 *
 * Rend la session, ou jette avec un message utilisable tel quel. On ne relaie jamais une
 * exception brute : elle peut porter l'URL, donc des parametres.
 */
export async function connecter(email: string, motdepasse: string): Promise<Session> {
  const r = await postForm(`${base()}/eapi/user/login`, { email, password: motdepasse }, {
    timeoutMs: TIMEOUT_MS,
    headers: { ...entetes(), 'X-Requested-With': 'XMLHttpRequest' },
  });
  if (!r) throw new ErreurZlibrary(`Z-Library (${domaine()}) est injoignable.`);

  let j: Record<string, unknown>;
  try { j = JSON.parse(r) as Record<string, unknown>; }
  catch { throw new ErreurZlibrary('Z-Library a rendu une reponse illisible. Le domaine est peut-etre bloque.'); }

  const u = (j.user ?? j.response ?? {}) as Record<string, unknown>;
  if (Number(j.success) !== 1 || !u.id || !u.remix_userkey) {
    const m = (j.error as { message?: string } | string | undefined);
    const texte = typeof m === 'string' ? m : m?.message;
    throw new ErreurZlibrary(texte ? `Z-Library : ${texte}` : 'Identifiants Z-Library refuses.');
  }
  return { id: String(u.id), cle: String(u.remix_userkey) };
}

/** Recherche. Anonyme si aucune session n'est fournie. */
export async function chercher(
  q: string, langue: string | undefined, session?: Session, signal?: AbortSignal,
): Promise<LivreZl[]> {
  const champs: Record<string, string> = { message: q, page: '1', limit: String(LIMITE) };
  if (langue) champs['languages[0]'] = normaliserLangue(langue);

  const r = await postForm(`${base()}/eapi/book/search`, champs, {
    timeoutMs: TIMEOUT_MS, signal, headers: entetes(session),
  });
  // UN ECHEC LEVE, IL NE REND PAS UNE LISTE VIDE. C'est la convention du reste du
  // projet, et `core/fanout.ts` sait deja s'en servir : une source qui jette prend
  // l'etat « echec » et l'interface l'affiche en pastille, alors qu'une liste vide
  // affiche « vide » — c'est-a-dire « cette oeuvre n'existe pas chez Z-Library ». Dire
  // l'un pour l'autre pendant une panne est le pire renseignement qu'on puisse donner.
  // Signale par une revue de code le 2026-08-29.
  if (r === null) throw new ErreurZlibrary('Z-Library n a pas repondu');
  return livresDeReponse(r);
}

/**
 * Les livres d'une reponse de recherche. LEVE sur un corps illisible.
 *
 * Separee de l'appel reseau pour etre executee par les tests : la forme exacte de la
 * reponse — deux emplacements selon le type de correspondance — est le genre de detail
 * qui se verifie sur des donnees mesurees, pas en relisant du code.
 */
export function livresDeReponse(corps: string): LivreZl[] {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(corps) as Record<string, unknown>;
  } catch {
    throw new ErreurZlibrary('Z-Library a rendu une reponse illisible');
  }

  // Une recherche EXACTE range ses resultats ailleurs que la recherche large. Ne lire que
  // `books` perd silencieusement les correspondances exactes.
  const larges = Array.isArray(j.books) ? (j.books as LivreZl[]) : [];
  if (larges.length > 0) return larges;
  const exact = (j.exactMatch as { books?: LivreZl[] } | undefined)?.books;
  return Array.isArray(exact) ? exact : [];
}

export interface LienFichier {
  url: string;
  extension?: string;
}

/**
 * Le lien de telechargement d'un livre.
 *
 * LE PIEGE QUI COMPTE, ET QU'ON NE DEVINE PAS : quota quotidien epuise, l'API repond
 * `success: 1` AVEC la fiche du livre mais SANS `downloadLink`, et `allowDownload` a
 * `false`. Un code qui ne testerait que `success` conclurait a une reussite et rendrait
 * une URL vide — l'utilisateur verrait un telechargement qui ne demarre jamais, sans
 * savoir que son quota est en cause.
 */
export async function lienFichier(
  session: Session, id: string, hash: string, signal?: AbortSignal,
): Promise<LienFichier> {
  const r = await httpGet<string>(
    `${base()}/eapi/book/${encodeURIComponent(id)}/${encodeURIComponent(hash)}/file`,
    { timeoutMs: TIMEOUT_MS, signal, responseType: 'text', headers: entetes(session), retries: 1 },
  );
  if (!r) throw new ErreurZlibrary(`Z-Library (${domaine()}) est injoignable.`);

  let j: { success?: unknown; message?: string; file?: Record<string, unknown> };
  try { j = JSON.parse(String(r.data)); }
  catch { throw new ErreurZlibrary('Z-Library a rendu une reponse illisible.'); }

  const f = j.file;
  if (Number(j.success) !== 1 || !f) {
    throw new ErreurZlibrary(j.message ? `Z-Library : ${j.message}` : 'Lien de telechargement refuse.');
  }
  const lien = typeof f.downloadLink === 'string' ? f.downloadLink : '';
  if (!lien) {
    if (f.allowDownload === false) {
      throw new ErreurZlibrary('Limite quotidienne Z-Library atteinte. Reessayez apres la remise a zero.');
    }
    throw new ErreurZlibrary('Z-Library n a pas rendu de lien pour ce livre.');
  }
  return { url: lien, extension: typeof f.extension === 'string' ? f.extension.toLowerCase() : undefined };
}
