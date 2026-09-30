// Lecture d'un fichier distant par plages d'octets.
//
// SEUL POINT RESEAU de la lecture. Tout le decodage vit dans `zip.ts`, qui ne connait
// que la fonction rendue ici — c'est cette separation qui rend le ZIP testable sans
// debrideur.
//
// Mesure du 2026-08-20 : les liens debrides repondent `Accept-Ranges: bytes` et rendent
// un 206 avec les octets exacts. C'est ce qui permet de lire une planche au milieu d'un
// tome de 350 Mo sans rien telecharger.
//
// LES LIENS EXPIRENT. Une lecture de cent planches dure plus longtemps qu'un lien de
// debrideur. Un 401, 403 ou 410 declenche donc UNE re-resolution puis un seul nouvel
// essai — sans quoi la lecture casse en plein milieu, sans rien expliquer.

import axios from 'axios';
import { tracer } from '../core/journal';
import type { LecteurPlage } from './zip';

/** Plafond par plage. Une planche depasse rarement 5 Mo ; au-dela, quelque chose cloche. */
const MAX_PLAGE_OCTETS = 16 * 1024 * 1024;
const TIMEOUT_MS = 20000;

export interface SourceDistante {
  /** Rend un lien frais. Appelee a l'ouverture, et une fois de plus si le lien expire. */
  resoudre: () => Promise<string | null>;
  /**
   * En-tetes a joindre a CHAQUE requete, HEAD comprise.
   *
   * Un lien debride s'authentifie par son URL ; la facade Telegram, elle, exige un
   * secret en en-tete. Sans ce champ il aurait fallu un second lecteur de plages — pour
   * une difference qui tient en trois lignes.
   */
  enTetes?: Record<string, string>;
  /**
   * Pour un serveur LENT MAIS VIVANT : on ne coupe que s'il se TAIT `inactiviteMs`, et en
   * aucun cas au-dela de `totalMs`.
   *
   * Mesure du 2026-09-15 sur le CDN de LibGen : 24 a 400 Ko/s selon le moment, un Mo en
   * 16 a 25 secondes. Le delai TOTAL de vingt secondes coupait donc des transferts qui
   * avancaient — « timeout of 20000ms exceeded » sur une planche qui serait arrivee.
   * Sans cette option, rien ne change : le delai total reste la regle.
   */
  patience?: { inactiviteMs: number; totalMs: number };
}

export interface FichierDistant {
  taille: number;
  lire: LecteurPlage;
}

const EXPIRE = new Set([401, 403, 410]);

/**
 * Le contenu REELLEMENT demande, selon que le serveur a honore la plage ou non.
 *
 * Un 206 rend la plage : on la prend telle quelle. Un 200 signifie que le serveur a IGNORE
 * l'en-tete Range et renvoie le fichier entier depuis l'octet zero — c'est le cas de
 * certains CDN, deja documente pour Z-Library ailleurs dans ce projet. Traiter ce tampon
 * comme s'il commencait a `debut` decale tout le parsing et sert une planche corrompue,
 * sans le moindre signal d'erreur. Signale par une revue de code le 2026-08-29.
 */
export function trancherReponse(
  statut: number,
  corps: Buffer,
  debut: number,
  fin: number,
): Buffer {
  if (statut === 206) return corps;
  // Le corps ne va meme pas jusqu'au debut demande : il n'y a rien a rendre, et un tampon
  // vide serait pris pour une fin de fichier.
  if (corps.length <= debut) {
    throw new Error('le serveur ne honore pas les plages et la reponse est trop courte');
  }
  return corps.subarray(debut, Math.min(fin + 1, corps.length));
}

