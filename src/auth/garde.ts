// Middlewares de protection.

import type { NextFunction, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import type { Database } from 'better-sqlite3';
import { parId } from '../db/utilisateurs';
import { jetonCsrf, verifierSession } from './sessions';

/**
 * Les cookies sont-ils poses en Secure ?
 *
 * `COOKIE_NON_SECURISE=1` n'existe que pour le developpement en clair sur localhost.
 * En production, derriere cloudflared, la valeur par defaut s'applique.
 */
export function cookiesSecurises(): boolean {
  return process.env.COOKIE_NON_SECURISE !== '1';
}

/**
 * Nom du cookie de session.
 *
 * Le prefixe `__Host-` EXIGE `Secure` : un navigateur — et curl — rejette purement et
 * simplement un cookie `__Host-` pose sans lui. Garder le prefixe en developpement sur
 * HTTP rendait donc la connexion impossible, sans le moindre message d'erreur : le
 * serveur posait le cookie, le client le jetait, et la requete suivante repondait
 * « connexion requise ».
 *
 * On garde donc le prefixe la ou il protege — en production — et on l'abandonne la ou
 * il empeche simplement de travailler.
 */
export function nomCookie(): string {
  return cookiesSecurises() ? '__Host-mangaloo' : 'mangaloo';
}

export const NOM_COOKIE_CSRF = 'mangaloo-csrf';

declare module 'express-serve-static-core' {
  interface Request {
    session?: { id: string; userId: number; dek: Buffer; role: string };
  }
}

export function attacherSession(db: Database) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const jeton = req.cookies?.[nomCookie()];
    const s = jeton ? verifierSession(db, jeton) : null;
    if (s) {
      const u = parId(db, s.userId);
      if (u) req.session = { id: s.id, userId: s.userId, dek: s.dek, role: u.role };
    }
    next();
  };
}

export function exigerConnexion(req: Request, res: Response, next: NextFunction): void {
  if (!req.session) {
    res.status(401).json({ erreur: 'connexion requise' });
    return;
  }
  next();
}

export function exigerAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.session?.role !== 'admin') {
    res.status(403).json({ erreur: 'reserve a l administration' });
    return;
  }
  next();
}

/**
 * CSRF en double-submit.
 *
 * Le cookie porteur du jeton est LISIBLE par le script (pas de HttpOnly) : c'est ce qui
 * permet au navigateur de le recopier dans l'en-tete. Sa valeur ne donne aucun acces —
 * seule sa correspondance avec la session compte.
 */
export function exigerCsrf(req: Request, res: Response, next: NextFunction): void {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  if (!req.session) {
    res.status(401).json({ erreur: 'connexion requise' });
    return;
  }
  // Le jeton est accepte dans l'en-tete OU dans le corps.
  //
  // Le second chemin ne relache rien : la comparaison reste la meme, contre
  // `jetonCsrf(session.id)`. Il existe parce que `navigator.sendBeacon` — seul envoi qui
  // survit a la fermeture d'un onglet, et donc le seul a pouvoir remonter la derniere
  // position de lecture — NE PEUT PAS poser d'en-tete. Sans lui, cet envoi partirait en
  // 403 sans que personne ne le voie, la reponse d'une balise n'etant jamais lue.
  const duCorps =
    req.body && typeof (req.body as { csrf?: unknown }).csrf === 'string'
      ? (req.body as { csrf: string }).csrf
      : '';
  const fourni = req.get('X-CSRF') || duCorps;
  if (fourni !== jetonCsrf(req.session.id)) {
    res.status(403).json({ erreur: 'jeton anti-CSRF absent ou invalide' });
    return;
  }
  next();
}

// Limitation DOUBLE sur la connexion. Par IP seule, on bloquerait l'utilisateur
// legitime depuis n'importe ou ; par compte seul, un attaquant distribue passerait. Le
// verrouillage par compte vit dans `db/utilisateurs.ts` — celui-ci ne couvre que l'IP.
export const limiteurConnexion = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erreur: 'trop de tentatives depuis cette adresse, reessayez plus tard' },
});

// La recherche declenche un fan-out sur quatre trackers : c'est la route qui COUTE.
export const limiteurRecherche = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erreur: 'trop de recherches, laissez souffler les trackers' },
});
