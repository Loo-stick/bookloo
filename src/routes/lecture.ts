// Lecture en ligne d'un CBZ.
//
// LA REGLE QUI COMMANDE CE FICHIER : on ne lit que ce qui est DEJA EN CACHE. Aucune
// lecture ne doit declencher un telechargement chez le debrideur, et cette garantie est
// tenue par le code, pas par l'interface — une route appelee a la main sur une release
// non cachee est refusee.
//
// Le laissez-passer est le verdict de cache deja obtenu (`core/liens-torrent.ts`). Chez
// TorBox il vient d'une consultation gratuite ; chez AllDebrid, d'un clic explicite de
// l'utilisateur. Le redemander ici aurait ete, chez AllDebrid, un depot de plus.

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import { etatCacheMemorise, lienMemorise } from '../core/liens-torrent';
import { tracer } from '../core/journal';
import { ecrivainNdjson } from '../core/flux';
import { clesEnClair } from '../auth/cles-utilisateur';
import { exigerConnexion } from '../auth/garde';
import { service, type NomService } from '../debrid';
import { resoudreDdl } from '../debrid/ddl';
import { estMort } from '../debrid/liens-morts';
import { hoteExploitable, hotesSupportes } from '../debrid/hosts';
import { ouvrirFicheWawacity } from '../sources/ddl/wawacity';
import type { EtatCache } from '../debrid/types';
import { ouvrirDistant } from '../lecture/plages';
import { poserSommaire, sommaireMemorise, type CbzOuvert } from '../lecture/sommaires';
import {
  ErreurZip, lireEntree, lireSommaire, inspecterZip, lecteurDeEntree,
} from '../lecture/zip';
import { lireCheminImbrique } from '../lecture/chemin-imbrique';
import { choisirParChemin } from './appariement';
import { formatRar, sommaireRar, type Avancee } from '../lecture/rar';
import type { LecteurPlage } from '../lecture/zip';
import { estIdentiteTelegram, urlFichier, enTetesFacade } from '../sources/telegram/facade';

const RE_HASH = /^[a-f0-9]+$/;
const estHash = (h: string) => RE_HASH.test(h) && h.length === 40;

/**
 * Budget d'ouverture d'une archive.
 *
 * Deliberement inferieur au delai des proxys : Cloudflare coupe vers 100 s et rend
 * alors une page HTML, que le navigateur ne sait pas lire comme du JSON. Mieux vaut
 * echouer nous-memes, avec un message qui dit quoi faire.
 */
const BUDGET_OUVERTURE_MS = 45000;
/**
 * Le budget de la route EN FLUX.
 *
 * Quatre minutes la ou l'autre en accorde quarante-cinq secondes. Ce n'est pas de la
 * generosite : une preparation RAR mesuree a 66 s pour 189 planches se ferait couper par
 * les 45 s, et un pack de 500 planches demanderait trois minutes. Le budget de `/sommaire`
 * protege contre un debrideur MUET ; ici l'avancee est visible a chaque instant, et une
 * attente que l'on voit avancer n'est pas la meme chose qu'une attente aveugle.
 */
const BUDGET_PREPARATION_MS = 4 * 60 * 1000;

const MIMES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
  gif: 'image/gif',
};

/**
 * Type deduit du NOM. Ne sert que de repli.
 *
 * Mesure du 2026-08-20 sur une vraie release : les planches s'appellent « 1153-001.png »
 * et contiennent du JPEG. Le nom de fichier ne dit donc pas le format.
 */
export function typeMime(nom: string): string {
  const ext = (nom.split('.').pop() || '').toLowerCase();
  // On n'invente pas un type : sans correspondance, le navigateur se debrouille mieux
  // qu'une supposition.
  return MIMES[ext] ?? 'application/octet-stream';
}

