// Routes de la bibliotheque.
//
// Minces a dessein. Ce depot n'a pas de supertest : la logique testable est donc extraite
// en fonctions pures — ici `corpsProgressionValide` — et les routes se contentent de les
// appeler. C'est le pattern deja en place dans `releases.ts` et `compte.ts`.

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import { exigerConnexion, exigerCsrf } from '../auth/garde';
import { clesEnClair } from '../auth/cles-utilisateur';
import { etatCacheMemorise } from '../core/liens-torrent';
import { service } from '../debrid';
import { analyser } from '../sources/torrent/structure';
import type { FichierDebride } from '../debrid/types';
import { identiteOeuvre } from '../bibliotheque/identites';
import {
  suivre, oublier, changerRaccourci, enregistrerPosition, lireBibliotheque, memoriserTomes,
} from '../bibliotheque/depot';

export interface CorpsProgression {
  /** Vide quand le client ne connait pas encore l'identite : la route la formera. */
  oeuvre: string;
  mangadexId?: string;
  tome: string;
  planche: number;
  planches: number;
  /** Portent l'entree automatique dans la bibliotheque. Facultatifs. */
  titre?: string;
  couverture?: string;
  /**
   * Tomes que porte la release qu'on est en train de lire.
   *
   * Sans eux, lire le tome 5 d'une integrale de dix-huit faisait entrer l'oeuvre dans la
   * bibliotheque avec UN SEUL tome connu — les dix-sept autres restaient invisibles, et
   * l'etagere annoncait « Tous les tomes (1) ». La liste est deja sous la main de
   * l'appelant a ce moment-la : il n'y a aucune raison de la lui redemander plus tard.
   */
  tomes?: string[];
  /** Position DANS la planche, en pourcentage. Renseignee pour un livre seulement. */
  pourcent?: number;
}

/**
 * Valide ce qui arrive sur la route de progression.
 *
 * `sendBeacon` envoie un blob dont on ne controle rien depuis le serveur : un corps mal
 * forme ne doit pas ecrire en base, et surtout pas creer une oeuvre fantome dans la
 * bibliotheque.
 */
export function corpsProgressionValide(corps: unknown): CorpsProgression | null {
  if (!corps || typeof corps !== 'object') return null;
  const c = corps as Record<string, unknown>;
  const { oeuvre, mangadexId, tome, planche, planches, titre, couverture, tomes, pourcent } = c;
  // L'oeuvre peut arriver deja identifiee (depuis la bibliotheque) OU a former depuis un
  // titre (premiere lecture d'une oeuvre pas encore suivie). Exiger la premiere forme
  // rendrait l'entree AUTOMATIQUE impossible, precisement dans le seul cas ou elle sert.
  const identifiable =
    (typeof oeuvre === 'string' && oeuvre) || (typeof titre === 'string' && titre);
  if (!identifiable) return null;
  if (typeof tome !== 'string' || !tome) return null;
  if (typeof planche !== 'number' || !Number.isFinite(planche)) return null;
  if (typeof planches !== 'number' || !Number.isFinite(planches) || planches <= 0) return null;
  return {
    oeuvre: typeof oeuvre === 'string' ? oeuvre : '',
    mangadexId: typeof mangadexId === 'string' && mangadexId ? mangadexId : undefined,
    tome,
    planche,
    planches,
    // Absent pour un CBZ : le champ n'est pas obligatoire, et une valeur hors bornes est
    // ignoree plutot que de faire echouer l'enregistrement d'une position par ailleurs
    // valide.
    pourcent: typeof pourcent === 'number' && Number.isFinite(pourcent) ? pourcent : undefined,
    titre: typeof titre === 'string' && titre ? titre : undefined,
    couverture: typeof couverture === 'string' && couverture ? couverture : undefined,
    tomes: Array.isArray(tomes)
      ? tomes.filter((t): t is string => typeof t === 'string' && t.length > 0).slice(0, 500)
      : undefined,
  };
}

/**
 * Identite de l'oeuvre a suivre.
 *
 * Le client envoie soit une identite deja formee (depuis la bibliotheque), soit de quoi
 * la former. La normalisation du titre reste COTE SERVEUR : deux clients qui la feraient
 * chacun de leur cote finiraient par diverger, et creeraient deux oeuvres pour un meme
 * titre.
 */
