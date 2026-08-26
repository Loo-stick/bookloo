// Ecoute en ligne d'un livre audio.
//
// DEUX ROUTES ET RIEN DE PLUS. Le sommaire depose la release chez le debrideur et rend la
// liste de ses pistes ; le relais sert les octets d'une piste. Tout ce qui se decide sans
// reseau — quels fichiers s'ecoutent, dans quel ordre, sous quel titre, sous quel type
// MIME — vit dans `lecture/audio.ts` et se teste sans serveur.
//
// POURQUOI LES OCTETS PASSENT PAR ICI plutot que du navigateur au debrideur :
//
//   - le lien deverrouille pointe sur un sous-domaine TIRE AU HASARD (mesure :
//     `xp9khl.debrid.it`). L'autoriser dans la CSP demanderait un joker sur tout un
//     domaine tiers, a rallonger pour chaque debrideur ;
//   - il annonce `application/octet-stream` au lieu de `audio/mpeg` ;
//   - et le cout est negligeable : un livre audio a 128 kb/s, c'est SEIZE KILO-OCTETS PAR
//     SECONDE et par auditeur — moins qu'une couverture toutes les dix secondes, et bien
//     moins que la visionneuse qui relaie deja des planches de 1 Mo.
//
// `default-src 'self'` couvre `media-src` par repli : la CSP n'a pas eu a bouger.

import { Router, type Response } from 'express';
import axios from 'axios';
import type { Database } from 'better-sqlite3';
import { exigerConnexion } from '../auth/garde';
import { tracer } from '../core/journal';
import { lienMemorise } from '../core/liens-torrent';
import { service } from '../debrid';
import { raisonNonEcoutable, sommaireAudio, typeMimeAudio } from '../lecture/audio';
import { ecouteMemorisee, poserEcoute, type EcouteOuverte } from '../lecture/pistes-ouvertes';
import { estVerdict, resoudreDemande } from './lecture';

/** Ce que le navigateur recoit : jamais le chemin interne, jamais un lien de debrideur. */
interface PistePublique { n: number; titre: string; octets?: number }

class ErreurEcoute extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

/**
 * Le livre audio ouvert, depuis la memoire ou depuis le debrideur.
 *
 * Le depot et la liste de fichiers coutent deux allers-retours : les refaire a chaque
 * chapitre est exactement la facture que la liseuse EPUB a payee avant d'etre corrigee.
 */
async function ouvrirEcoute(
  db: Database,
  userId: number,
  dek: Buffer,
  identite: string,
  query: Record<string, unknown>,
): Promise<EcouteOuverte> {
  const d = resoudreDemande(db, userId, dek, { hash: identite }, query, { fichierRequis: false });
  if (estVerdict(d)) throw new ErreurEcoute(d.code ?? 400, d.message ?? 'ecoute refusee');
  // Telegram n'a AUCUN fichier audio : zero .mp3, .m4b, .m4a et .flac dans son index,
  // compte le 2026-08-26. Le chemin n'existe donc pas, et le dire vaut mieux que de
  // laisser une resolution echouer plus loin sans raison lisible.
  if (d.nom === 'telegram') {
    throw new ErreurEcoute(400, 'Telegram ne sert pas de livre audio');
  }

  const memo = ecouteMemorisee(userId, identite);
  if (memo && memo.service === d.nom) return memo;

  const svc = service(d.nom, d.cle);
  // ECOUTER N'EST PAS DEPOSER. Aller chercher le .torrent enregistre un telechargement
  // chez le tracker, et son annonceur porte le passkey : le debrideur leeche ensuite au
  // nom de l'utilisateur, obligation de seed comprise.
  const id = (await svc.trouver(d.hash)) || (await svc.deposer(d.hash));
  if (!id) {
    throw new ErreurEcoute(502,
      `${d.nom} n a pas pu ouvrir cette release a partir de son empreinte seule. Utilisez `
      + '« Deposer » si elle n est pas dans son cache.');
  }

  const fichiers = await svc.listerFichiers(id);
  const pistes = sommaireAudio(fichiers);
  if (pistes.length === 0) {
    // Le silence ferait chercher le defaut ailleurs. On nomme le premier fichier refuse
    // et la raison — c'est le cas du M4B, dont les chapitres ne sont pas encore lus ici.
    const raison = fichiers.length ? raisonNonEcoutable(fichiers[0].nom) : null;
    throw new ErreurEcoute(415, raison || 'aucun enregistrement dans cette release');
  }

  const ouverte: EcouteOuverte = {
    idDebrid: id,
    service: d.nom,
    pistes,
    titre: (fichiers[0]?.nom.split('/')[0] || identite).trim(),
  };
  poserEcoute(userId, identite, ouverte);
  return ouverte;
}

