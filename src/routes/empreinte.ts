// Calcul d'une empreinte a LA DEMANDE.
//
// POURQUOI CETTE ROUTE EXISTE. Gemini ne publie ni `info_hash` ni `magnet_link` —
// verifie le 2026-08-25 par recherche exhaustive dans la reponse : aucune chaine de
// quarante hexadecimaux, a aucune profondeur, et `magnet_link` vaut `null` sur tous les
// resultats. Le seul chemin vers l'empreinte est de telecharger le `.torrent` et de le
// decoder.
//
// POURQUOI A LA DEMANDE, ET PAS EN MASSE. Deux mesures du 2026-08-25 :
//
//   - Telecharger un `.torrent` ne coute RIEN sur le tracker. Compteurs releves avant et
//     apres : uploaded, downloaded, ratio, buffer, hit_and_runs — aucun ne bouge. Ce sont
//     les octets annonces par un client BitTorrent qui comptent, pas 10 Ko de
//     metadonnees.
//   - Mais le tracker LIMITE LE DEBIT, et durement. En sequentiel, huit pieces passent en
//     3,5 s. En lots de quatre, 22 sur 40 seulement. En lots de six ou dix, ZERO sur 40.
//
// Paralleliser etait donc la mauvaise idee : c'est exactement ce que le tracker punit.
// Une release a la fois, quand l'utilisateur la demande, ne declenche rien et ne coute
// rien au budget de la recherche.

import { Router } from 'express';
import { httpGet } from '../core/http';
import { exigerConnexion, exigerCsrf, limiteurRecherche } from '../auth/garde';
import { infoHashDepuisTorrent } from '../core/bencode';
import { lienMemorise, memoriserLien } from '../core/liens-torrent';
import { tracer } from '../core/journal';

/** Taille au-dela de laquelle ce n'est plus un `.torrent`. */
const MAX_OCTETS = 4 * 1024 * 1024;

export function routesEmpreinte(): Router {
  const r = Router();

  r.post('/api/empreinte', exigerConnexion, exigerCsrf, limiteurRecherche, async (req, res) => {
    const identite = String((req.body as { identite?: unknown })?.identite ?? '').trim();
    if (!identite) { res.status(400).json({ erreur: 'identite absente' }); return; }

    // L'URL vient de la MEMOIRE DU SERVEUR, jamais du client : elle porte le jeton de
    // telechargement de l'utilisateur, et n'a jamais quitte cette machine.
    const url = lienMemorise(req.session!.userId, identite);
    if (!url) {
      res.status(404).json({ erreur: 'release inconnue : relancez la recherche' });
      return;
    }

    try {
      const rep = await httpGet<ArrayBuffer>(url, {
        responseType: 'buffer', timeoutMs: 15000, retries: 1, maxBytes: MAX_OCTETS,
      });
      if (!rep || rep.status !== 200) {
        // 429 : le tracker limite le debit. Le DIRE, plutot que « empreinte
        // indisponible » — le geste a refaire n'est pas le meme.
        const message = rep?.status === 429
          ? 'Le tracker limite le debit. Reessayez dans une minute.'
          : 'Le tracker n a pas rendu le fichier .torrent.';
        res.status(502).json({ erreur: message });
        return;
      }
      const hash = infoHashDepuisTorrent(Buffer.from(rep.data as ArrayBuffer));
      if (!hash) { res.status(502).json({ erreur: 'ce fichier n est pas un .torrent lisible' }); return; }

      // Le lien est reindexe SOUS LE HASH : tout le reste du pipeline — verification de
      // cache, depot, lecture — le cherche sous cette cle et non sous l'identite.
      memoriserLien(req.session!.userId, hash, url);
      res.json({ hash });
    } catch (e) {
      tracer('Empreinte', `echec (${(e as Error).name})`);
      res.status(502).json({ erreur: 'l empreinte n a pas pu etre calculee' });
    }
  });

  return r;
}
