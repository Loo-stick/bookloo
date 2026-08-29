// Ouverture d'une release et resolution des liens.
//
// TROIS GARANTIES, TENUES PAR LE CODE ET PAS PAR LA DISCIPLINE DE L'APPELANT :
//
//   1. Le choix du debrideur est TOUJOURS explicite. Un service absent ou inconnu est
//      une erreur 400, jamais un repli — on n'envoie pas un torrent sur un compte que
//      l'utilisateur n'a pas designe.
//   2. Seuls les fichiers demandes sont deverrouilles. En fabriquer 108 quand trois
//      sont coches est du gaspillage, et ces liens expirent.
//   3. La verification AllDebrid rend le resultat du RETRAIT, pas seulement l'etat du
//      cache : c'est la seule operation qui touche le compte de l'utilisateur.

import { Router, type Request } from 'express';
import type { Database } from 'better-sqlite3';
import { httpGet } from '../core/http';
import { fichiersDuTorrent } from '../core/bencode';
import {
  hashConnu,
  lienMemorise,
  oublierEtatCache,
  poserEtatCache,
  etatCacheMemorise,
  sourceMemorisee,
} from '../core/liens-torrent';
import { ouvrirFicheWawacity } from '../sources/ddl/wawacity';
import { hoteExploitable, hotesSupportes } from '../debrid/hosts';
import { estMort, morteDepuis } from '../debrid/liens-morts';
import { resoudreDdl } from '../debrid/ddl';
import { ouvrirDistant } from '../lecture/plages';
import { inspecterZip } from '../lecture/zip';
import { tracer, hoteDe } from '../core/journal';
import { analyser } from '../sources/torrent/structure';
import { clesEnClair } from '../auth/cles-utilisateur';
import { exigerConnexion, exigerCsrf } from '../auth/garde';
import { service, type NomService } from '../debrid';
import { verifierUnHash } from '../debrid/alldebrid';
import type { FichierDebride, EtatCache } from '../debrid/types';
import { compteAuRatio } from '../sources/ratio';
import { doitSeeder } from '../rustatio/decision';
import { configHnrPour } from '../rustatio/config-hnr';
import { parseConfigRustatio } from '../rustatio/config';
import { seederRelease } from '../rustatio/client';

const MAX_TORRENT_OCTETS = 4 * 1024 * 1024;
const RE_HASH = /^[a-f0-9]+$/;
const estHash = (h: string) => RE_HASH.test(h) && h.length === 40;

/**
 * Identite d'une release SANS infohash (lien direct).
 *
 * Deux formes coexistent desormais dans le pipeline. Elles ne peuvent pas se confondre :
 * un hash fait quarante caracteres hexadecimaux, une identite DDL commence par « ddl: ».
 */
export function estIdentiteDdl(id: string): boolean {
  return /^ddl:[a-z0-9-]+:[A-Za-z0-9_-]+$/.test(id);
}

/** `ddl:wawacity:62774` -> `{ site: 'wawacity', id: '62774' }`. */
function decouperIdentite(id: string): { site: string; id: string } | null {
  const m = id.match(/^ddl:([a-z0-9-]+):([A-Za-z0-9_-]+)$/);
  return m ? { site: m[1], id: m[2] } : null;
}

const SERVICES: NomService[] = ['alldebrid', 'torbox'];

/** Le service demande, ou une exception. Jamais de valeur par defaut. */
export function choisirService(nom: unknown): NomService {
  const n = String(nom ?? '');
  if (!SERVICES.includes(n as NomService)) {
    throw new Error(`service debrid inconnu ou absent: ${n || '(vide)'}`);
  }
  return n as NomService;
}

export interface FichierChemin {
  chemin: string;
  taille: number;
}

/** Filtre l'arborescence sur ce que l'utilisateur a coche, dans l'ordre demande. */
export function fichiersDemandes(dispo: FichierChemin[], voulus: string[]): FichierChemin[] {
  const parChemin = new Map(dispo.map((f) => [f.chemin, f]));
  const out: FichierChemin[] = [];
  for (const v of voulus) {
    const f = parChemin.get(v);
    // Un chemin inconnu est ignore : il ne doit pas faire echouer toute la demande.
    if (f) out.push(f);
  }
  return out;
}

