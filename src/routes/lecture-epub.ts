// Lecture d'un EPUB en ligne.
//
// Le livre est rapatrie ENTIER, une fois, puis lu depuis le disque. Ce n'est pas un choix
// de confort : le CDN de Z-Library refuse les plages d'octets arbitraires, et obtenir un
// lien de telechargement consomme une unite du quota quotidien de l'utilisateur.
//
// Une fois le fichier local, le `LecteurPlage` du projet le sert sans rien savoir de son
// origine : `lireEntrees` et `lireEntree` fonctionnent tels quels.

import { Router } from 'express';
import fs from 'node:fs';
import type { Database } from 'better-sqlite3';
import { exigerConnexion } from '../auth/garde';
import { httpGet } from '../core/http';
import { tracer } from '../core/journal';
import { lireEntree, lireEntrees, type EntreeZip, type LecteurPlage } from '../lecture/zip';
import {
  cheminOpf, dossierDe, lireOpf, nettoyerChapitre, titreDeChapitre, type LivreEpub,
} from '../lecture/epub';
import { MAX_LIVRE_OCTETS, deposer, enCache } from '../lecture/epub-cache';
import { livreMemorise, poserLivre, type LivreOuvert } from '../lecture/livres-ouverts';
import { ErreurZlibrary, lienFichier } from '../sources/zlibrary/api';
import { lireIdentiteZl, sessionZlibraryDe } from './zlibrary';
import { enTetesFacade, estIdentiteTelegram, urlFichier } from '../sources/telegram/facade';
import { ouvrirDistant } from '../lecture/plages';
import { estVerdict, ouvrirDistantDebrid, resoudreDemande } from './lecture';

/** Types servis tels quels. Tout autre contenu de l'archive est refuse. */
const IMAGES = /\.(?:png|jpe?g|gif|webp|avif|svg)$/i;

/**
 * Ouvre le livre, quelle que soit sa provenance.
 *
 * DEUX CHEMINS, PARCE QUE LES DEUX SOURCES NE SE COMPORTENT PAS PAREIL.
 *
 * Telegram accepte les plages d'octets — c'est deja ce qui permet a la visionneuse de
 * lire un CBZ de 500 Mo sans rien rapatrier. Un EPUB s'y lit donc a distance, entree par
 * entree : rien ne touche le disque, et un livre de 200 Mo ne coute pas plus qu'un livre
 * de 1 Mo.
 *
 * Z-Library non : son CDN rend 416 sur toute plage qui n'est pas un suffixe (mesure du
 * 2026-08-24, reproduite sur deux liens). Il faut donc le fichier entier, et le garder —
 * redemander un lien consomme une unite du quota quotidien.
 */
