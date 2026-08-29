// Telechargement d'un fichier Telegram, en flux.
//
// POURQUOI CETTE ROUTE EXISTE. Lire un tome de 191 planches tire deja la quasi-totalite
// du fichier a travers la facade, planche par planche. Refuser de rendre les memes octets
// d'un seul coup n'avait aucune justification technique : c'etait une limite heritee du
// monde debrideur — « ne rien declencher chez AllDebrid » — transposee a tort a Telegram,
// ou les octets sont directement accessibles.
//
// EN FLUX, jamais en memoire. Un tome fait couramment 477 Mo ; le tamponner tiendrait
// autant de RAM, sur un conteneur plafonne a 512 Mo. On relaie la reponse de la facade
// telle quelle, et la contre-pression du client remonte jusqu'a Telegram.
//
// Le chemin le MOINS couteux reste le lien `t.me` porte par le candidat : les octets vont
// alors du canal au client sans passer par ce serveur. Cette route existe pour le cas ou
// l'utilisateur n'a pas Telegram sous la main.

import { Router } from 'express';
import axios from 'axios';
import { exigerConnexion } from '../auth/garde';
import { getSettings } from '../core/settings';
import { estIdentiteTelegram, urlFichier, enTetesFacade } from '../sources/telegram/facade';
import { tracer } from '../core/journal';

/**
 * Nom de fichier propre pour l'en-tete `Content-Disposition`.
 *
 * Un nom porte par l'utilisateur atterrit dans un en-tete HTTP : un guillemet ou un saut
 * de ligne y injecterait des directives. On garde donc une liste blanche, et on borne la
 * longueur — certains noms de l'index depassent 150 caracteres.
 */
export function nomTelechargement(brut: string): string {
  const nettoye = String(brut || '')
    .replace(/[\r\n"\\]/g, '')
    .replace(/[^\w .,'()\[\]#+&@-]/g, '_')
    .trim()
    .slice(0, 120);
  return nettoye || 'fichier.cbz';
}

export function routesTelegram(): Router {
  const r = Router();

  r.get('/api/telegram/telechargement/:identite', exigerConnexion, async (req, res) => {
    const identite = String(req.params.identite || '');
    if (!estIdentiteTelegram(identite)) {
      res.status(400).json({ erreur: 'identite telegram invalide' });
      return;
    }
    if (!getSettings().telegram.url) {
      res.status(404).json({ erreur: 'aucune source telegram configuree' });
      return;
    }

    try {
      // On demande TOUT le fichier a la facade, en une plage ouverte : elle refuse un GET
      // sans `Range`, et c'est deliberé — ce refus protege d'un tirage accidentel, pas
      // d'une demande explicite comme celle-ci.
      const amont = await axios.get(urlFichier(identite), {
        headers: { ...enTetesFacade(), Range: String(req.get('Range') || 'bytes=0-') },
        responseType: 'stream',
        timeout: 30000,
        maxRedirects: 0,
        validateStatus: () => true,
      });

      if (amont.status !== 206 && amont.status !== 200) {
        res.status(amont.status === 404 ? 404 : 502)
          .json({ erreur: `la source telegram a repondu ${amont.status}` });
        return;
      }

      const taille = amont.headers['content-length'];
      res.status(206 === amont.status ? 206 : 200);
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Disposition',
        `attachment; filename="${nomTelechargement(String(req.query.nom || ''))}"`);
      if (taille) res.setHeader('Content-Length', String(taille));
      // On relaie `Content-Range` : c'est ce qui rend une reprise possible cote navigateur.
      if (amont.headers['content-range']) {
        res.setHeader('Content-Range', String(amont.headers['content-range']));
      }
      res.setHeader('Accept-Ranges', 'bytes');

      amont.data.pipe(res);
      // Un client qui ferme son onglet doit couper le flux jusqu'a Telegram, pas laisser
      // la facade tirer 477 Mo dans le vide.
      res.on('close', () => amont.data.destroy());
    } catch (e) {
      tracer('Telegram', `telechargement impossible : ${(e as Error).message}`);
      if (!res.headersSent) {
        res.status(502).json({ erreur: 'telechargement impossible' });
      } else {
        res.end();
      }
    }
  });

  return r;
}
