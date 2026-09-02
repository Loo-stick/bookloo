// Routes de la bibliotheque.
//
// Minces a dessein. Ce depot n'a pas de supertest : la logique testable est donc extraite
// en fonctions pures — ici `corpsProgressionValide` — et les routes se contentent de les
// appeler. C'est le pattern deja en place dans `releases.ts` et `compte.ts`.

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import { exigerConnexion, exigerCsrf } from '../auth/garde';
import { clesEnClair } from '../auth/cles-utilisateur';
import { etatCacheMemorise, sourceMemorisee } from '../core/liens-torrent';
import { service } from '../debrid';
import { analyser, numeroDeFichier, type FichierTome } from '../sources/torrent/structure';
import { inspecterZip, ErreurZip } from '../lecture/zip';
import { cheminImbrique } from '../lecture/chemin-imbrique';
import { ouvrirDistantDebrid } from './lecture';
import type { FichierDebride } from '../debrid/types';
import { identiteOeuvre, identiteTome } from '../bibliotheque/identites';
import { identiteCatalogue } from '../bibliotheque/identite-catalogue';
import { catalogueParId } from '../catalogue';
import {
  suivre, oublier, changerRaccourci, enregistrerPosition, lireBibliotheque, memoriserTomes,
  attacherAppoint, detacherAppoint, memoriserDernierTome,
} from '../bibliotheque/depot';
import { avecParutions } from '../presse/parution';

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
/** Le corps d'un attachement de release d'appoint, une fois valide. */
export interface CorpsAppoint {
  oeuvre: string;
  cleRelease: string;
  titreRelease: string | null;
  source: string | null;
  tomes: string[];
  tomeCible: string | null;
}

/**
 * Valide un corps d'appoint, ou rend `null`.
 *
 * L'oeuvre et la cle FONT la ligne : sans l'une des deux il n'y a rien a attacher, et rien
 * a retirer ensuite. Le reste n'est que de la description — une liste de tomes mal typee se
 * nettoie plutot que de faire refuser l'attachement, qui aurait marche sans elle.
 */
export function corpsAppointValide(corps: unknown): CorpsAppoint | null {
  if (!corps || typeof corps !== 'object') return null;
  const c = corps as Record<string, unknown>;
  const oeuvre = typeof c.oeuvre === 'string' ? c.oeuvre.trim() : '';
  const cleRelease = typeof c.cleRelease === 'string' ? c.cleRelease.trim() : '';
  if (!oeuvre || !cleRelease) return null;
  return {
    oeuvre,
    cleRelease,
    titreRelease: typeof c.titreRelease === 'string' ? c.titreRelease : null,
    source: typeof c.source === 'string' ? c.source : null,
    tomes: Array.isArray(c.tomes) ? c.tomes.filter((x): x is string => typeof x === 'string') : [],
    tomeCible: typeof c.tomeCible === 'string' && c.tomeCible ? c.tomeCible : null,
  };
}

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

/**
 * Les tomes contenus DANS une archive, exposes comme des fichiers ordinaires.
 *
 * Une release peut n'etre qu'un seul ZIP qui contient les tomes — mesure du 2026-08-28 :
 * « One.Piece.[T01.T105]…CHROMATIQUE » est un .zip de 15,3 Go, et non cent cinq CBZ. Sans
 * cela `EXT_BD` ne reconnait rien, et l'etagere annonce « aucun fichier de bande dessinee »
 * sur une release qui porte toute la serie.
 *
 * On reutilise `analyser` sur des chemins A DEUX NIVEAUX : le numero de tome se lit sur le
 * nom interne, dernier segment du chemin — exactement comme pour un fichier ordinaire.
 */
export function tomesDeLArchive(
  archive: string,
  entrees: { nom: string; tailleReelle: number }[],
) {
  return analyser(
    entrees.map((e) => ({ chemin: cheminImbrique(archive, e.nom), taille: e.tailleReelle })),
  ).fichiers.filter((f) => f.estBd);
}