async function ouvrir(
  db: Database, userId: number, dek: Buffer, identite: string,
  query: Record<string, unknown> = {},
): Promise<{ lire: LecteurPlage; taille: number }> {
  // TROISIEME CHEMIN : une release de tracker, obtenue par un debrideur.
  //
  // Sans lui, un EPUB trouve sur un tracker partait dans la VISIONNEUSE, qui le traitait
  // comme un CBZ : elle y trouvait la couverture et une illustration, et annoncait « 2
  // planches » pour un roman de quatre cents pages. Constate a l'usage sur « Stephen King
  // - Holly (2024) Epub ».
  //
  // Le lien debride accepte les plages : rien n'est rapatrie ici non plus.
  if (!estIdentiteTelegram(identite) && !identite.startsWith('zl:')) {
    const d = resoudreDemande(db, userId, dek, { hash: identite }, query);
    if (estVerdict(d)) throw new ErreurZlibrary(d.message ?? 'lecture refusee');
    if (d.nom === 'telegram') throw new ErreurZlibrary('identite de livre invalide');
    const distant = await ouvrirDistantDebrid(userId, d);
    return { lire: distant.lire, taille: distant.taille };
  }

  if (estIdentiteTelegram(identite)) {
    const distant = await ouvrirDistant({
      resoudre: async () => urlFichier(identite),
      enTetes: enTetesFacade(),
    });
    return { lire: distant.lire, taille: distant.taille };
  }

  let chemin = enCache(identite);
  if (!chemin) {
    const ident = lireIdentiteZl(identite);
    if (!ident) throw new ErreurZlibrary('identite de livre invalide');
    const session = await sessionZlibraryDe(db, userId, dek);
    const lien = await lienFichier(session, ident.id, ident.hash);

    const r = await httpGet<Buffer>(lien.url, {
      responseType: 'buffer', timeoutMs: 60_000, retries: 1, maxBytes: MAX_LIVRE_OCTETS,
    });
    const octets = r?.data as Buffer | undefined;
    if (!r || r.status !== 200 || !octets?.length) {
      throw new ErreurZlibrary('Le livre n a pas pu etre telecharge.');
    }
    if (octets.length > MAX_LIVRE_OCTETS) {
      throw new ErreurZlibrary(
        `Ce fichier fait ${Math.round(octets.length / 1e6)} Mo : trop lourd pour la lecture `
        + 'en ligne. Telechargez-le.');
    }
    chemin = deposer(identite, octets);
  }

  // Le fichier est petit — l'EPUB median pese 1,4 Mo — et il sera relu chapitre par
  // chapitre : le garder en memoire le temps de la requete evite autant d'ouvertures.
  const octets = fs.readFileSync(chemin);
  return { lire: async (d, f) => octets.subarray(d, f + 1), taille: octets.length };
}

/**
 * Le livre ouvert, MEMORISE.
 *
 * Sans cette memoire, chaque chapitre refaisait tout : ouvrir le fichier distant, lister
 * les entrees du ZIP, relire container.xml puis l'OPF. Mesure du 2026-08-25 sur un EPUB
 * Telegram — 1 100 ms de travail deja fait pour 220 ms de chapitre reellement lu. Sur une
 * release debridee, « ouvrir » enchaine en plus trois allers-retours a AllDebrid.
 */
async function ouvrirLivre(
  db: Database, userId: number, dek: Buffer, identite: string,
  query: Record<string, unknown>,
): Promise<LivreOuvert> {
  const connu = livreMemorise(userId, identite);
  if (connu) return connu;

  const { lire, taille } = await ouvrir(db, userId, dek, identite, query);
  const { livre, entrees } = await lireLivre(lire, taille);
  const ouvert: LivreOuvert = { distant: { lire, taille }, entrees, livre };
  poserLivre(userId, identite, ouvert);
  return ouvert;
}

/** Le livre et ses entrees, lus depuis l'archive. */
async function lireLivre(lire: LecteurPlage, taille: number): Promise<{
  livre: LivreEpub; entrees: EntreeZip[];
}> {
  const entrees = await lireEntrees(lire, taille);
  const par = (n: string) => entrees.find((e) => e.nom === n);

  const container = par('META-INF/container.xml');
  if (!container) throw new ErreurZlibrary('Ce fichier n est pas un EPUB.');
  const chemin = cheminOpf((await lireEntree(lire, container)).toString('utf-8'));
  const opf = chemin ? par(chemin) : undefined;
  if (!chemin || !opf) throw new ErreurZlibrary('Ce livre n a pas de manifeste lisible.');

  const livre = lireOpf((await lireEntree(lire, opf)).toString('utf-8'), dossierDe(chemin));
  if (!livre || livre.chapitres.length === 0) {
    throw new ErreurZlibrary('Ce livre ne declare aucun chapitre.');
  }
  return { livre, entrees };
}

function repondreErreur(res: import('express').Response, e: unknown): void {
  if (e instanceof ErreurZlibrary) { res.status(502).json({ erreur: e.message }); return; }
  tracer('Epub', `lecture : echec (${(e as Error).name})`);
  res.status(502).json({ erreur: 'Ce livre n a pas pu etre ouvert.' });
}

