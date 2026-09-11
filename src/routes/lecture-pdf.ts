// Le PDF, servi PAR PLAGES au navigateur.
//
// POURQUOI UNE ROUTE ET NON UN LIEN DIRECT. Le lien du debrideur expire, et le donner au
// navigateur ferait fuir une adresse signee dans son historique. Surtout, `plages.ts` sait
// deja le renouveler quand il meurt en cours de lecture : passer par nous, c'est en
// heriter.
//
// LE RENDU SE FAIT DANS LE NAVIGATEUR. pdf.js y dessine les pages ; le serveur ne fait que
// relayer des octets. Rasteriser ici demanderait une bibliotheque native et de la memoire
// a chaque page — sur une machine qui a gele deux fois pour cette raison.

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import { exigerConnexion, exigerMemeOrigine } from '../auth/garde';
import { tracer } from '../core/journal';
import { plageDemandee, TRANCHE_MAX } from '../lecture/plage-demandee';
import { distantDeLaDemande, estVerdict, resoudreDemande } from './lecture';

export function routesLecturePdf(db: Database): Router {
  const r = Router();

  r.get('/api/pdf/:hash/fichier', exigerConnexion, exigerMemeOrigine, async (req, res) => {
    const d = resoudreDemande(db, req.session!.userId, req.session!.dek, req.params, req.query);
    if (estVerdict(d)) {
      res.status(d.code ?? 400).json({ erreur: d.message });
      return;
    }

    try {
      const distant = await distantDeLaDemande(req.session!.userId, d);
      const plage = plageDemandee(req.headers.range, distant.taille);

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Accept-Ranges', 'bytes');
      // JAMAIS EN CACHE PARTAGE : le fichier vient d'un lien signe, propre a un compte.
      res.setHeader('Cache-Control', 'private, no-store');

      if (plage.partielle) {
        const octets = await distant.lire(plage.debut, plage.fin);
        res.status(206);
        res.setHeader('Content-Range', `bytes ${plage.debut}-${plage.fin}/${distant.taille}`);
        res.setHeader('Content-Length', String(octets.length));
        res.end(octets);
        return;
      }

      // AUCUNE PLAGE DEMANDEE : le client attend le fichier ENTIER, et la taille annoncee
      // doit etre celle du fichier — pdf.js s'en sert pour savoir ou chercher sa table des
      // objets, et une taille fausse lui ferait lire au mauvais endroit.
      //
      // On l'envoie par tranches plutot que d'un bloc : un magazine pese trente
      // megaoctets, et les charger en memoire sur ce serveur est precisement ce qu'il ne
      // faut pas faire. pdf.js, lui, coupe des qu'il a vu `Accept-Ranges` et repasse en
      // plages — le transfert complet n'a donc presque jamais lieu.
      res.setHeader('Content-Length', String(distant.taille));
      let coupe = false;
      res.on('close', () => { coupe = true; });
      for (let pos = 0; pos < distant.taille && !coupe; pos += TRANCHE_MAX) {
        const fin = Math.min(pos + TRANCHE_MAX, distant.taille) - 1;
        const morceau = await distant.lire(pos, fin);
        if (coupe) break;
        // La contre-pression : on attend que le tampon se vide avant de tirer la suite.
        if (!res.write(morceau)) {
          await new Promise<void>((resoudre) => res.once('drain', resoudre));
        }
      }
      res.end();
    } catch (e) {
      tracer('PDF', (e as Error).message);
      res.status(502).json({ erreur: (e as Error).message });
    }
  });

  return r;
}