export function identiteDemandee(corps: Record<string, unknown>): string | null {
  const { oeuvre, mangadexId, titre } = corps;
  if (typeof oeuvre === 'string' && oeuvre) return oeuvre;
  if (typeof titre !== 'string' || !titre) return null;
  return identiteOeuvre({
    mangadexId: typeof mangadexId === 'string' && mangadexId ? mangadexId : undefined,
    titre,
  });
}

/**
 * Convertit une liste de fichiers rendue par un debrideur en structure de tomes.
 *
 * On repasse par `analyser` — et non par une regle locale — pour que `tomeId` soit
 * EXACTEMENT celui calcule lors d'une recherche. Deux chemins qui produiraient des
 * identites differentes pour un meme fichier feraient enregistrer la progression sous une
 * cle que l'autre ne relirait jamais : une panne muette, et impossible a comprendre depuis
 * l'interface.
 */
export function fichiersDepuisDebrid(fichiers: FichierDebride[]) {
  return analyser(
    fichiers.map((f) => ({ chemin: f.nom, taille: typeof f.taille === 'number' ? f.taille : 0 })),
  ).fichiers;
}

export function routesBibliotheque(db: Database): Router {
  const r = Router();

  r.get('/api/bibliotheque', exigerConnexion, (req, res) => {
    res.json({ oeuvres: lireBibliotheque(db, req.session!.userId) });
  });

  r.post('/api/bibliotheque/suivre', exigerConnexion, exigerCsrf, (req, res) => {
    const corps = (req.body || {}) as Record<string, unknown>;
    const oeuvre = identiteDemandee(corps);
    const titre = typeof corps.titre === 'string' ? corps.titre : '';
    if (!oeuvre || !titre) {
      res.status(400).json({ erreur: 'un titre est requis pour suivre une oeuvre' });
      return;
    }
    suivre(db, req.session!.userId, {
      oeuvre,
      titre,
      couverture: typeof corps.couverture === 'string' ? corps.couverture : null,
      cleRelease: typeof corps.cleRelease === 'string' ? corps.cleRelease : null,
      titreRelease: typeof corps.titreRelease === 'string' ? corps.titreRelease : null,
      source: typeof corps.source === 'string' ? corps.source : null,
      famille: typeof corps.famille === 'string' ? corps.famille : null,
    });
    res.json({ suivie: true, oeuvre });
  });

  r.post('/api/bibliotheque/oublier', exigerConnexion, exigerCsrf, (req, res) => {
    const { oeuvre } = (req.body || {}) as Record<string, unknown>;
    if (typeof oeuvre !== 'string' || !oeuvre) {
      res.status(400).json({ erreur: 'oeuvre requise' });
      return;
    }
    oublier(db, req.session!.userId, oeuvre);
    res.json({ suivie: false });
  });

  r.post('/api/bibliotheque/raccourci', exigerConnexion, exigerCsrf, (req, res) => {
    const { oeuvre, cleRelease, titreRelease, source } = (req.body || {}) as Record<string, unknown>;
    if ([oeuvre, cleRelease, titreRelease, source].some((v) => typeof v !== 'string' || !v)) {
      res.status(400).json({ erreur: 'oeuvre, cleRelease, titreRelease et source sont requis' });
      return;
    }
    changerRaccourci(db, req.session!.userId, oeuvre as string, {
      cleRelease: cleRelease as string,
      titreRelease: titreRelease as string,
      source: source as string,
    });
    res.json({ change: true });
  });

  r.post('/api/bibliotheque/progression', exigerConnexion, exigerCsrf, (req, res) => {
    const v = corpsProgressionValide(req.body);
    if (!v) {
      res.status(400).json({ erreur: 'position incomplete' });
      return;
    }
    const oeuvre = identiteDemandee({ oeuvre: v.oeuvre, mangadexId: v.mangadexId, titre: v.titre });
    if (!oeuvre) {
      res.status(400).json({ erreur: 'impossible d identifier l oeuvre' });
      return;
    }
    // ENTREE AUTOMATIQUE : lire un tome, c'est suivre l'oeuvre. Sans cela, « ce que je
    // suis en train de lire » dependrait d'avoir pense a cliquer avant de lire.
    // `suivre` est idempotent et ne touche ni a la date d'ajout ni au raccourci deja
    // pose : l'appeler a chaque position ne coute qu'un UPDATE.
    if (v.titre) {
      // La famille voyage AVEC la position : c'est par ici qu'une oeuvre entre dans la
      // bibliotheque sans qu'on ait clique « suivre », et sans elle ces entrees-la
      // n'auraient jamais de rayon.
      suivre(db, req.session!.userId, {
        oeuvre,
        titre: v.titre,
        couverture: v.couverture ?? null,
        famille: typeof (req.body || {}).famille === 'string' ? (req.body as Record<string, string>).famille : null,
      });
    }
    // APRES `suivre` : `memoriserTomes` met a jour une ligne existante, elle ne la cree
    // pas. Dans l'autre ordre, la toute premiere lecture d'une oeuvre perdrait sa liste.
    if (v.tomes?.length) {
      memoriserTomes(db, req.session!.userId, oeuvre, v.tomes);
    }
    enregistrerPosition(db, req.session!.userId, oeuvre, v.tome, v.planche, v.planches, v.pourcent);
    // 204 : `sendBeacon` ne lit jamais la reponse, et il n'y a rien a rendre.
    res.status(204).end();
  });

  /**
   * Fichiers d'une release memorisee, obtenus AUPRES DU DEBRIDEUR.
   *
   * POURQUOI CETTE ROUTE EXISTE. `/api/release/:cle/fichiers` decode le `.torrent`, dont
   * l'URL porte la passkey de l'utilisateur — elle ne touche donc jamais le disque et ne
   * vit qu'en memoire, remplie par une recherche. Depuis la bibliotheque il n'y a pas eu
   * de recherche : la route repondait « release inconnue : relancez la recherche », ce qui
   * annulait la promesse meme d'un favori.
   *
   * La lecture, elle, n'a jamais eu besoin du `.torrent` : elle depose le hash et demande
   * la liste au debrideur. On emprunte le meme chemin.
   *
   * La garantie de cache est conservee : on n'ouvre que si l'etat MEMORISE pour ce service
   * vaut « en-cache ». C'est le verdict pose par la verification, et il est ici la seule
   * autorisation d'agir.
   */
  r.get('/api/bibliotheque/fichiers', exigerConnexion, async (req, res) => {
    const cle = String(req.query.cle ?? '').toLowerCase();
    const nom = String(req.query.service ?? '');
    if (!/^[a-f0-9]{40}$/.test(cle)) {
      res.status(400).json({ erreur: 'identite de release invalide' });
      return;
    }
    if (nom !== 'alldebrid' && nom !== 'torbox') {
      res.status(400).json({ erreur: 'service debrid inconnu ou absent' });
      return;
    }
    if (etatCacheMemorise(req.session!.userId, cle, nom) !== 'en-cache') {
      // Sans verdict, on ne depose RIEN. Ne pas savoir n'autorise pas a agir.
      res.status(409).json({ erreur: 'cette release n est pas confirmee en cache' });
      return;
    }

    const cles = clesEnClair(db, req.session!.userId, req.session!.dek);
    const cleService = nom === 'alldebrid' ? cles.ad : cles.tb;
    if (!cleService) {
      res.status(400).json({ erreur: `aucune cle ${nom} enregistree` });
      return;
    }

    try {
      const svc = service(nom, cleService);
      const id = await svc.deposer(cle);
      if (!id) {
        res.status(502).json({ erreur: `${nom} n a pas pu ouvrir cette release` });
        return;
      }
      const fichiers = fichiersDepuisDebrid(await svc.listerFichiers(id));

      // On retient les tomes de ce pack. C'est gratuit — on vient de les obtenir — et
      // c'est ce qui permet a l'etagere de montrer le pack ENTIER au lieu des seuls tomes
      // deja ouverts, donc de passer au suivant quand on en termine un.
      const oeuvre = String(req.query.oeuvre ?? '');
      if (oeuvre) {
        memoriserTomes(db, req.session!.userId, oeuvre, fichiers.filter((f) => f.estBd).map((f) => f.tomeId));
      }

      res.json({ fichiers });
    } catch (e) {
      res.status(502).json({ erreur: (e as Error).message });
    }
  });

  return r;
}