/** Type lu dans les octets. Ce sont eux qui font foi. */
export function typeReel(octets: Buffer, nom: string): string {
  if (octets.length >= 8) {
    if (octets[0] === 0xff && octets[1] === 0xd8) return 'image/jpeg';
    if (octets.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      return 'image/png';
    }
    if (octets.subarray(0, 6).toString('latin1').startsWith('GIF8')) return 'image/gif';
    const conteneur = octets.subarray(0, 12).toString('latin1');
    if (conteneur.startsWith('RIFF') && conteneur.slice(8, 12) === 'WEBP') return 'image/webp';
    if (octets.subarray(4, 12).toString('latin1').startsWith('ftypavif')) return 'image/avif';
  }
  return typeMime(nom);
}

export interface VerdictLecture {
  ok: boolean;
  code?: number;
  message?: string;
}

/** Fonction pure : c'est elle qui porte la garantie « rien hors cache ». */
export function verdictLecture(etat: EtatCache): VerdictLecture {
  if (etat === 'en-cache') return { ok: true };
  if (etat === 'absent') {
    return {
      ok: false,
      code: 409,
      message: "cette release n'est pas en cache : la lire imposerait de la telecharger",
    };
  }
  return {
    ok: false,
    code: 409,
    message: "etat de cache inconnu : verifiez d'abord cette release sur ce service",
  };
}

/** Traduit une erreur de format en statut, sans jamais masquer le motif. */
function statutDe(e: ErreurZip): { code: number; message: string } {
  switch (e.code) {
    case 'pas-un-zip':
      return { code: 415, message: 'ce fichier n est pas lisible en ligne, telechargez-le' };
    case 'zip64':
      return { code: 501, message: 'archive ZIP64, non prise en charge par la visionneuse' };
    case 'sans-image':
      return { code: 422, message: 'cette archive ne contient aucune image' };
    default:
      return { code: 415, message: 'archive illisible' };
  }
}

/**
 * Union DISCRIMINEE, et pas un simple elargissement de `NomService`.
 *
 * Deux raisons. `NomService` est le type des DEBRIDEURS : y ajouter 'telegram' le
 * rendrait faux partout ailleurs. Et le discriminant permet a TypeScript de savoir qu'une
 * demande Telegram n'a pas de cle a passer a `service()` — la garantie devient
 * structurelle au lieu de reposer sur l'ordre des tests.
 */
export type Demande =
  | { nom: NomService; cle: string; hash: string; fichier: string }
  | { nom: 'telegram'; cle: ''; hash: string; fichier: string };

export function resoudreDemande(
  db: Database,
  userId: number,
  dek: Buffer,
  params: { hash?: string },
  query: Record<string, unknown>,
  /**
   * `fichierRequis: false` pour une demande qui porte sur la RELEASE et non sur un
   * fichier — le sommaire d'un livre audio, qui doit justement lister ce qu'elle
   * contient. Le defaut reste l'exigence : toutes les autres surfaces ouvrent un
   * fichier nomme, et l'oublier y serait un bug.
   */
  options: { fichierRequis?: boolean } = {},
): Demande | VerdictLecture {
  const fichierRequis = options.fichierRequis !== false;
  const brut = String(params.hash ?? '');

  // Telegram EN PREMIER, avant meme la validation de forme.
  //
  // Une release Telegram ne passe par aucun debrideur : ni cache a verifier, ni cle a
  // dechiffrer. Mais la raison de le tester ICI est plus terre a terre — le garde-fou
  // ci-dessous n'accepte qu'un hash ou une identite `ddl:`, et rejetait `tg:` avec
  // « identite invalide » avant que la branche Telegram soit atteinte.
  if (estIdentiteTelegram(brut)) {
    const fichierTg = String(query.fichier ?? '').trim();
    if (fichierRequis && !fichierTg) {
      return { ok: false, code: 400, message: 'aucun fichier demande' };
    }
    return { nom: 'telegram', cle: '', hash: brut, fichier: fichierTg };
  }

  const estDdl = /^ddl:[a-z0-9-]+:[A-Za-z0-9_-]+$/.test(brut);
  const hash = estDdl ? brut : brut.toLowerCase();
  if (!estDdl && !estHash(hash)) return { ok: false, code: 400, message: 'identite invalide' };

  const nom = String(query.service ?? '');
  if (nom !== 'alldebrid' && nom !== 'torbox') {
    return { ok: false, code: 400, message: 'service debrid inconnu ou absent' };
  }

  const fichier = String(query.fichier ?? '').trim();
  if (fichierRequis && !fichier) {
    return { ok: false, code: 400, message: 'aucun fichier demande' };
  }

  // Une release en lien direct n'a pas d'etat de cache : sa disponibilite ne depend pas
  // du debrideur mais de l'hebergeur, et c'est verifie a l'ouverture de la fiche.
  if (!estDdl) {
    const verdict = verdictLecture(etatCacheMemorise(userId, hash, nom));
    if (!verdict.ok) return verdict;
  }

  const cles = clesEnClair(db, userId, dek);
  const cle = nom === 'alldebrid' ? cles.ad : cles.tb;
  if (!cle) return { ok: false, code: 400, message: `aucune cle ${nom} enregistree` };

  return { nom, cle, hash, fichier };
}

