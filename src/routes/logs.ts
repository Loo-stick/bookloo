// Le journal des traces, pour l'administration.
//
// Il montre l'activite de TOUS les comptes : il n'appartient pas a un utilisateur
// ordinaire, d'ou `exigerAdmin` en plus de la connexion.

import { Router } from 'express';
import { exigerAdmin, exigerConnexion } from '../auth/garde';
import { depuis } from '../core/anneau';

/**
 * Le `seq` demande par le client, ou zero.
 *
 * Un parametre absent, repete ou aberrant vaut zero : un journal qui tombe sur une entree
 * douteuse serait inutilisable au moment precis ou l'on en a le plus besoin.
 */
export function seqDemande(brut: unknown): number {
  if (typeof brut !== 'string') return 0;
  const n = Number(brut);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

export function routesLogs(): Router {
  const r = Router();
  r.get('/api/logs', exigerConnexion, exigerAdmin, (req, res) => {
    res.json(depuis(seqDemande(req.query.depuis)));
  });
  return r;
}