export async function ouvrirDistant(source: SourceDistante): Promise<FichierDistant> {
  let url = await source.resoudre();
  if (!url) throw new Error('aucun lien de telechargement obtenu');

  const enTetes = source.enTetes ?? {};
  const tete = await axios.head(url, {
    headers: enTetes, timeout: TIMEOUT_MS, validateStatus: () => true,
  });
  const taille = Number(tete.headers['content-length']);
  if (!Number.isFinite(taille) || taille <= 0) {
    throw new Error('le serveur de fichiers n a pas annonce de taille');
  }

  // Une seule re-resolution par lecteur : si le second lien echoue aussi, le probleme
  // n'est pas l'expiration, et reessayer sans fin ne ferait que masquer la panne.
  let dejaReresolu = false;

  const demander = async (debut: number, fin: number): Promise<{ status: number; data: Buffer }> => {
    const headers = { ...enTetes, Range: `bytes=${debut}-${fin}` };
    if (source.patience) return demanderAvecPatience(url as string, headers, source.patience);
    const res = await axios.get<ArrayBuffer>(url as string, {
      headers,
      responseType: 'arraybuffer',
      timeout: TIMEOUT_MS,
      maxContentLength: MAX_PLAGE_OCTETS,
      validateStatus: () => true,
    });
    return { status: res.status, data: Buffer.from(res.data as ArrayBuffer) };
  };

  const lire: LecteurPlage = async (debut, fin) => {
    if (fin - debut + 1 > MAX_PLAGE_OCTETS) throw new Error('plage demandee trop grande');

    let res = await demander(debut, fin);

    if (EXPIRE.has(res.status) && !dejaReresolu) {
      dejaReresolu = true;
      tracer('Lecture', 'lien expire, re-resolution');
      const frais = await source.resoudre();
      if (!frais) throw new Error('aucun lien de telechargement obtenu apres expiration');
      url = frais;
      res = await demander(debut, fin);
    }

    if (res.status !== 206 && res.status !== 200) {
      throw new Error(`le serveur de fichiers a repondu ${res.status}`);
    }
    return trancherReponse(res.status, res.data, debut, fin);
  };

  return { taille, lire };
}

/**
 * Une plage lue EN FLUX, la minuterie relancee a chaque octet recu. Voir `patience`.
 *
 * Le plafond d'octets est tenu pendant la reception, pas apres : un serveur qui ignorerait
 * la plage et enverrait le fichier entier ne doit pas remplir la memoire avant d'etre coupe.
 */
async function demanderAvecPatience(
  url: string,
  headers: Record<string, string>,
  patience: { inactiviteMs: number; totalMs: number },
): Promise<{ status: number; data: Buffer }> {
  const controleur = new AbortController();
  let raison: string | null = null;
  const couper = (pourquoi: string) => { raison = raison ?? pourquoi; controleur.abort(); };
  const muet = () => `le serveur de fichiers n envoie plus rien depuis ${Math.round(patience.inactiviteMs / 1000)} s`;
  let silence = setTimeout(() => couper(muet()), patience.inactiviteMs);
  const plafond = setTimeout(
    () => couper(`le serveur de fichiers est trop lent : plus de ${Math.round(patience.totalMs / 1000)} s pour une plage`),
    patience.totalMs,
  );
  try {
    const res = await axios.get(url, {
      headers, responseType: 'stream', signal: controleur.signal, validateStatus: () => true,
    });
    const morceaux: Buffer[] = [];
    let recus = 0;
    await new Promise<void>((ok, ko) => {
      res.data.on('data', (morceau: Buffer) => {
        recus += morceau.length;
        if (recus > MAX_PLAGE_OCTETS) { couper('plage recue trop grande'); return; }
        morceaux.push(morceau);
        clearTimeout(silence);
        silence = setTimeout(() => couper(muet()), patience.inactiviteMs);
      });
      res.data.on('end', ok);
      res.data.on('error', ko);
      res.data.on('close', () => { if (controleur.signal.aborted) ko(new Error(raison ?? 'plage interrompue')); });
    });
    return { status: res.status, data: Buffer.concat(morceaux) };
  } catch (e) {
    if (raison) throw new Error(raison);
    throw e;
  } finally {
    clearTimeout(silence);
    clearTimeout(plafond);
  }
}
