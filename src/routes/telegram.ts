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
import type { FichierDistant } from '../lecture/plages';
import { modeDirectActif, reglagesTelegram } from '../telegram/reglages';
import { distantTelegramDirect, motifMontrable } from '../telegram/fichier';

/** Tranche ecrite a la fois : `lire` plafonne a 16 Mo, et un tome entier tuerait le conteneur. */
const TRANCHE = 4 * 1024 * 1024;

/**
 * Analyse un `Range: bytes=...` d'un seul intervalle (RFC 7233). Bornes incluses, `fin`
 * ramenee a `taille - 1`.
 *
 * `null` : pas de plage a honorer — en-tete absent, OU en-tete que l'on ne sait pas
 * interpreter (autre unite, plages multiples, syntaxe illisible), qui doit etre IGNORE : on
 * rend alors le fichier entier. `'invalide'` : syntaxiquement valide mais insatisfiable
 * (416), seul cas que ce code designe vraiment.
 */
export function analyserRange(entete: string | undefined, taille: number):
  { debut: number; fin: number } | null | 'invalide' {
  if (!entete) return null;
  const m = /^bytes=(\d*)-(\d*)$/i.exec(entete.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let debut: number;
  let fin: number;
  if (m[1] === '') { // suffixe : les N derniers octets
    const n = Number(m[2]);
    if (n <= 0) return 'invalide';
    debut = Math.max(0, taille - n);
    fin = taille - 1;
  } else {
    debut = Number(m[1]);
    fin = m[2] === '' ? taille - 1 : Math.min(Number(m[2]), taille - 1);
  }
  if (debut >= taille || fin < debut) return 'invalide';
  return { debut, fin };
}

/** Le sous-ensemble de la reponse Express dont on a besoin, pour pouvoir le simuler. */
export interface ReponseFlux {
  status(code: number): unknown;
  setHeader(nom: string, valeur: string): unknown;
  json(corps: unknown): unknown;
  write(morceau: Buffer): boolean;
  end(): unknown;
  on(evenement: string, f: () => void): unknown;
  off(evenement: string, f: () => void): unknown;
  destroyed: boolean;
  writable: boolean;
}

/**
 * Sert un fichier lu PAR PLAGES (mode direct) en honorant le `Range` du navigateur, par
 * tranches et avec contre-pression : rien n'est tamponne en memoire, et un onglet ferme
 * arrete la lecture.
 */
export async function servirFichierDirect(
  enteteRange: string | undefined, res: ReponseFlux, distant: FichierDistant, nom: string,
  methode = 'GET',
): Promise<void> {
  const { taille } = distant;
  const plage = analyserRange(enteteRange, taille);
  if (plage === 'invalide') {
    res.setHeader('Content-Range', `bytes */${taille}`);
    res.status(416);
    res.json({ erreur: 'plage demandee hors du fichier' });
    return;
  }
  const debut = plage ? plage.debut : 0;
  const fin = plage ? plage.fin : taille - 1;

  const poserEntetes = () => {
    res.status(plage ? 206 : 200);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${nomTelechargement(nom)}"`);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Length', String(taille === 0 ? 0 : fin - debut + 1));
    if (plage) res.setHeader('Content-Range', `bytes ${debut}-${fin}/${taille}`);
  };

  // UN HEAD NE LIT RIEN. Sur une reponse HEAD, Node jette les octets et `write` rend toujours
  // `true` : sans cette sortie, un simple HEAD ferait lire le fichier ENTIER a Telegram, a
  // pleine vitesse et sans contre-pression — risque de FLOOD_WAIT sur le compte de l'hebergeur.
  if (methode === 'HEAD') {
    poserEntetes();
    res.end();
    return;
  }

  // Les en-tetes de flux ne sont poses qu'APRES la premiere lecture reussie : si elle echoue,
  // la reponse d'erreur ne doit porter ni nom de fichier ni `Content-Range` mensongers.
  let posees = false;
  for (let pos = debut; pos <= fin && !res.destroyed && res.writable; pos += TRANCHE) {
    const morceau = await distant.lire(pos, Math.min(pos + TRANCHE - 1, fin));
    // La MEME condition qu'a l'entree de la boucle : entre le `await` et l'ecriture, une
    // reponse peut cesser d'etre ecrivable sans etre `destroyed` (fin de flux, socket rendue).
    if (res.destroyed || !res.writable) break;
    if (!posees) { poserEntetes(); posees = true; }
    if (!res.write(morceau)) {
      // Contre-pression : le client lit moins vite que Telegram ne repond. Un onglet ferme
      // ne declenche jamais `drain`, d'ou l'ecoute de `close`. Les DEUX ecouteurs sont retires
      // des que l'un gagne, sinon chaque tranche en laisserait un (avertissement Node et fuite).
      await new Promise<void>((ok) => {
        const fini = () => { res.off('drain', fini); res.off('close', fini); ok(); };
        res.on('drain', fini);
        res.on('close', fini);
      });
    }
  }
  if (!posees && !res.destroyed && res.writable) poserEntetes(); // fichier vide
  res.end();
}

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

export function routesTelegram(ouvrirDirect: (identite: string) => Promise<FichierDistant> = distantTelegramDirect): Router {
  const r = Router();

  r.get('/api/telegram/telechargement/:identite', exigerConnexion, async (req, res) => {
    const identite = String(req.params.identite || '');
    if (!estIdentiteTelegram(identite)) {
      res.status(400).json({ erreur: 'identite telegram invalide' });
      return;
    }
    if (modeDirectActif(reglagesTelegram())) {
      // La facade ne connait pas ces identites : les octets viennent de Telegram directement.
      try {
        const distant = await ouvrirDirect(identite);
        await servirFichierDirect(req.get('Range'), res as unknown as ReponseFlux, distant, String(req.query.nom || ''), req.method);
      } catch (e) {
        // LA MEME DECISION QUE LA VISIONNEUSE ET LA LISEUSE : `motifMontrable` rend ce que
        // l'erreur a le droit de dire, ici au navigateur ET au journal. Cette route ne sert
        // que du Telegram : ce qui n'a pas de motif n'a donc rien a dire du tout.
        const motif = motifMontrable(e);
        tracer('Telegram', motif
          ? `telechargement direct impossible (${identite}) : ${motif}`
          : `telechargement direct impossible (${identite})`);
        if (!res.headersSent) res.status(502).json({ erreur: motif ?? 'telechargement impossible' });
        else res.destroy();
      }
      return;
    }
    if (!getSettings().telegram.url) {
      res.status(404).json({ erreur: 'aucune source telegram configuree' });
      return;
    }

    try {
      // UN HEAD NE TIRE RIEN. Sans cette branche, il ouvrait le flux entier chez la facade
      // (donc chez Telegram) pour n'en rendre aucun octet. On sonde UN octet, et la taille
      // totale se lit dans `Content-Range` ; les en-tetes sont ceux qu'un GET aurait poses.
      if (req.method === 'HEAD') {
        const sonde = await axios.get(urlFichier(identite), {
          headers: { ...enTetesFacade(), Range: 'bytes=0-0' },
          responseType: 'arraybuffer',
          // LA SONDE NE VEUT QU'UN OCTET, ET IL FAUT LE LUI DIRE. `maxContentLength` vaut
          // `-1` par defaut chez axios : illimite. Une facade qui ignore le `Range` et
          // repond 200 avec le fichier entier faisait tamponner 477 Mo dans un conteneur
          // de 512 Mo (mesure : 200 Mo emis, RSS de 117 a 569 Mo) — le serveur se figeait.
          maxContentLength: 1024,
          timeout: 30000,
          maxRedirects: 0,
          validateStatus: () => true,
        });
        // SEUL UN 206 PORTE UN `Content-Range`, dont toute la suite depend. Un 200 dit que la
        // facade n'a pas honore la plage : la sonde a echoue, elle ne rend pas une taille.
        if (sonde.status !== 206) {
          res.status(sonde.status === 404 ? 404 : 502).end();
          return;
        }
        const total = /^bytes 0-0\/(\d+)$/.exec(String(sonde.headers['content-range'] || ''));
        if (!total) {
          // Sans trace, une facade qui cesse d'envoyer `Content-Range` rendait des 502
          // muets. L'identite suffit a retrouver le message : `estIdentiteTelegram` impose
          // `tg:<chiffres>:<chiffres>`, rien d'amont n'entre ici.
          tracer('Telegram', `sonde HEAD sans Content-Range exploitable (${identite})`);
          res.status(502).json({ erreur: 'telechargement impossible' });
          return;
        }
        const factice = { taille: Number(total[1]), lire: async (): Promise<Buffer> => { throw new Error('un HEAD ne lit rien'); } };
        await servirFichierDirect(req.get('Range'), res as unknown as ReponseFlux, factice,
          String(req.query.nom || ''), 'HEAD');
        return;
      }
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