export function estVerdict(x: Demande | VerdictLecture): x is VerdictLecture {
  return (x as VerdictLecture).ok !== undefined;
}

/** Ouvre le CBZ distant et rend son sommaire, en le memorisant. */
async function obtenirSommaire(
  userId: number, d: Demande, avancee?: Avancee,
): Promise<CbzOuvert> {
  // Le fichier deja ouvert porte son sommaire ET son lien : tourner une page ne coute
  // alors qu'une requete de plage, au lieu de quatre allers-retours au debrideur.
  const memorise = sommaireMemorise(userId, d.hash, d.fichier);
  if (memorise) return memorise;

  // Release en LIEN DIRECT : le lecteur par plages ne change pas, seule la facon
  // d'obtenir le lien differe. Mesure du 2026-08-20 : un lien debride accepte Range et
  // le contenu est un CBZ.
  // On dispatche sur le NOM, pas sur la forme du hash : c'est la decision deja prise par
  // `resoudreDemande`, et c'est ce qui permet a TypeScript de garantir qu'aucune cle de
  // debrideur n'est attendue sur ce chemin.
  if (d.nom === 'telegram') return ouvrirTelegram(userId, d, avancee);

  if (d.hash.startsWith('ddl:')) return ouvrirDdl(userId, d, avancee);

  const distant = await ouvrirDistantDebrid(userId, d);

  // UN TOME DANS UNE ARCHIVE. La release peut n'etre qu'un seul ZIP contenant les tomes —
  // mesure du 2026-08-28 : « One.Piece.[T01.T105]…CHROMATIQUE » est un .zip de 15,3 Go, pas
  // cent cinq CBZ. Les octets du tome y sont contigus, donc on lit le CBZ interieur PAR
  // PLAGES, a travers un simple decalage d'offset : rien de plus n'est telecharge, et
  // l'archive n'est jamais chargee.
  const imbrique = lireCheminImbrique(d.fichier);
  if (imbrique) {
    const { archives } = await inspecterZip(distant.lire, distant.taille);
    const entree = archives.find((e) => e.nom === imbrique.interne);
    if (!entree) throw new Error('ce tome n est pas dans cette archive');

    const lireDedans = await lecteurDeEntree(distant.lire, entree);
    const sommaireInterne = await sommaireArchive(lireDedans, entree.tailleReelle, avancee);
    const ouvertInterne = {
      sommaire: sommaireInterne,
      distant: { ...distant, lire: lireDedans, taille: entree.tailleReelle },
    };
    poserSommaire(userId, d.hash, d.fichier, ouvertInterne);
    return ouvertInterne;
  }

  const sommaire = await sommaireArchive(distant.lire, distant.taille, avancee);
  const ouvert = { sommaire, distant };
  poserSommaire(userId, d.hash, d.fichier, ouvert);
  return ouvert;
}

/**
 * Le sommaire d'une archive de bande dessinee, ZIP ou RAR.
 *
 * LE FORMAT SE DECIDE A L'ENTREE, jamais en aval : au-dela d'ici, tout travaille sur un
 * `SommaireCbz` sans savoir d'ou il vient — service d'une planche, visionneuse,
 * prechargement. C'est la meme decision que pour Telegram et les liens directs.
 *
 * On essaie le ZIP d'abord : c'est de loin le cas le plus courant, et son erreur
 * « pas-un-zip » a deja identifie le format reel au passage.
 *
 * Un CBR se lit PAR PLAGES comme un CBZ : ses JPEG sont deja compresses, donc presque
 * toujours STOCKES dans l'archive, donc contigus. Rien n'est decompresse ni charge.
 */
