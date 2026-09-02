// Ouvrir et retenir une session zone-ebook.
//
// SA RECHERCHE N'EXISTE QUE POUR LES MEMBRES. Mesure du 2026-09-02, sur le vrai site avec
// un vrai compte : anonyme, `?s=` rend l'accueil a 57 octets pres, et les formes DataLife
// Engine rendent deux fiches de l'encadre lateral. Connecte, trois requetes rendent trois
// jeux de resultats DIFFERENTS et pertinents. C'est ce test-la — deux questions, deux
// reponses differentes — qui fait foi, et non « une page est arrivee ».

import { postFormAvecCookies, enteteCookie } from '../core/http';
import { retenir, retenue, oublier } from '../auth/sessions-sources';

const BASE = 'https://zone-ebook.com';

export interface Identifiants { login: string; mdp: string; }

/**
 * Les identifiants utilisables, ou `null`.
 *
 * LE PSEUDO, JAMAIS L'ADRESSE. Mesure du meme jour : la connexion par adresse ne fait
 * poser que `PHPSESSID`, celle par pseudo pose `dle_user_id`. Le champ de l'ecran demande
 * donc un pseudo, et ce module n'accepte rien d'autre.
 */
export function identifiantsZoneEbook(
  cles: Record<string, string | undefined>,
): Identifiants | null {
  const login = (cles.zone_login ?? '').trim();
  const mdp = (cles.zone_mdp ?? '').trim();
  return login && mdp ? { login, mdp } : null;
}

/**
 * Cette reponse de connexion a-t-elle ouvert une session ?
 *
 * ON LIT LES COOKIES, PAS LE CORPS. Une connexion reussie rend une page ordinaire, sans
 * lien de deconnexion : mon premier test cherchait `do=logout` dans le corps et concluait
 * a l'echec alors que la session etait ouverte.
 */
export function sessionOuverte(cookies: Record<string, string>): boolean {
  return Boolean(cookies.dle_user_id && cookies.dle_password);
}

/** Ouvre une session, ou rend `null` — identifiants refuses, ou site injoignable. */
export async function connecter(
  ids: Identifiants,
  signal?: AbortSignal,
): Promise<Record<string, string> | null> {
  const r = await postFormAvecCookies(`${BASE}/`, {
    login_name: ids.login,
    login_password: ids.mdp,
    login: 'submit',
    login_not_save: '0',
  }, { timeoutMs: 20000, signal });
  if (!r) return null;
  return sessionOuverte(r.cookies) ? r.cookies : null;
}

/**
 * L'en-tete `Cookie` a presenter, en ouvrant une session si besoin.
 *
 * La session est retenue PAR UTILISATEUR : deux personnes n'ont ni le meme compte ni le
 * meme quota. Une reconnexion ne coute qu'un aller-retour, mais la refaire a chaque
 * recherche doublerait le temps de reponse du kiosque.
 */
export async function cookiePour(
  userId: number,
  cles: Record<string, string | undefined>,
  signal?: AbortSignal,
): Promise<string | null> {
  const ids = identifiantsZoneEbook(cles);
  if (!ids) return null;

  const connue = retenue<Record<string, string>>('zone-ebook', userId);
  if (connue) return enteteCookie(connue);

  const cookies = await connecter(ids, signal);
  if (!cookies) return null;
  retenir('zone-ebook', userId, cookies);
  return enteteCookie(cookies);
}

/** La session vient d'etre refusee : on l'oublie pour que la suivante se reconnecte. */
export function sessionRefusee(userId: number): void {
  oublier('zone-ebook', userId);
}