function nomDeBase(chemin: string): string {
  return chemin.split('/').pop() || chemin;
}

/**
 * Apparie les fichiers du .torrent et ceux du debrideur.
 *
 * Sur le NOM DE FICHIER, pas sur le chemin : le .torrent annonce
 * « One Piece/T01.cbz » la ou TorBox rend « T01.cbz ».
 */
export function apparierDebrid<T extends { nom: string }>(
  cotesDebrid: T[],
  cheminsVoulus: string[],
): T[] {
  const parNom = new Map(cotesDebrid.map((f) => [nomDeBase(f.nom), f]));
  const out: T[] = [];
  for (const c of cheminsVoulus) {
    const f = parNom.get(nomDeBase(c));
    if (f) out.push(f);
  }
  return out;
}

interface ErreurRequete { code: number; erreur: string }

/**
 * Resout les trois choses dont chaque route de debridage a besoin : le service designe,
 * le hash, et la cle de l'utilisateur pour ce service.
 *
 * Regroupees ici parce qu'elles echouent ensemble et de la meme facon — et parce que
 * recopier ce bloc dans chaque route est le meilleur moyen d'en oublier un morceau.
 */
function resoudreDemande(
  db: Database,
  req: Request,
): { nom: NomService; hash: string; cle: string } | ErreurRequete {
  let nom: NomService;
  try {
    nom = choisirService((req.body as Record<string, unknown> | undefined)?.service);
  } catch (e) {
    return { code: 400, erreur: (e as Error).message };
  }

  const brutHash = String((req.body as Record<string, unknown> | undefined)?.hash ?? '');
  if (estIdentiteDdl(brutHash)) {
    // Le bouton ne devrait pas exister sur une release en lien direct ; si la route est
    // appelee quand meme, elle dit POURQUOI plutot que « hash invalide ».
    return {
      code: 400,
      erreur: "cette release est un lien direct : sa disponibilite depend de l hebergeur, "
        + 'ouvrez-la pour la voir',
    };
  }
  const hash = brutHash.toLowerCase();
  if (!estHash(hash)) return { code: 400, erreur: 'hash invalide' };

  const cles = clesEnClair(db, req.session!.userId, req.session!.dek);
  const cle = nom === 'alldebrid' ? cles.ad : cles.tb;
  if (!cle) return { code: 400, erreur: `aucune cle ${nom} enregistree` };

  return { nom, hash, cle };
}

function estErreur(x: unknown): x is ErreurRequete {
  return typeof (x as ErreurRequete)?.code === 'number';
}

/**
 * Seed anti-Hit&Run : apres un download qui coute du ratio (source a passkey, PAS deja
 * en cache), pousse le .torrent vers le Rustatio de l'utilisateur. Best-effort — n'echoue
 * jamais bruyamment, renvoie un statut. Le serveur fetch le .torrent lui-meme : la passkey
 * ne part jamais au navigateur.
 */