export async function sommaireArchive(lire: LecteurPlage, taille: number, avancee?: Avancee) {
  try {
    return await lireSommaire(lire, taille);
  } catch (e) {
    if (!(e instanceof ErreurZip) || e.code !== 'pas-un-zip') throw e;
    if (!formatRar(await lire(0, 7))) throw e;
    // SEUL LE RAR RAPPORTE SON AVANCEE, et c'est voulu : un ZIP se resume en deux ou trois
    // lectures, une barre de progression y clignoterait sans rien apprendre.
    return sommaireRar(lire, taille, avancee);
  }
}

/**
 * Le fichier distant d'une release debridee, SANS en lire le sommaire.
 *
 * Separe de `obtenirSommaire` parce qu'un EPUB n'a pas de sommaire de planches :
 * `lireSommaire` refuse une archive sans image, ce qui est juste pour la visionneuse et
 * faux pour un livre. La liseuse a besoin du meme fichier distant, et d'aucun sommaire.
 */
export async function ouvrirDistantDebrid(
  userId: number,
  d: Extract<Demande, { nom: NomService }>,
) {
  const svc = service(d.nom, d.cle);
  // LIRE NE JUSTIFIE PAS D'ALLER CHERCHER LE .torrent. Le recuperer enregistre un
  // telechargement chez le tracker, et son annonceur porte le passkey : le debrideur
  // leeche ensuite au nom de l'utilisateur. Ce geste appartient au depot explicite.
  const id = (await svc.trouver(d.hash)) || (await svc.deposer(d.hash));
  if (!id) {
    throw new Error(
      `${d.nom} n a pas pu ouvrir cette release a partir de son empreinte seule. Si elle `
      + "n'est pas dans son cache, il lui faut le fichier .torrent : utilisez « Deposer ».",
    );
  }

  const fichiers = await svc.listerFichiers(id);
  // LE DEBRIDEUR NE CONNAIT QUE L'ARCHIVE. Sur un chemin imbrique — « pack.zip!/Tome 03.cbz »
  // — c'est le ZIP qu'il faut lui demander ; le CBZ vit a l'interieur, et on l'y lira par
  // plages. Chercher le nom interne ici rendait « fichier introuvable dans cette release ».
  const imbrique = lireCheminImbrique(d.fichier);
  const demande = imbrique ? imbrique.archive : d.fichier;
  // LE CHEMIN COMPLET D'ABORD. Deux fichiers de meme nom dans des dossiers differents se
  // confondaient sur le seul nom de base : mauvais tome affiche, progression enregistree
  // sur le mauvais contenu. Signale par une revue de code le 2026-08-29.
  const cible = choisirParChemin(fichiers, demande);
  if (!cible || cible.id === undefined) throw new Error('fichier introuvable dans cette release');

  return ouvirDistantDe(() => svc.lienFichier(id, cible.id as string | number));
}

function ouvirDistantDe(resoudre: () => Promise<string | null>) {
  return ouvrirDistant({ resoudre });
}

/**
 * Ouvre une release Telegram.
 *
 * La facade parle HTTP Range : `ouvrirDistant` ne fait donc rien de particulier ici, il
 * lit une URL comme une autre. C'est toute la valeur de la decision prise en conception —
 * ni `plages.ts` ni `zip.ts` ne savent que Telegram existe.
 *
 * AUCUN DEBRIDEUR n'est sollicite : pas de depot, pas de verification de cache, pas de
 * cle a dechiffrer. C'est la premiere source du projet dans ce cas.
 */