/**
 * Des archives PAR VOLUME, exposees comme des tomes.
 *
 * Signale a l'usage le 2026-08-28 : « ワンピース 第01-109巻 » range chaque volume dans un
 * .rar separe, et « EXT_BD » ne reconnait ni .rar ni .zip. Aucun tome n'etait donc trouve,
 * alors que la grille en promettait cent neuf — elle se fiait a la plage du titre.
 *
 * LE NOMBRE DISTINGUE LES DEUX CAS, et rien d'autre ne le peut : plusieurs archives sont
 * autant de tomes, une seule est un CONTENANT dans lequel il faut regarder. Un .cbz et un
 * .zip d'images sont le meme fichier a l'extension pres ; c'est leur multiplicite qui dit
 * comment les lire.
 */
export function archivesCommeTomes(fichiers: FichierTome[]): FichierTome[] | null {
  const archives = fichiers.filter((f) => /\.(zip|rar)$/i.test(f.chemin));
  if (archives.length < 2) return null;
  // On numerote NOUS-MEMES : `analyser` ne lit le numero que sur ce qu'il tient deja pour
  // de la bande dessinee, et une archive n'en est pas a ses yeux. Le forcer apres coup
  // laissait le tome en « f:<nom> ».
  return archives.map((f) => ({
    ...f,
    estBd: true,
    tome: numeroDeFichier(f.chemin),
    tomeId: identiteTome({ tome: numeroDeFichier(f.chemin), chemin: f.chemin }),
  }));
}