async function peutEtreSeeder(
  db: Database,
  req: Request,
  hash: string,
  torrentUrl: string | undefined,
  etatCache: EtatCache,
): Promise<{ statut: 'seede' | 'echec' | 'ignore'; raison?: string }> {
  const { source, aussiSur } = sourceMemorisee(req.session!.userId, hash);
  const cles = clesEnClair(db, req.session!.userId, req.session!.dek);
  const cfg = parseConfigRustatio(cles.rustatio);

  if (!source || !doitSeeder({ source, aussiSur, aConfigRustatio: !!cfg, torrentUrl, etatCache })) {
    // Diagnostic (aucun secret) : POURQUOI on n'a pas seede.
    const why = !source ? 'source-non-memorisee'
      : !cfg ? 'pas-de-config-rustatio'
      : !torrentUrl ? 'pas-de-torrent-url'
      : !compteAuRatio(source) ? 'source-gratuite'
      : !configHnrPour(source) ? 'source-non-couverte'
      : etatCache === 'en-cache' ? 'deja-en-cache'
      : etatCache === 'inconnu' ? 'cache-inconnu'
      : 'inconnu';
    tracer('Rustatio', `seed ignore: ${why} (source=${source || '?'}, aussiSur=${(aussiSur || []).join('+') || '-'}, cache=${etatCache})`);
    return { statut: 'ignore', raison: why };
  }
  const hnr = configHnrPour(source);
  if (!cfg || !hnr || !torrentUrl) return { statut: 'ignore' };

  // LE SEPTIEME CHEMIN, et le seul qui reste a toucher le tracker.
  //
  // Les six autres — lister, lire, ecouter, liens, archive, sommaire audio — ont ete
  // fermes le 2026-08-26 : ils se contentent de l'empreinte, ce qui suffit des lors que
  // la release est dans le cache du debrideur. Celui-ci ne le peut pas : pour seeder un
  // torrent, il faut le torrent.
  //
  // La trace existe parce que ce chemin est INVISIBLE depuis celle du debrideur, et que
  // son absence a fait chercher une fuite la ou il n'y en avait plus. L'hote seulement :
  // l'URL porte le passkey.
  tracer('Rustatio', `recuperation du .torrent chez ${hoteDe(torrentUrl)} (seed anti-H&R)`);
  const rep = await httpGet<ArrayBuffer>(torrentUrl, {
    responseType: 'buffer', timeoutMs: 15000, retries: 1, maxBytes: MAX_TORRENT_OCTETS,
  });
  if (!rep || rep.status >= 400) {
    tracer('Rustatio', `seed echec: torrent-illisible (source=${source})`);
    return { statut: 'echec', raison: 'torrent-illisible' };
  }
  const buf = Buffer.from(rep.data as ArrayBuffer);
  if (buf.length === 0 || buf[0] !== 0x64) {
    tracer('Rustatio', `seed echec: pas-un-torrent (source=${source})`);
    return { statut: 'echec', raison: 'pas-un-torrent' };
  }

  const r = await seederRelease(cfg, buf, hnr);
  tracer('Rustatio', `seed ${r.statut}${r.raison ? ' (' + r.raison + ')' : ''} (source=${source}, cache=${etatCache})`);
  return r;
}

export interface Archive {
  /** 'zip' | 'rar' | 'inconnu' */
  format: string;
  /** Lisible en ligne : un ZIP contenant directement des images. */
  lisible: boolean;
  nbPlanches?: number;
  /** Tomes d'un PACK : les archives imbriquees, listees mais pas extractibles. */
  tomes?: { nom: string; taille: number }[];
  motif?: string;
}

/**
 * Lit les premiers octets du fichier pour savoir ce qu'on a affaire.
 *
 * Une resolution et quelques requetes de plage — celles-la memes que le lecteur ferait
 * ensuite. C'est le prix d'un bouton qui dit la verite.
 */
