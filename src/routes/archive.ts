// Archive assemblee au vol, la ou le debrideur ne sait pas en produire.
//
// TorBox offre la sienne, servie depuis chez eux : elle ne traverse pas cette machine, et
// reste donc prioritaire. AllDebrid n'en a aucune — mesure du 2026-08-20, sa reponse ne
// porte aucun champ d'archive et aucun point d'entree n'existe. C'est pour lui que cette
// route existe.
//
// RIEN N'EST JAMAIS RETENU. Cette machine a 14,6 Go pour trente-deux conteneurs, et
// `earlyoom` tue le plus gros processus des que la RAM libre passe sous 1,1 Go. Une
// archive de 4 Go qui gonflerait un tampon tuerait le serveur — le meme serveur qui s'est
// deja fige deux fois. Chaque morceau est donc tire du debrideur et pousse vers le client
// au meme rythme, avec contre-pression des deux cotes.

import { Router, type Response } from 'express';
import axios from 'axios';
import { once } from 'node:events';
import type { Database } from 'better-sqlite3';
import { exigerConnexion } from '../auth/garde';
import { tracer } from '../core/journal';
import { lienMemorise } from '../core/liens-torrent';
import { service } from '../debrid';
import { crc32 } from '../archive/crc32';
import {
  besoinZip64, descripteur, enteteLocal, entreeCentrale, finDArchive, tailleArchive,
  type FichierArchive,
} from '../archive/zip-ecriture';
import { dispositionFichier, nomDArchive } from '../archive/nom-archive';
import { estVerdict, resoudreDemande } from './lecture';

/** Ecrit en respectant la contre-pression : sans ce `drain`, le tampon enfle sans fin. */
async function pousser(res: Response, octets: Buffer): Promise<void> {
  if (!res.write(octets)) await once(res, 'drain');
}

export function routesArchive(db: Database): Router {
  const r = Router();

  r.get('/api/release/:identite/archive', exigerConnexion, async (req, res) => {
    const s = req.session!;
    const identite = String(req.params.identite);
    try {
      const d = resoudreDemande(db, s.userId, s.dek, { hash: identite }, req.query, {
        fichierRequis: false,
      });
      if (estVerdict(d)) { res.status(d.code ?? 400).json({ erreur: d.message }); return; }
      if (d.nom === 'telegram') {
        res.status(400).json({ erreur: 'une release Telegram porte un seul fichier' });
        return;
      }

      const svc = service(d.nom, d.cle);
      const id = await svc.deposer(d.hash, lienMemorise(s.userId, d.hash));
      if (!id) { res.status(502).json({ erreur: `${d.nom} n a pas pu ouvrir cette release` }); return; }

      const bruts = await svc.listerFichiers(id);
      const utilisables = bruts.filter((f) => f.id !== undefined && (f.taille ?? 0) > 0);
      if (utilisables.length === 0) {
        res.status(404).json({ erreur: 'aucun fichier a archiver dans cette release' });
        return;
      }

      const fichiers: FichierArchive[] = utilisables.map((f) => ({
        nom: f.nom, octets: f.taille as number,
      }));
      // LE MODE SE DECIDE ICI, avant le premier octet, parce qu'on connait toutes les
      // tailles. Pas de bascule en cours de route, donc pas de branche ou se cacherait un
      // defaut qui ne se verrait qu'a l'ouverture.
      const zip64 = besoinZip64(fichiers);

      res.status(200);
      res.setHeader('Content-Type', 'application/zip');
      // LE TITRE ANNONCE PAR LE TRACKER quand le client le transmet, et le dossier
      // racine du torrent en secours. Le premier dit le format et l'annee — « [2026]
      // [mp3 a 128 Kb/s] » — la ou le second les perd.
      res.setHeader('Content-Disposition', dispositionFichier(nomDArchive(
        typeof req.query.nom === 'string' ? req.query.nom : undefined,
        (utilisables[0].nom.split('/')[0] || identite).trim(),
      )));
      // Exacte, donc une vraie barre de progression. C'est ce que le mode « stocke »
      // offre et que la compression interdirait.
      res.setHeader('Content-Length', String(tailleArchive(fichiers, zip64)));
      // L'archive n'existe nulle part : une requete de plage dessus n'aurait aucun sens.
      res.setHeader('Accept-Ranges', 'none');
      res.setHeader('Cache-Control', 'private, no-store');

      let annule = false;
      res.on('close', () => { annule = true; });

      const decalages: number[] = [];
      const crcs: number[] = [];
      let position = 0;

      for (let i = 0; i < fichiers.length; i++) {
        if (annule) return;
        decalages.push(position);
        const entete = enteteLocal(fichiers[i], zip64);
        await pousser(res, entete);
        position += entete.length;

        const lien = await svc.lienFichier(id, utilisables[i].id as string | number);
        if (!lien) throw new Error(`lien indisponible pour ${fichiers[i].nom}`);
        const amont = await axios.get(lien, {
          responseType: 'stream', timeout: 60000, validateStatus: () => true,
        });
        if (amont.status >= 400) throw new Error(`le debrideur a rendu ${amont.status}`);

        let crc = 0;
        let ecrits = 0;
        for await (const morceau of amont.data as AsyncIterable<Buffer>) {
          if (annule) { amont.data.destroy(); return; }
          crc = crc32(morceau, crc);
          ecrits += morceau.length;
          await pousser(res, morceau);
        }
        // LA TAILLE ANNONCEE EST UN ENGAGEMENT. Si le debrideur en rend moins, l'archive
        // est fausse ET le `Content-Length` ment : mieux vaut couper que livrer un
        // fichier corrompu que l'utilisateur decouvrira a l'ouverture.
        if (ecrits !== fichiers[i].octets) {
          throw new Error(
            `${fichiers[i].nom} : ${ecrits} octets recus pour ${fichiers[i].octets} annonces`,
          );
        }
        crcs.push(crc);
        const desc = descripteur(crc, fichiers[i].octets, zip64);
        await pousser(res, desc);
        position += ecrits + desc.length;
      }

      const debutCentral = position;
      let tailleCentrale = 0;
      for (let i = 0; i < fichiers.length; i++) {
        const e = entreeCentrale(fichiers[i], crcs[i], decalages[i], zip64);
        await pousser(res, e);
        tailleCentrale += e.length;
      }
      await pousser(res, finDArchive(fichiers.length, tailleCentrale, debutCentral, zip64));
      res.end();
    } catch (e) {
      const message = e instanceof Error ? e.message : 'archive interrompue';
      tracer('Archive', message);
      // Les en-tetes sont deja partis : on ne peut plus annoncer une erreur proprement.
      // Couper la connexion vaut mieux qu'une archive tronquee qui passerait pour
      // complete — le client verra un telechargement echoue, ce qui est la verite.
      if (res.headersSent) res.destroy();
      else res.status(502).json({ erreur: message });
    }
  });

  return r;
}
