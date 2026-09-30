// Ouvrir et retenir une session Comics Tracker.
//
// SON AUTHENTIFICATION EST FIREBASE, mesure du 2026-09-16 : le site est une application
// Next.js exportee en statique, et son JavaScript embarque la configuration Firebase du
// projet `comics-tracker-836c8`. La connexion passe donc par l'API standard de Google —
// `accounts:signInWithPassword` — et rend un jeton d'une heure, plus un jeton de
// renouvellement. Les routes protegees du site s'appellent ensuite avec `Authorization:
// Bearer <jeton>` : c'est ce que fait sa propre page, `getIdToken()` puis `fetch`.
//
// LA CLE WEB N'EST PAS UN SECRET. Firebase la publie dans le code de chaque page — c'est un
// identifiant de projet, pas un mot de passe ; ce qui protege un compte, c'est le mot de
// passe de l'utilisateur, et lui seul voyage chiffre. La poser ici en clair est donc exact,
// et l'ecrire dans les reglages laisserait croire l'inverse.
//
// CE QUI NE S'ECRIT JAMAIS : le jeton, le mot de passe, le lien signe. Le journal ne recoit
// que l'hote et le statut.

import { postJson } from '../../core/http';
import { tracerAppel, hoteDe } from '../../core/journal';
import { oublier, retenir, retenue } from '../../auth/sessions-sources';

const CLE_WEB = 'AIzaSyCDnQaQEvtoweE1rwsdb2gBIeDLtClWjbM';
const IDENTITE = 'https://identitytoolkit.googleapis.com/v1';
const JETONS = 'https://securetoken.googleapis.com/v1';

/** On renouvelle AVANT l'echeance : un jeton qui expire pendant la lecture casserait tout. */
const MARGE_MS = 5 * 60 * 1000;

export interface Identifiants { email: string; mdp: string; }
export interface SessionCt { jeton: string; renouvellement: string; expire: number; }

/** Les identifiants utilisables, ou `null`. */
export function identifiantsComicsTracker(
  cles: Record<string, string | undefined>,
): Identifiants | null {
  const email = (cles.ct_email ?? '').trim();
  const mdp = (cles.ct_mdp ?? '').trim();
  return email && mdp ? { email, mdp } : null;
}

/**
 * La session que decrit une reponse de Google, ou `null`.
 *
 * `expiresIn` est rendu en SECONDES, et sous forme de CHAINE — « 3600 ». Le lire comme un
 * nombre de millisecondes ferait expirer la session trois secondes et demie apres son
 * ouverture, et chaque appel se reconnecterait.
 */
export function sessionDeLaReponse(donnees: unknown, maintenant = Date.now()): SessionCt | null {
  const d = donnees as { idToken?: unknown; refreshToken?: unknown; expiresIn?: unknown } | null;
  const jeton = typeof d?.idToken === 'string' ? d.idToken : '';
  const renouvellement = typeof d?.refreshToken === 'string' ? d.refreshToken : '';
  const secondes = Number(d?.expiresIn);
  if (!jeton || !renouvellement) return null;
  const duree = Number.isFinite(secondes) && secondes > 0 ? secondes * 1000 : 3600_000;
  return { jeton, renouvellement, expire: maintenant + duree };
}

/** La meme lecture pour un renouvellement : Google y nomme les champs autrement. */
export function sessionDuRenouvellement(donnees: unknown, maintenant = Date.now()): SessionCt | null {
  const d = donnees as { id_token?: unknown; refresh_token?: unknown; expires_in?: unknown } | null;
  return sessionDeLaReponse({
    idToken: d?.id_token, refreshToken: d?.refresh_token, expiresIn: d?.expires_in,
  }, maintenant);
}

export function jetonUtilisable(session: SessionCt | undefined, maintenant = Date.now()): boolean {
  return Boolean(session && session.expire - MARGE_MS > maintenant);
}

async function appeler(url: string, corps: unknown, signal?: AbortSignal): Promise<unknown | null> {
  const debut = Date.now();
  const r = await postJson<unknown>(url, corps, { timeoutMs: 20000, signal });
  tracerAppel({
    source: 'comics-tracker', hote: hoteDe(url), statut: r ? 200 : null,
    duree: Date.now() - debut, ok: Boolean(r),
  });
  return r ?? null;
}

/** Ouvre une session, ou rend `null` — identifiants refuses, ou service injoignable. */
export async function connecter(ids: Identifiants, signal?: AbortSignal): Promise<SessionCt | null> {
  const donnees = await appeler(
    `${IDENTITE}/accounts:signInWithPassword?key=${CLE_WEB}`,
    { email: ids.email, password: ids.mdp, returnSecureToken: true },
    signal,
  );
  return donnees ? sessionDeLaReponse(donnees) : null;
}

/** Prolonge une session sans redemander le mot de passe. */
export async function renouveler(session: SessionCt, signal?: AbortSignal): Promise<SessionCt | null> {
  const donnees = await appeler(
    `${JETONS}/token?key=${CLE_WEB}`,
    { grant_type: 'refresh_token', refresh_token: session.renouvellement },
    signal,
  );
  return donnees ? sessionDuRenouvellement(donnees) : null;
}

/**
 * Le jeton a presenter, en ouvrant ou en prolongeant la session si besoin.
 *
 * PAR UTILISATEUR : deux personnes n'ont pas le meme compte, ni la meme bibliotheque sur le
 * site. La session vit en memoire — voir `auth/sessions-sources.ts`.
 */
export async function jetonPour(
  userId: number,
  cles: Record<string, string | undefined>,
  signal?: AbortSignal,
): Promise<string | null> {
  const ids = identifiantsComicsTracker(cles);
  if (!ids) return null;

  const connue = retenue<SessionCt>('comics-tracker', userId);
  if (jetonUtilisable(connue)) return connue!.jeton;

  if (connue?.renouvellement) {
    const prolongee = await renouveler(connue, signal);
    if (prolongee) {
      retenir('comics-tracker', userId, prolongee);
      return prolongee.jeton;
    }
  }

  const neuve = await connecter(ids, signal);
  if (!neuve) return null;
  retenir('comics-tracker', userId, neuve);
  return neuve.jeton;
}

/** Le site vient de refuser la session : on l'oublie pour que la suivante se reconnecte. */
export function sessionRefusee(userId: number): void {
  oublier('comics-tracker', userId);
}