export function routesBibliotheque(db: Database): Router {
  const r = Router();

  r.get('/api/bibliotheque', exigerConnexion, (req, res) => {
    // LES PARUTIONS SE CALCULENT ICI, PAS DANS LE DEPOT : celui-ci ne fait que lire et
    // ecrire, et nommer un numero par sa date est une regle de la presse. Elle vit donc
    // dans `presse/parution.ts`, avec le parseur qui la sert deja au kiosque.
    res.json({ oeuvres: avecParutions(lireBibliotheque(db, req.session!.userId)) });
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
    // LE TOTAL DU CATALOGUE VIENT DU CLIENT, et c'est deliberé : la fiche est deja dans sa
    // main (`oeuvreCourante`), tandis que cette route est synchrone et n'a que l'identite.
    // L'aller chercher ici ajouterait un appel reseau a chaque suivi pour un nombre qui
    // n'est qu'une borne d'affichage.
    //
    // `memoriserDernierTome` ignore `null` : une fiche qui repond a vide ne doit pas
    // effacer ce qu'on savait deja.
    memoriserDernierTome(db, req.session!.userId, oeuvre,
      typeof corps.dernierTome === 'number' && Number.isInteger(corps.dernierTome)
        && corps.dernierTome > 0 ? corps.dernierTome : null);
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
    const corps = (req.body || {}) as Record<string, unknown>;
    changerRaccourci(db, req.session!.userId, oeuvre as string, {
      cleRelease: cleRelease as string,
      titreRelease: titreRelease as string,
      source: source as string,
      // Les tomes que la release ANNONCE, deduits de son titre par le navigateur. Sans
      // eux, la bibliotheque ne sait rien d'un pack tant qu'aucun tome n'y a ete ouvert.
      tomes: Array.isArray(corps.tomes)
        ? corps.tomes.filter((x): x is string => typeof x === 'string')
        : undefined,
    });
    res.json({ change: true });
  });

  /**
   * Attache une release d'appoint : elle comblera les tomes que la principale ne porte pas.
   *
   * `source` vient du navigateur, comme pour `/raccourci` — le panneau la connait de
   * premiere main, et la recalculer ici creerait un second chemin qui finirait par diverger
   * de celui-la. (La route de progression, elle, la prend de `sourceMemorisee` parce que la
   * liseuse ne la connait pas.)
   */
  r.post('/api/bibliotheque/appoint', exigerConnexion, exigerCsrf, (req, res) => {
    const v = corpsAppointValide(req.body);
    if (!v) {
      res.status(400).json({ erreur: 'oeuvre et cleRelease sont requis' });
      return;
    }
    // `attacherAppoint` rend `false` quand l'oeuvre n'est pas suivie : sans cette garde on
    // accumulerait des appoints que rien n'affiche et que rien n'efface.
    if (!attacherAppoint(db, req.session!.userId, v.oeuvre, v)) {
      res.status(400).json({ erreur: 'cette oeuvre n est pas suivie' });
      return;
    }
    res.json({ attache: true });
  });

  /**
   * Detache une release d'appoint.
   *
   * NE TOUCHE PAS A LA PROGRESSION : les tomes redeviennent manquants, l'avancee reste. On
   * retrouvera ou l'on en etait le jour ou une autre release les portera.
   */
  /**
   * Retrouve, et retient, le dernier tome d'une serie deja suivie.
   *
   * POURQUOI UNE ROUTE A PART. Le total voyage normalement dans le corps de `suivre`,
   * envoye par le client qui a la fiche en main. Les oeuvres suivies AVANT que ce champ
   * existe n'en ont donc pas, et leur grille s'arrete au plus grand tome deja lu — quarante
   * -trois cases pour un pack qui en annonce cent. Signale a l'usage.
   *
   * L'appel est mis en cache cote catalogue : le repeter ne coute rien apres la premiere
   * fois, et une oeuvre hors catalogue (`libre:…`) est ecartee sans requete.
   */
  r.post('/api/bibliotheque/dernier-tome', exigerConnexion, exigerCsrf, async (req, res) => {
    const { oeuvre } = (req.body || {}) as Record<string, unknown>;
    if (typeof oeuvre !== 'string' || !oeuvre) {
      res.status(400).json({ erreur: 'oeuvre requise' });
      return;
    }
    const ident = identiteCatalogue(oeuvre);
    const cat = ident ? catalogueParId(ident.catalogue) : null;
    if (!ident || !cat) {
      // Pas une panne : une oeuvre issue d'une recherche libre n'a aucun catalogue, et
      // c'est un etat normal. Le client n'a plus a redemander.
      res.json({ dernierTome: null, horsCatalogue: true });
      return;
    }
    try {
      const fiche = await cat.fiche(ident.id);
      const dernierTome = fiche?.dernierTome ?? null;
      memoriserDernierTome(db, req.session!.userId, oeuvre, dernierTome);
      res.json({ dernierTome });
    } catch {
      // Le total n'est qu'une borne d'affichage : son absence ne fait pas tomber l'etagere.
      res.json({ dernierTome: null });
    }
  });

  r.delete('/api/bibliotheque/appoint', exigerConnexion, exigerCsrf, (req, res) => {
    const v = corpsAppointValide(req.body);
    if (!v) {
      res.status(400).json({ erreur: 'oeuvre et cleRelease sont requis' });
      return;
    }
    detacherAppoint(db, req.session!.userId, v.oeuvre, v.cleRelease);
    res.json({ detache: true });
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
      // LA RELEASE D'OU L'ON LIT devient le chemin d'acces. Sans elle, une oeuvre entrait
      // dans la bibliotheque sans savoir par ou la rouvrir : « Reprendre » repondait
      // « aucune release memorisee » sur une oeuvre lue la veille.
      //
      // La SOURCE vient de la memoire des liens du serveur : le navigateur n'a pas a la
      // renvoyer, et deux chemins qui la calculeraient finiraient par diverger.
      //
      // Les COALESCE de `suivre` protegent le reste : un appel qui ignore la release
      // n'efface jamais un raccourci deja pose.
      const corps = (req.body || {}) as Record<string, unknown>;
      const cleRelease = typeof corps.cleRelease === 'string' ? corps.cleRelease : null;
      suivre(db, req.session!.userId, {
        oeuvre,
        titre: v.titre,
        couverture: v.couverture ?? null,
        famille: typeof corps.famille === 'string' ? corps.famille : null,
        cleRelease,
        titreRelease: typeof corps.titreRelease === 'string' ? corps.titreRelease : null,
        source: cleRelease
          ? sourceMemorisee(req.session!.userId, cleRelease).source ?? null
          : null,
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

      // LISTER N'EST PAS LIRE. Afficher ce qu'une release contient ne doit rien ajouter sur
      // le compte de l'utilisateur : TorBox sait repondre depuis son cache, sans depot.
      // AllDebrid n'a aucune consultation en lecture seule et rend `null` — on retombe
      // alors sur le depot, qui reste chez lui le seul chemin possible.
      const enCache = svc.listerDepuisCache ? await svc.listerDepuisCache(cle) : null;
      let brut = enCache;
      if (!brut) {
        const id = await svc.deposer(cle);
        if (!id) {
          res.status(502).json({ erreur: `${nom} n a pas pu ouvrir cette release` });
          return;
        }
        brut = await svc.listerFichiers(id);
      }
      let fichiers = fichiersDepuisDebrid(brut);

      // AUCUN TOME, MAIS UNE ARCHIVE. On regarde DEDANS plutot que de rendre une liste
      // vide : les octets d'un CBZ contenu dans un ZIP sont contigus, donc lisibles par
      // plages sans jamais charger l'archive. Deux requetes de plage sur le repertoire
      // central suffisent, meme sur quinze gigaoctets.
      let motifArchive: string | null = null;
      if (!fichiers.some((f) => f.estBd)) {
        // PLUSIEURS ARCHIVES SONT AUTANT DE TOMES. On regarde ce cas AVANT d'ouvrir quoi
        // que ce soit : cent neuf .rar, un par volume, n'ont pas besoin d'etre inspectes.
        const parVolume = archivesCommeTomes(fichiers);
        if (parVolume) fichiers = parVolume;
      }

      if (!fichiers.some((f) => f.estBd)) {
        const zip = fichiers
          .filter((f) => /\.zip$/i.test(f.chemin))
          .sort((x, y) => (y.taille || 0) - (x.taille || 0))[0];
        if (zip) {
          try {
            const distant = await ouvrirDistantDebrid(req.session!.userId, {
              nom, cle: cleService, hash: cle, fichier: zip.chemin,
            });
            const { archives } = await inspecterZip(distant.lire, distant.taille);
            const dedans = tomesDeLArchive(zip.chemin, archives);
            if (dedans.length) fichiers = dedans;
            else motifArchive = `${zip.chemin.split('/').pop()} ne contient aucun CBZ`;
          } catch (e) {
            // ON REMONTE LA RAISON. Une archive illisible n'est pas une panne de la route,
            // mais taire POURQUOI laisse l'interface en inventer une — ce qui a deja coute
            // deux diagnostics faux le meme jour. « ZIP64 » et « archive corrompue » ne
            // demandent pas la meme chose a l'utilisateur.
            motifArchive = e instanceof ErreurZip && e.code === 'zip64'
              ? 'archive de plus de 4 Go (ZIP64), format non pris en charge'
              : (e as Error).message;
          }
        }
      }

      // On retient les tomes de ce pack. C'est gratuit — on vient de les obtenir — et
      // c'est ce qui permet a l'etagere de montrer le pack ENTIER au lieu des seuls tomes
      // deja ouverts, donc de passer au suivant quand on en termine un.
      const oeuvre = String(req.query.oeuvre ?? '');
      if (oeuvre) {
        memoriserTomes(db, req.session!.userId, oeuvre, fichiers.filter((f) => f.estBd).map((f) => f.tomeId));
      }

      // NOMMER CE QU'ON A TROUVE, TOUJOURS. Quatre fois dans la meme journee, un message
      // qui taisait le contenu reel a envoye chercher le defaut au mauvais endroit. Les
      // noms de fichiers repondent seuls a la question « alors quoi ? ».
      if (!fichiers.some((f) => f.estBd) && !motifArchive) {
        const noms = fichiers.slice(0, 4).map((f) => f.chemin.split('/').pop());
        motifArchive = fichiers.length
          ? `aucun fichier de bande dessinee parmi ${fichiers.length} : ${noms.join(', ')}`
          : 'le debrideur n a rendu aucun fichier';
      }
      res.json({ fichiers, motifArchive });
    } catch (e) {
      res.status(502).json({ erreur: (e as Error).message });
    }
  });

  return r;
}