async function sonderArchive(
  liens: { hebergeur: string; url: string }[],
  supportes: Record<string, Set<string>>,
  cles: { ad?: string; tb?: string },
): Promise<Archive> {
  // AllDebrid d'abord : lui seul franchit dl-protect.
  const services: [NomService, string | undefined][] = [['alldebrid', cles.ad], ['torbox', cles.tb]];
  // Le predicat de type garde `cle` non-optionnelle dans la boucle : sans lui, TypeScript
  // ne sait pas que le filtre a deja ecarte les services sans cle.
  const configures = services.filter((s): s is [NomService, string] => Boolean(s[1]));
  if (configures.length === 0) {
    return { format: 'inconnu', lisible: false, motif: 'aucune cle de debrideur enregistree' };
  }

  // NOMMER LA PANNE. « aucun hebergeur joignable pour sonder » couvrait trois situations
  // differentes — pas de cle, aucun hote pris en charge, liens morts — et n'en designait
  // aucune. Signale a l'usage sur une release Wawacity de Manhole : le message ne disait
  // pas s'il fallait changer de release, changer de debrideur, ou attendre.
  const prisEnCharge = liens.filter((l) =>
    configures.some(([nom]) => hoteExploitable(l.hebergeur, supportes[nom])));
  if (prisEnCharge.length === 0) {
    const hotes = [...new Set(liens.map((l) => l.hebergeur))].join(', ');
    return {
      format: 'inconnu',
      lisible: false,
      motif: `aucun de vos debrideurs ne prend en charge ces hebergeurs (${hotes})`,
    };
  }

  for (const [nom, cle] of configures) {
    for (const l of liens) {
      if (estMort(l.url) || !hoteExploitable(l.hebergeur, supportes[nom])) continue;
      const url = await resoudreDdl(l.url, nom, cle);
      if (!url) continue;
      try {
        const distant = await ouvrirDistant({ resoudre: async () => url });
        const debut = (await distant.lire(0, 7)).toString('latin1');
        if (debut.startsWith('Rar!')) {
          return {
            format: 'rar',
            lisible: false,
            motif: 'archive RAR — telechargez-la pour la lire hors ligne',
          };
        }
        if (!debut.startsWith('PK')) {
          return { format: 'inconnu', lisible: false, motif: 'format d archive non reconnu' };
        }
        const contenu = await inspecterZip(distant.lire, distant.taille);
        if (contenu.images.length > 0) {
          return { format: 'zip', lisible: true, nbPlanches: contenu.images.length };
        }
        return {
          format: 'zip',
          lisible: false,
          // Un pack de .cbz : on peut les LISTER, mais en extraire un seul demanderait de
          // le charger entier en memoire — un tome pese 150 a 250 Mo, le conteneur est
          // borne a 512.
          tomes: contenu.archives.map((e) => ({ nom: e.nom, taille: e.tailleReelle })),
          motif: 'archive contenant plusieurs tomes — telechargez-la pour les separer',
        };
      } catch {
        return { format: 'inconnu', lisible: false, motif: 'le fichier n a pas pu etre ouvert' };
      }
    }
  }
  // Des hotes pris en charge, mais aucun lien qui reponde : c'est la RELEASE qui est
  // morte, pas la configuration. L'interface peut donc proposer d'en changer.
  return {
    format: 'inconnu',
    lisible: false,
    motif: `les ${prisEnCharge.length} lien(s) utilisables de cette release ne repondent plus chez leur hebergeur`,
  };
}

/**
 * Le refus commun a tout ce qui n'est PAS un depot explicite.
 *
 * Recuperer le `.torrent` d'un tracker prive ENREGISTRE un telechargement chez lui, et
 * son annonceur porte le passkey : le debrideur leeche ensuite au nom de l'utilisateur,
 * obligation de seed comprise. Signale a l'usage — un tableau de bord plein de
 * telechargements pour des releases seulement consultees.
 *
 * Ce geste appartient donc au seul depot assume.
 */
function refusDepot(nom: string): string {
  return `${nom} n a pas pu ouvrir cette release a partir de son empreinte seule. Si elle `
    + "n'est pas dans son cache, il lui faut le fichier .torrent : utilisez « Deposer », "
    + 'qui enregistrera un telechargement sur le tracker au nom de votre passkey.';
}

