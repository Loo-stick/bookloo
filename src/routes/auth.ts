// Connexion et deconnexion.

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import { deriverKek, developper, verifierMotDePasse } from '../auth/crypto';
import { fermerSession, jetonCsrf, ouvrirSession } from '../auth/sessions';
import { NOM_COOKIE_CSRF, cookiesSecurises, limiteurConnexion, nomCookie } from '../auth/garde';
import { enregistrerEchec, estVerrouille, parLogin, reinitialiserEchecs } from '../db/utilisateurs';
import { tracer } from '../core/journal';

/**
 * Message unique en cas d'echec.
 *
 * Distinguer « login inconnu » de « mot de passe faux » transforme la page de connexion
 * en annuaire des comptes existants.
 */
const REFUS = { erreur: 'identifiant ou mot de passe incorrect' };

/** Attente plancher, identique quel que soit le motif du refus. */
function attendreUnPeu(): Promise<void> {
  return new Promise((r) => setTimeout(r, 300));
}

export function routesAuth(db: Database): Router {
  const r = Router();

  r.post('/api/login', limiteurConnexion, async (req, res) => {
    const login = String(req.body?.login ?? '').trim();
    const mdp = String(req.body?.motDePasse ?? '');
    if (!login || !mdp) {
      await attendreUnPeu();
      res.status(401).json(REFUS);
      return;
    }

    const u = parLogin(db, login);
    if (!u) {
      // On hache quand meme dans le vide ? Non : le cout serait offert a l'attaquant.
      // L'attente plancher suffit a masquer la difference de duree.
      await attendreUnPeu();
      res.status(401).json(REFUS);
      return;
    }

    if (estVerrouille(u)) {
      const minutes = Math.ceil((u.verrouille_jusqua - Date.now()) / 60000);
      res.status(429).json({ erreur: `compte verrouille, reessayez dans ${minutes} min` });
      return;
    }

    const bon = await verifierMotDePasse(mdp, u.hash);
    if (!bon) {
      enregistrerEchec(db, login);
      await attendreUnPeu();
      res.status(401).json(REFUS);
      return;
    }

    // La KEK se derive ici, une seule fois, et ne quitte jamais la memoire.
    const kek = await deriverKek(mdp, u.sel_kek);
    const dek = developper(u.dek_chiffre, u.dek_nonce, kek);
    if (!dek) {
      // Le mot de passe est bon mais la DEK ne s'ouvre pas : la base a ete modifiee
      // hors de Mangaloo. Le dire franchement vaut mieux qu'un refus incomprehensible.
      tracer('Auth', `DEK illisible pour ${login} : base incoherente`);
      res.status(500).json({ erreur: 'les secrets de ce compte sont illisibles' });
      return;
    }

    const secure = cookiesSecurises();
    // LE COOKIE QU'ON S'APPRETE A POSER SERA-T-IL SEULEMENT ACCEPTE ?
    //
    // Un cookie `Secure` — et a plus forte raison prefixe `__Host-` — est REJETE sans
    // bruit par le navigateur quand la page n'est pas en HTTPS. L'authentification
    // reussissait donc, le serveur repondait 200, et l'utilisateur se retrouvait sur la
    // page de connexion sans le moindre message. Constate en deployant l'image publiee
    // sur une machine vierge, exactement comme le fera quelqu'un qui s'auto-heberge.
    //
    // On le detecte AVANT d'ouvrir une session, pour ne pas en laisser trainer une que
    // personne ne pourra jamais utiliser.
    const enHttps = req.secure || req.get('x-forwarded-proto') === 'https';
    if (secure && !enHttps) {
      res.status(400).json({
        erreur: 'Connexion impossible en HTTP simple : le cookie de session exige HTTPS et '
          + 'le navigateur le rejetterait sans rien dire. Placez un reverse proxy HTTPS '
          + 'devant l application — ou, pour un essai local uniquement, demarrez-la avec '
          + 'COOKIE_NON_SECURISE=1.',
      });
      return;
    }

    reinitialiserEchecs(db, u.id);
    const session = ouvrirSession(db, u.id, dek, req.ip ?? '', req.get('user-agent') ?? '');

    res.cookie(nomCookie(), session.jeton, {
      httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: session.expireLe - Date.now(),
    });
    // Volontairement LISIBLE par le script : le navigateur doit pouvoir le recopier
    // dans l'en-tete X-CSRF. Sa valeur seule n'ouvre rien.
    res.cookie(NOM_COOKIE_CSRF, jetonCsrf(session.id), {
      httpOnly: false, secure, sameSite: 'lax', path: '/', maxAge: session.expireLe - Date.now(),
    });
    res.json({ ok: true, login: u.login, role: u.role });
  });

  r.post('/api/logout', (req, res) => {
    if (req.session) fermerSession(db, req.session.id);
    res.clearCookie(nomCookie(), { path: '/' });
    res.clearCookie(NOM_COOKIE_CSRF, { path: '/' });
    res.json({ ok: true });
  });

  r.get('/api/moi', (req, res) => {
    if (!req.session) {
      res.status(401).json({ erreur: 'connexion requise' });
      return;
    }
    // `ip` sert au diagnostic derriere le proxy : si elle vaut 127.0.0.1 en
    // production, `trust proxy` est mal regle et la limitation par IP est inoperante.
    res.json({ userId: req.session.userId, role: req.session.role, ip: req.ip });
  });

  return r;
}