async function ouvrirTelegram(
  userId: number,
  d: Extract<Demande, { nom: 'telegram' }>,
  avancee?: Avancee,
): Promise<CbzOuvert> {
  const url = urlFichier(d.hash);
  const distant = await ouvrirDistant({
    resoudre: async () => url,
    enTetes: enTetesFacade(),
  });
  const sommaire = await sommaireArchive(distant.lire, distant.taille, avancee);
  const ouvert = { sommaire, distant };
  poserSommaire(userId, d.hash, d.fichier, ouvert);
  return ouvert;
}

/** Ouvre une release en lien direct : resolution DDL au lieu de depot de torrent. */
async function ouvrirDdl(
  userId: number,
  // Jamais une demande Telegram : le dispatch l'a deja ecartee, et le type le dit — cette
  // fonction a besoin d'un service debrideur et d'une cle.
  d: Extract<Demande, { nom: NomService }>,
  avancee?: Avancee,
): Promise<CbzOuvert> {
  const m = d.hash.match(/^ddl:([a-z0-9-]+):([A-Za-z0-9_-]+)$/);
  if (!m || m[1] !== 'wawacity') throw new Error('identite de lien direct invalide');

  const liens = await ouvrirFicheWawacity(m[2]);
  if (!liens?.length) throw new Error('la fiche n a pas pu etre ouverte');

  const supportes = await hotesSupportes(d.nom, d.cle);
  const utilisables = liens.filter((l) => !estMort(l.url) && hoteExploitable(l.hebergeur, supportes));
  if (utilisables.length === 0) {
    throw new Error(`aucun hebergeur de cette fiche n est pris en charge par ${d.nom}`);
  }

  // `resoudre` est rappelee si le lien expire en cours de lecture : elle reparcourt les
  // hebergeurs, ce qui rend la reprise transparente meme si celui d'origine meurt.
  const resoudre = async (): Promise<string | null> => {
    for (const l of utilisables) {
      if (estMort(l.url)) continue;
      const url = await resoudreDdl(l.url, d.nom, d.cle);
      if (url) return url;
    }
    return null;
  };

  const distant = await ouvrirDistant({ resoudre });
  const sommaire = await sommaireArchive(distant.lire, distant.taille, avancee);
  const ouvert = { sommaire, distant };
  poserSommaire(userId, d.hash, d.fichier, ouvert);
  return ouvert;
}

/** Echoue avant le proxy plutot que de le laisser rendre une page HTML. */
function avecBudget<T>(travail: Promise<T>, budget = BUDGET_OUVERTURE_MS): Promise<T> {
  return Promise.race([
    travail,
    new Promise<T>((_, rejeter) =>
      setTimeout(
        () => rejeter(new Error(
          'le debrideur met trop longtemps a ouvrir cette release — reessayez dans un moment',
        )),
        budget,
      ).unref(),
    ),
  ]);
}

function repondreErreur(res: Parameters<Parameters<Router['get']>[1]>[1], e: unknown): void {
  if (e instanceof ErreurZip) {
    const { code, message } = statutDe(e);
    res.status(code).json({ erreur: message, code: e.code });
    return;
  }
  tracer('Lecture', (e as Error).message);
  res.status(502).json({ erreur: (e as Error).message });
}

