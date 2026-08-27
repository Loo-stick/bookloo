// Telechargement Z-Library.
//
// LE LIEN N'A PAS BESOIN DE COOKIE, ET CA CHANGE TOUT. Mesure du 2026-08-24 : l'URL
// rendue par `/eapi/book/{id}/{hash}/file` repond 200 avec le fichier complet SANS aucun
// en-tete de session. C'est une adresse pre-signee — ses parametres sont `filename`,
// `countryCode`, `md5` et `expires`.
//
// On redirige donc, au lieu de relayer. Les octets vont du CDN au navigateur SANS passer
// par ce serveur : c'est le trajet le plus rapide, celui qui ne consomme ni RAM ni bande
// passante ici, et le seul qui rende le fichier intact.
//
// LA REDIRECTION EST SURE, ET CE N'EST PAS UNE SUPPOSITION. La regle « apislow » du
// projet existe parce qu'une cle AllDebrid avait fuite dans un en-tete `Location`. Ici
// l'adresse ne porte AUCUN identifiant : ni e-mail, ni mot de passe, ni cle de session —
// seulement un `md5` de fichier et une echeance. Elle a ete lue avant d'etre relayee.

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import { clesEnClair, identifiantsZlibrary } from '../auth/cles-utilisateur';
import { exigerConnexion } from '../auth/garde';
import { ErreurZlibrary, connecter, lienFichier, type Session } from '../sources/zlibrary/api';
import { tracer } from '../core/journal';

/** L'identite d'un resultat Z-Library : `zl:<id>:<hash>`. PURE. */
export function lireIdentiteZl(identite: string): { id: string; hash: string } | null {
  const m = /^zl:([0-9]+):([0-9a-z]+)$/i.exec(identite || '');
  return m ? { id: m[1], hash: m[2] } : null;
}

/**
 * Sessions Z-Library, PAR UTILISATEUR et EN MEMOIRE SEULEMENT.
 *
 * Pas en base : ce serait un second secret a proteger, avec sa propre duree de vie, alors
 * qu'une reconnexion coute un aller-retour. Le cache evite simplement de se reconnecter a
 * chaque telechargement.
 */
const sessions = new Map<number, Session>();

export async function sessionZlibraryDe(
  db: Database, userId: number, dek: Buffer,
): Promise<Session> {
  const connue = sessions.get(userId);
  if (connue) return connue;

  const ids = identifiantsZlibrary(clesEnClair(db, userId, dek));
  if (!ids) {
    throw new ErreurZlibrary(
      'Renseignez vos identifiants Z-Library dans « Compte » pour telecharger.',
    );
  }
  const s = await connecter(ids.email, ids.motdepasse);
  sessions.set(userId, s);
  return s;
}

/** Oublie la session d'un utilisateur : appelee quand le serveur la refuse. */
export function oublierSession(userId: number): void {
  sessions.delete(userId);
}

export function routesZlibrary(db: Database): Router {
  const r = Router();

  r.get('/api/zlibrary/telechargement/:identite', exigerConnexion, async (req, res) => {
    const ident = lireIdentiteZl(String(req.params.identite));
    if (!ident) { res.status(400).json({ erreur: 'identite Z-Library invalide' }); return; }

    const userId = req.session!.userId;
    try {
      let session = await sessionZlibraryDe(db, userId, req.session!.dek);
      let lien;
      try {
        lien = await lienFichier(session, ident.id, ident.hash);
      } catch (e) {
        // Une session memorisee peut avoir expire cote Z-Library. On la jette et on
        // reessaie UNE fois : echouer sur un jeton perime serait absurde alors que les
        // identifiants sont toujours valides.
        if (!(e instanceof ErreurZlibrary)) throw e;
        oublierSession(userId);
        session = await sessionZlibraryDe(db, userId, req.session!.dek);
        lien = await lienFichier(session, ident.id, ident.hash);
      }
      res.redirect(302, lien.url);
    } catch (e) {
      if (e instanceof ErreurZlibrary) {
        // Ce message est deja formule pour l'utilisateur, et distingue le quota epuise
        // d'un refus d'identifiants. Il ne porte ni adresse ni mot de passe.
        res.status(502).json({ erreur: e.message });
        return;
      }
      tracer('Zlibrary', `telechargement : echec (${(e as Error).name})`);
      res.status(502).json({ erreur: 'Z-Library n a pas repondu.' });
    }
  });

  return r;
}