function repondreErreur(res: Response, e: unknown): void {
  const code = e instanceof ErreurEcoute ? e.code : 500;
  const message = e instanceof Error ? e.message : 'echec de l ecoute';
  if (code >= 500) tracer('Ecoute', message);
  if (!res.headersSent) res.status(code).json({ erreur: message });
}

export function routesEcoute(db: Database): Router {
  const r = Router();

  r.get('/api/audio/:identite/sommaire', exigerConnexion, async (req, res) => {
    const s = req.session!;
    try {
      const ouverte = await ouvrirEcoute(db, s.userId, s.dek, String(req.params.identite), req.query);
      const chapitres: PistePublique[] = ouverte.pistes.map((p) => ({
        n: p.n, titre: p.titre, octets: p.octets,
      }));
      res.json({ titre: ouverte.titre, chapitres });
    } catch (e) {
      repondreErreur(res, e);
    }
  });

  r.get('/api/audio/:identite/piste/:n', exigerConnexion, async (req, res) => {
    const s = req.session!;
    try {
      const identite = String(req.params.identite);
      const ouverte = await ouvrirEcoute(db, s.userId, s.dek, identite, req.query);
      const n = Number(req.params.n);
      const piste = ouverte.pistes.find((p) => p.n === n);
      if (!piste || piste.id === undefined) throw new ErreurEcoute(404, 'piste inconnue');

      const d = resoudreDemande(db, s.userId, s.dek, { hash: identite }, req.query, {
        fichierRequis: false,
      });
      if (estVerdict(d) || d.nom === 'telegram') throw new ErreurEcoute(400, 'ecoute refusee');
      const lien = await service(d.nom, d.cle).lienFichier(ouverte.idDebrid, piste.id);
      if (!lien) throw new ErreurEcoute(502, 'lien de piste indisponible');

      // LA PLAGE DU NAVIGATEUR EST TRANSMISE TELLE QUELLE. Sans elle, `<audio>` ne peut
      // pas se deplacer dans la piste : il redemanderait le fichier entier a chaque
      // saut, et la reprise a 40 % couterait quarante pour cent d'un chapitre.
      const plage = req.headers.range;
      const amont = await axios.get(lien, {
        responseType: 'stream',
        headers: plage ? { Range: plage } : {},
        timeout: 30000,
        validateStatus: () => true,
      });
      if (amont.status >= 400) throw new ErreurEcoute(502, `le debrideur a rendu ${amont.status}`);

      res.status(amont.status === 206 ? 206 : 200);
      // Le type vient de l'EXTENSION, jamais de l'amont, qui annonce
      // « application/octet-stream ».
      res.setHeader('Content-Type', typeMimeAudio(piste.nom));
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'private, no-store');
      for (const entete of ['content-length', 'content-range']) {
        const v = amont.headers[entete];
        if (v) res.setHeader(entete, String(v));
      }
      // L'auditeur ferme l'onglet ou saute un chapitre : inutile de continuer a tirer
      // des octets du debrideur.
      res.on('close', () => amont.data.destroy());
      amont.data.pipe(res);
    } catch (e) {
      repondreErreur(res, e);
    }
  });

  return r;
}