export function routesLecture(db: Database): Router {
  const r = Router();

  r.get('/api/lecture/:hash/sommaire', exigerConnexion, async (req, res) => {
    const d = resoudreDemande(db, req.session!.userId, req.session!.dek, req.params, req.query);
    if (estVerdict(d)) {
      res.status(d.code ?? 400).json({ erreur: d.message });
      return;
    }
    try {
      const { sommaire } = await avecBudget(obtenirSommaire(req.session!.userId, d));
      res.json({ nbPages: sommaire.pages.length, pages: sommaire.pages, titre: d.fichier });
    } catch (e) {
      repondreErreur(res, e);
    }
  });

  /**
   * Le sommaire, EN FLUX, avec l'avancee de la preparation.
   *
   * POURQUOI UNE SECONDE ROUTE. Un ZIP se resume en deux ou trois lectures : son
   * repertoire central vit en fin de fichier et annonce tout d'un coup. Un RAR n'a pas de
   * repertoire — ses en-tetes sont entrelaces avec les donnees, et la position de chacun
   * ne se deduit que du precedent. Le parcours est donc STRICTEMENT SEQUENTIEL, une
   * requete de plage par entree, et rien ne peut le paralleliser.
   *
   * MESURE DU 2026-08-31, a travers la facade Telegram, sur « I''s T01 (Katsura) » — 287 Mo,
   * 189 planches : 197 requetes, 256 Ko, 65,9 secondes. Le debit de la facade plafonne a
   * 290 Ko/s, et une plage coute 300 ms de latence quoi qu'on demande.
   *
   * Soixante-six secondes derriere un bouton muet, c'est un bouton casse. Soixante-six
   * secondes avec une barre qui avance, c'est une attente. D'ou cette route : la meme
   * preparation, mais qui dit ou elle en est.
   *
   * LE BUDGET Y EST PLUS LARGE QUE SUR `/sommaire`, et c'est justifie : les 45 secondes de
   * l'autre route existent pour qu'un debrideur muet ne fasse pas patienter sans fin.
   * Ici l'avancee est visible, donc l'attente est informee — et le client peut couper.
   */
  r.get('/api/lecture/:hash/sommaire/flux', exigerConnexion, async (req, res) => {
    const d = resoudreDemande(db, req.session!.userId, req.session!.dek, req.params, req.query);
    if (estVerdict(d)) {
      res.status(d.code ?? 400).json({ erreur: d.message });
      return;
    }

    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Accel-Buffering', 'no');
    const ecrivain = ecrivainNdjson(res);

    // UNE LIGNE TOUTES LES 250 MS AU PLUS. Un en-tete par requete de plage, c'est jusqu'a
    // trois avancees par seconde sur un lien rapide — mais sur un pack de plusieurs
    // milliers d'entrees ce serait un flot inutile. L'oeil ne lit pas plus vite.
    let dernier = 0;
    const avancee: Avancee = (parcourus, total, entrees) => {
      const maintenant = Date.now();
      if (maintenant - dernier < 250) return;
      dernier = maintenant;
      // `ecrire` ecrit SYNCHRONEMENT dans le flux avant tout `await` : l'ordre des lignes
      // est donc garanti, meme sans attendre la promesse.
      void ecrivain.ecrire({
        type: 'progres',
        fraction: total > 0 ? Math.min(1, parcourus / total) : 0,
        entrees,
      });
    };

    try {
      const { sommaire } = await avecBudget(
        obtenirSommaire(req.session!.userId, d, avancee),
        BUDGET_PREPARATION_MS,
      );
      await ecrivain.ecrire({
        type: 'pret', nbPages: sommaire.pages.length, pages: sommaire.pages, titre: d.fichier,
      });
    } catch (e) {
      if (e instanceof ErreurZip) {
        const { message } = statutDe(e);
        await ecrivain.ecrire({ type: 'erreur', erreur: message, code: e.code });
      } else {
        tracer('Lecture', (e as Error).message);
        await ecrivain.ecrire({ type: 'erreur', erreur: (e as Error).message });
      }
    }
    ecrivain.terminer();
  });

  r.get('/api/lecture/:hash/page/:n', exigerConnexion, async (req, res) => {
    const d = resoudreDemande(db, req.session!.userId, req.session!.dek, req.params, req.query);
    if (estVerdict(d)) {
      res.status(d.code ?? 400).json({ erreur: d.message });
      return;
    }
    const n = Number(req.params.n);
    if (!Number.isInteger(n) || n < 0) {
      res.status(400).json({ erreur: 'numero de planche invalide' });
      return;
    }
    try {
      const { sommaire, distant } = await avecBudget(obtenirSommaire(req.session!.userId, d));
      const entree = sommaire.entrees[n];
      if (!entree) {
        res.status(404).json({ erreur: `cette archive n a pas de planche ${n + 1}` });
        return;
      }
      const octets = await lireEntree(distant.lire, entree);
      res.setHeader('Content-Type', typeReel(octets, entree.nom));
      // Privee : le contenu appartient a l'utilisateur. Le cache navigateur est ce qui
      // rend le retour en arriere gratuit et la precharge efficace.
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.send(octets);
    } catch (e) {
      repondreErreur(res, e);
    }
  });

  return r;
}
