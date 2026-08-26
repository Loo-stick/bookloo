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
import { ErreurZip, lireEntree, lireSommaire } from '../lecture/zip';
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
async function obtenirSommaire(userId: number, d: Demande): Promise<CbzOuvert> {
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
  if (d.nom === 'telegram') return ouvrirTelegram(userId, d);

  if (d.hash.startsWith('ddl:')) return ouvrirDdl(userId, d);

  const distant = await ouvrirDistantDebrid(userId, d);
  const sommaire = await lireSommaire(distant.lire, distant.taille);
  const ouvert = { sommaire, distant };
  poserSommaire(userId, d.hash, d.fichier, ouvert);
  return ouvert;
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
  const id = await svc.deposer(d.hash, lienMemorise(userId, d.hash));
  if (!id) throw new Error(`${d.nom} n a pas pu ouvrir cette release`);

  const fichiers = await svc.listerFichiers(id);
  const base = (c: string) => c.split('/').pop() || c;
  const cible = fichiers.find((f) => base(f.nom) === base(d.fichier));
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
): Promise<CbzOuvert> {
  const url = urlFichier(d.hash);
  const distant = await ouvrirDistant({
    resoudre: async () => url,
    enTetes: enTetesFacade(),
  });
  const sommaire = await lireSommaire(distant.lire, distant.taille);
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
  const sommaire = await lireSommaire(distant.lire, distant.taille);
  const ouvert = { sommaire, distant };
  poserSommaire(userId, d.hash, d.fichier, ouvert);
  return ouvert;
}

/** Echoue avant le proxy plutot que de le laisser rendre une page HTML. */
function avecBudget<T>(travail: Promise<T>): Promise<T> {
  return Promise.race([
    travail,
    new Promise<T>((_, rejeter) =>
      setTimeout(
        () => rejeter(new Error(
          'le debrideur met trop longtemps a ouvrir cette release — reessayez dans un moment',
        )),
        BUDGET_OUVERTURE_MS,
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