export function routesLectureEpub(db: Database): Router {
  const r = Router();

  r.get('/api/epub/:identite/sommaire', exigerConnexion, async (req, res) => {
    try {
      const ouvert = await ouvrirLivre(db, req.session!.userId, req.session!.dek,
        String(req.params.identite), req.query as Record<string, unknown>);
      const { livre, entrees, distant } = ouvert;

      // Le titre de chaque chapitre demande de lire son entete : 105 lectures pour « Sac
      // d'os ». On ne le paie qu'UNE fois par livre — c'est le calcul le plus cher de
      // toute la liseuse.
      if (!ouvert.titres) {
        const titres: string[] = [];
        for (const [i, c] of livre.chapitres.entries()) {
          const e = entrees.find((x) => x.nom === c.chemin);
          let titre: string | null = null;
          if (e) {
            try { titre = titreDeChapitre((await lireEntree(distant.lire, e)).toString('utf-8')); }
            catch { titre = null; }
          }
          titres.push(titre ?? `Chapitre ${i + 1}`);
        }
        ouvert.titres = titres;
      }
      res.json({
        titre: livre.titre, auteur: livre.auteur,
        chapitres: ouvert.titres.map((titre, index) => ({ index, titre })),
      });
    } catch (e) { repondreErreur(res, e); }
  });

  r.get('/api/epub/:identite/chapitre/:n', exigerConnexion, async (req, res) => {
    const identite = String(req.params.identite);
    const n = Number(req.params.n);
    if (!Number.isInteger(n) || n < 0) {
      res.status(400).json({ erreur: 'numero de chapitre invalide' });
      return;
    }
    try {
      const { livre, entrees, distant } = await ouvrirLivre(db, req.session!.userId,
        req.session!.dek, identite, req.query as Record<string, unknown>);
      const c = livre.chapitres[n];
      if (!c) { res.status(404).json({ erreur: `ce livre n a pas de chapitre ${n + 1}` }); return; }
      const e = entrees.find((x) => x.nom === c.chemin);
      if (!e) { res.status(404).json({ erreur: 'chapitre absent de l archive' }); return; }

      const brut = (await lireEntree(distant.lire, e)).toString('utf-8');
      // Les adresses d'images sont relatives AU CHAPITRE : c'est son dossier qui sert de
      // base, pas celui de l'OPF.
      const base = dossierDe(c.chemin);
      const html = nettoyerChapitre(brut, (src) => {
        const cible = src.startsWith('/') ? src.slice(1) : `${base}/${src}`;
        return `/api/epub/${encodeURIComponent(identite)}/ressource`
          + `?f=${encodeURIComponent(cible)}`;
      });
      res.json({ index: n, total: livre.chapitres.length, html });
    } catch (e) { repondreErreur(res, e); }
  });

  r.get('/api/epub/:identite/ressource', exigerConnexion, async (req, res) => {
    const demande = String(req.query.f ?? '');
    // SEULEMENT DES IMAGES. L'archive contient aussi du XHTML et des feuilles de style :
    // les servir depuis cette route contournerait le nettoyage.
    if (!IMAGES.test(demande)) { res.status(400).json({ erreur: 'ressource refusee' }); return; }
    try {
      const { entrees, distant } = await ouvrirLivre(db, req.session!.userId,
        req.session!.dek, String(req.params.identite), req.query as Record<string, unknown>);
      // Comparaison EXACTE avec une entree de l'archive : aucun chemin ne peut donc
      // designer autre chose que ce que le livre contient, « .. » compris.
      const e = entrees.find((x) => x.nom === demande);
      if (!e) { res.status(404).json({ erreur: 'ressource introuvable' }); return; }
      const octets = await lireEntree(distant.lire, e);
      res.setHeader('Content-Type', typeImage(demande));
      res.setHeader('Cache-Control', 'private, max-age=86400');
      res.send(octets);
    } catch (e) { repondreErreur(res, e); }
  });

  return r;
}

function typeImage(nom: string): string {
  const ext = (nom.split('.').pop() ?? '').toLowerCase();
  const table: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', avif: 'image/avif', svg: 'image/svg+xml',
  };
  return table[ext] ?? 'application/octet-stream';
}
