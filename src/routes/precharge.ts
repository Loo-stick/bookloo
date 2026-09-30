// Le prechargement d'un fichier LibGen : le lancer, et en suivre l'avancee.
//
// Deux routes, parce que les deux gestes n'ont pas le meme poids. LANCER ecrit sur le disque
// et sollicite un tiers : POST et jeton CSRF, comme toute action. SUIVRE ne fait que lire un
// etat en memoire : GET, meme origine. Aucune adresse de telechargement ne sort d'ici — le
// navigateur voit un pourcentage, jamais le lien du CDN.

import { Router } from 'express';
import { exigerConnexion, exigerCsrf, exigerMemeOrigine } from '../auth/garde';
import { estIdentiteLibgen, md5Libgen } from '../sources/ddl/libgen-liste';
import { prechargesLibgen, sourcePrechargeLibgen } from '../sources/ddl/libgen';

export function routesPrecharge(): Router {
  const r = Router();

  r.post('/api/libgen/precharge', exigerConnexion, exigerCsrf, (req, res) => {
    const identite = String((req.body as Record<string, unknown> | undefined)?.identite ?? '');
    if (!estIdentiteLibgen(identite)) {
      res.status(400).json({ erreur: 'identite LibGen invalide' });
      return;
    }
    const md5 = md5Libgen(identite);
    res.json(prechargesLibgen().lancer(sourcePrechargeLibgen(md5)));
  });

  r.get('/api/libgen/precharge', exigerConnexion, exigerMemeOrigine, (req, res) => {
    const identite = String(req.query.identite ?? '');
    if (!estIdentiteLibgen(identite)) {
      res.status(400).json({ erreur: 'identite LibGen invalide' });
      return;
    }
    res.json(prechargesLibgen().etat(md5Libgen(identite)));
  });

  return r;
}