export function routesDebrid(db: Database): Router {
  const r = Router();

  /** Arborescence d'une release, decodee depuis son .torrent. */
  /**
   * Les fichiers d'une release. EN POST, ET AVEC UN JETON.
   *
   * Elle a longtemps ete en GET, protegee par la seule connexion. Or pour une release
   * Wawacity elle appelle `sonderArchive`, donc `resoudreDdl` : elle DEBRIDE reellement un
   * lien sur le compte de l'utilisateur, exactement comme les actions de telechargement —
   * qui, elles, ont toujours ete en POST + CSRF.
   *
   * Le cookie de session est en `sameSite: 'lax'`, qui laisse passer les navigations GET de
   * premier niveau venues d'ailleurs. Un simple lien piege suffisait donc a declencher un
   * debridage a l'insu de l'utilisateur connecte. Signale par une revue de code le
   * 2026-08-29.
   *
   * LIRE N'EST PAS TOUJOURS SANS EFFET : c'est la lecon, et elle vaut au-dela de cette
   * route. Un verbe HTTP ne dit rien de ce que le code fait derriere.
   */
  r.post('/api/release/:hash/fichiers', exigerConnexion, exigerCsrf, async (req, res) => {
    const brut = String(req.params.hash);

    // Une release en LIEN DIRECT ne se decompose pas en tomes mais en HEBERGEURS : un
    // torrent porte plusieurs fichiers, une fiche Wawacity porte un fichier disponible
    // a plusieurs endroits.
    if (estIdentiteDdl(brut)) {
      const decoupe = decouperIdentite(brut)!;
      if (decoupe.site !== 'wawacity') {
        res.status(400).json({ erreur: `source « ${decoupe.site} » inconnue` });
        return;
      }
      const liens = await ouvrirFicheWawacity(decoupe.id);
      if (!liens) { res.status(502).json({ erreur: 'la fiche n a pas pu etre ouverte' }); return; }
      if (liens.length === 0) { res.status(422).json({ erreur: 'aucun lien sur cette fiche' }); return; }

      // On calcule le support pour LES DEUX services d'un coup : basculer le selecteur
      // ne doit pas couter une nouvelle requete.
      const cles = clesEnClair(db, req.session!.userId, req.session!.dek);
      const supportes: Record<string, Set<string>> = {
        alldebrid: cles.ad ? await hotesSupportes('alldebrid', cles.ad) : new Set(),
        torbox: cles.tb ? await hotesSupportes('torbox', cles.tb) : new Set(),
      };

      // On SONDE le type d'archive avant de proposer « Lire ».
      //
      // Mesure du 2026-08-20 sur Wawacity : la moitie des releases sont des ZIP, l'autre
      // des RAR, et le titre ne permet pas de le deviner. Afficher un bouton qui
      // echouera apres une attente vaut moins qu'un bouton absent et une explication.
      const archive = await sonderArchive(liens, supportes, cles);

      res.json({
        type: 'hebergeurs',
        archive,
        hebergeurs: liens.map((l, index) => ({
          index,
          hebergeur: l.hebergeur,
          taille: l.taille,
          nomFichier: l.nomFichier,
          mort: estMort(l.url),
          morteDepuis: morteDepuis(l.url)?.toISOString().slice(0, 10),
          // Le lien protege NE PART PAS vers le navigateur : il est designe par son index.
          supporte: {
            alldebrid: hoteExploitable(l.hebergeur, supportes.alldebrid),
            torbox: hoteExploitable(l.hebergeur, supportes.torbox),
          },
        })),
      });
      return;
    }

    const hash = brut.toLowerCase();
    if (!estHash(hash)) {
      res.status(400).json({ erreur: 'hash invalide' });
      return;
    }
    if (!hashConnu(req.session!.userId, hash)) {
      res.status(404).json({ erreur: 'release inconnue : relancez la recherche' });
      return;
    }
    const url = lienMemorise(req.session!.userId, hash);
    if (!url) {
      // Knaben ne publie qu'un magnet. On ne peut donc pas decoder l'arborescence sans
      // deposer chez un debrideur — et ce depot doit rester un geste choisi, pas un
      // effet de bord d'un clic sur « Ouvrir ». On le dit, et on laisse la main.
      res.status(409).json({
        code: 'sans-torrent',
        erreur: 'cette source ne fournit pas de fichier .torrent, seulement un magnet',
      });
      return;
    }
    // Plafond d'octets AVANT tout decodage : le fichier vient de l'exterieur.
    // HUITIEME CHEMIN VERS LE TRACKER, et le plus discret : aucun debrideur n'y
    // intervient, on telecharge le .torrent uniquement pour en LIRE les tomes. Son
    // absence de trace a fait chercher la fuite ailleurs pendant des heures.
    //
    // L'interface prefere desormais la liste du debrideur quand il detient la release.
    // On n'arrive donc ici que si personne ne l'a — et la, il n'y a pas d'alternative.
    tracer('Structure', `lecture du .torrent chez ${hoteDe(url)} (liste des tomes)`);
    const reponse = await httpGet<ArrayBuffer>(url, {
      responseType: 'buffer', timeoutMs: 15000, retries: 1, maxBytes: MAX_TORRENT_OCTETS,
    });
    if (!reponse || reponse.status >= 400) {
      res.status(502).json({ erreur: 'le tracker n a pas rendu le .torrent' });
      return;
    }
    const fichiers = fichiersDuTorrent(Buffer.from(reponse.data as ArrayBuffer));
    if (!fichiers) {
      res.status(502).json({ erreur: 'contenu .torrent illisible' });
      return;
    }
    res.json(analyser(fichiers));
  });

  /**
   * Arborescence obtenue AUPRES DU DEBRIDEUR, pour les releases sans .torrent.
   *
   * Cette route DEPOSE : c'est la seule facon de connaitre les fichiers quand la source
   * ne publie qu'un magnet. Elle est donc distincte de la precedente, et l'interface la
   * presente comme une action, pas comme un chargement.
   */
  r.post('/api/release/:hash/fichiers-debrid', exigerConnexion, exigerCsrf, async (req, res) => {
    let nom: NomService;
    try {
      nom = choisirService((req.body as Record<string, unknown> | undefined)?.service);
    } catch (e) {
      res.status(400).json({ erreur: (e as Error).message });
      return;
    }
    const hash = String(req.params.hash).toLowerCase();
    if (!estHash(hash)) { res.status(400).json({ erreur: 'hash invalide' }); return; }

    const cles = clesEnClair(db, req.session!.userId, req.session!.dek);
    const cle = nom === 'alldebrid' ? cles.ad : cles.tb;
    if (!cle) { res.status(400).json({ erreur: `aucune cle ${nom} enregistree` }); return; }

    const svc = service(nom, cle);
    // LISTER DES FICHIERS NE JUSTIFIE PAS D'ALLER CHERCHER LE .torrent : voir
    // `refusDepot`. On se contente de ce que le debrideur connait deja.
    const id = (await svc.trouver(hash)) || (await svc.deposer(hash));
    if (!id) {
      res.status(502).json({ erreur: refusDepot(nom) });
      return;
    }
    const fichiers = await svc.listerFichiers(id);
    if (fichiers.length === 0) {
      res.status(502).json({ erreur: `${nom} n a rendu aucun fichier pour cette release` });
      return;
    }
    res.json(analyser(fichiers.map((f) => ({ chemin: f.nom, taille: f.taille ?? 0 }))));
  });

  /**
   * Verification unitaire chez AllDebrid.
   *
   * Elle DEPOSE le magnet — c'est la seule facon de savoir, AllDebrid n'ayant plus de
   * consultation en lecture seule. La reponse dit donc aussi si le depot a bien ete
   * retire, pour que l'utilisateur le sache tout de suite.
   */
  r.post('/api/debrid/verifier', exigerConnexion, exigerCsrf, async (req, res) => {
    const d = resoudreDemande(db, req);
    if (estErreur(d)) { res.status(d.code).json({ erreur: d.erreur }); return; }
    const { nom, hash, cle } = d;

    if (nom === 'alldebrid') {
      const r = await verifierUnHash(hash, cle);
      // Ce verdict est le LAISSEZ-PASSER de la lecture en ligne : chez AllDebrid, c'est
      // le seul moyen de savoir, et il vient d'un geste explicite de l'utilisateur.
      poserEtatCache(req.session!.userId, hash, 'alldebrid', r.etat);
      res.json(r);
      return;
    }
    // Delai court : c'est un CLIC, pas une tache de fond. Attendre vingt-cinq secondes
    // devant un bouton fige est pire qu'un echec franc suivi d'un nouvel essai.
    //
    // On ne borne QUE TorBox : sa verification est une consultation, l'interrompre ne
    // laisse rien derriere. Couper celle d'AllDebrid en plein vol laisserait un magnet
    // depose sur le compte, sans retrait.
    const m = await service('torbox', cle).verifierCache([hash], AbortSignal.timeout(12000));
    const etat = m.get(hash) ?? 'inconnu';
    poserEtatCache(req.session!.userId, hash, 'torbox', etat);
    // Contrairement a AllDebrid, cette verification ne depose rien : le message doit le
    // dire, sans quoi l'utilisateur croirait avoir touche a son compte.
    const message =
      etat === 'inconnu'
        ? "TorBox n'a pas repondu. Rien n'a ete depose ; reessayez dans un moment."
        : 'Consultation en lecture seule : rien n a ete depose sur votre compte.';
    res.json({ etat, retire: null, message });
  });

  /**
   * Lien de telechargement pour une release en LIEN DIRECT.
   *
   * Le repli sur un autre hebergeur est la norme, pas l'exception : sur une fiche, un
   * lien sur deux peut etre mort. On essaie donc celui demande, puis les suivants que le
   * service accepte — et on DIT lequel a finalement repondu, pour ne jamais laisser
   * croire que le fichier vient de la ou il avait ete demande.
   */
  r.post('/api/debrid/lien-direct', exigerConnexion, exigerCsrf, async (req, res) => {
    let nom: NomService;
    try {
      nom = choisirService((req.body as Record<string, unknown> | undefined)?.service);
    } catch (e) { res.status(400).json({ erreur: (e as Error).message }); return; }

    const identite = String((req.body as Record<string, unknown> | undefined)?.identite ?? '');
    const depuis = Number((req.body as Record<string, unknown> | undefined)?.index ?? 0);
    const decoupe = estIdentiteDdl(identite) ? decouperIdentite(identite) : null;
    if (!decoupe) { res.status(400).json({ erreur: 'identite invalide' }); return; }

    const cles = clesEnClair(db, req.session!.userId, req.session!.dek);
    const cle = nom === 'alldebrid' ? cles.ad : cles.tb;
    if (!cle) { res.status(400).json({ erreur: `aucune cle ${nom} enregistree` }); return; }

    const liens = await ouvrirFicheWawacity(decoupe.id);
    if (!liens?.length) { res.status(502).json({ erreur: 'la fiche n a pas pu etre ouverte' }); return; }

    const supportes = await hotesSupportes(nom, cle);
    // On commence par celui demande, puis on parcourt les autres.
    const ordre = [...liens.keys()].sort((a, b) => (a === depuis ? -1 : b === depuis ? 1 : a - b));
    const essayes: string[] = [];

    for (const i of ordre) {
      const l = liens[i];
      if (estMort(l.url)) continue;
      if (!hoteExploitable(l.hebergeur, supportes)) continue;
      essayes.push(l.hebergeur);
      const url = await resoudreDdl(l.url, nom, cle);
      if (url) {
        res.json({
          url,
          hebergeur: l.hebergeur,
          // Vrai si l'on a du changer d'hebergeur : l'interface doit le dire.
          repli: i !== depuis,
          essayes,
        });
        return;
      }
    }

    res.status(502).json({
      erreur: essayes.length === 0
        ? `aucun hebergeur de cette fiche n est pris en charge par ${nom}`
        : `aucun lien n a repondu (${essayes.join(', ')})`,
      essayes,
    });
  });

  /**
   * DEPOSER : mettre la release sur le compte, et l y laisser.
   *
   * A ne pas confondre avec « verifier », qui depose puis RETIRE — c'est une
   * consultation. Ici on ajoute pour de bon, et le debrideur telecharge.
   *
   * Un depot porte sur la RELEASE ENTIERE, jamais sur une selection : rien dans le
   * .torrent envoye ne dit quels fichiers nous interessent, donc le debrideur les prend
   * tous. Proposer un depot par tome promettrait un choix qui n existe pas.
   */
  r.post('/api/debrid/deposer', exigerConnexion, exigerCsrf, async (req, res) => {
    const d = resoudreDemande(db, req);
    if (estErreur(d)) { res.status(d.code).json({ erreur: d.erreur }); return; }
    const { nom, hash, cle } = d;

    // Signal H&R : etat de cache connu AVANT le depot (jamais un 2e depot AllDebrid).
    const etatAvant = etatCacheMemorise(req.session!.userId, hash, nom);

    const svc = service(nom, cle);
    // Le .torrent porte l annonceur : sans lui, un torrent de tracker prive reste inerte.
    const torrentUrl = lienMemorise(req.session!.userId, hash);
    const id = await svc.deposer(hash, torrentUrl);
    if (!id) {
      res.status(502).json({ erreur: `${nom} n a pas accepte le depot` });
      return;
    }

    // Le depot vient de changer la reponse a « est-ce en cache ? ».
    oublierEtatCache(req.session!.userId, hash);

    // Seed anti-H&R : c'est ICI, sur le geste DELIBERE « Deposer », qu'on couvre le H&R
    // (et seulement si le download etait frais, cf. peutEtreSeeder). PAS sur /liens, qui
    // n'est qu'un effet de bord « obtenir les liens ». Best-effort ABSOLU : ne casse
    // jamais la reponse du depot.
    let rustatio: { statut: 'seede' | 'echec' | 'ignore'; raison?: string };
    try {
      rustatio = await peutEtreSeeder(db, req, hash, torrentUrl, etatAvant);
    } catch (e) {
      tracer('Rustatio', `seed anti-H&R : exception (${(e as Error).name})`);
      rustatio = { statut: 'echec', raison: 'exception' };
    }

    // On ne PRETEND PAS que c est pret : un torrent non cache met des minutes a
    // descendre. On dit ce qui est vrai — il est sur le compte — et l utilisateur
    // verifiera.
    res.json({
      depose: true,
      service: nom,
      avecTorrent: Boolean(torrentUrl),
      rustatio,
    });
  });

  /** Liens de telechargement, UNIQUEMENT pour les fichiers coches. */
  r.post('/api/debrid/liens', exigerConnexion, exigerCsrf, async (req, res) => {
    const d = resoudreDemande(db, req);
    if (estErreur(d)) { res.status(d.code).json({ erreur: d.erreur }); return; }
    const { nom, hash, cle } = d;

    const voulus = Array.isArray(req.body?.fichiers) ? req.body.fichiers.map(String) : [];
    if (voulus.length === 0) { res.status(400).json({ erreur: 'aucun fichier demande' }); return; }

    const svc = service(nom, cle);
    const id = (await svc.trouver(hash)) || (await svc.deposer(hash));
    if (!id) { res.status(502).json({ erreur: refusDepot(nom) }); return; }
    if (!id) {
      res.status(502).json({ erreur: `${nom} n a pas pu ouvrir cette release` });
      return;
    }

    // Le depot vient de changer la reponse a « est-ce en cache ? ». Ce qu'on croyait
    // savoir est devenu faux : on l'oublie, pour que la prochaine verification interroge
    // reellement le service au lieu de repeter un « absent » perime.
    oublierEtatCache(req.session!.userId, hash);

    const cotesDebrid: FichierDebride[] = await svc.listerFichiers(id);
    const apparies = apparierDebrid(cotesDebrid, voulus);

    // Deverrouillage a la demande : les liens expirent, en fabriquer 108 pour trois
    // fichiers coches serait du gaspillage pur.
    const liens: { nom: string; url: string }[] = [];
    for (const f of apparies) {
      if (f.id === undefined) continue;
      const url = await svc.lienFichier(id, f.id);
      if (url) liens.push({ nom: f.nom, url });
    }

    // Pas de seed ici : /liens n'est qu'un effet de bord « obtenir les liens ». Le seed
    // anti-H&R vit sur le geste DELIBERE /deposer.
    res.json({ liens, demandes: voulus.length, resolus: liens.length });
  });

  /** Archive cote debrideur. 404 quand le service ne sait pas le faire. */
  r.post('/api/debrid/zip', exigerConnexion, exigerCsrf, async (req, res) => {
    const d = resoudreDemande(db, req);
    if (estErreur(d)) { res.status(d.code).json({ erreur: d.erreur }); return; }
    const { nom, hash, cle } = d;

    const svc = service(nom, cle);
    if (!svc.supporteZip) {
      res.status(404).json({ erreur: `${nom} ne sait pas produire d archive` });
      return;
    }
    const id = (await svc.trouver(hash)) || (await svc.deposer(hash));
    if (!id) { res.status(502).json({ erreur: refusDepot(nom) }); return; }
    const url = await svc.lienZip(id);
    if (!url) { res.status(502).json({ erreur: 'archive indisponible' }); return; }
    res.json({ url });
  });

  return r;
}
