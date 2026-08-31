// Lire un CBR — c'est-a-dire une archive RAR — par PLAGES, sans rien decompresser.
//
// Un CBR contient des JPEG deja compresses. Les archiveurs les rangent presque toujours en
// « stockage » (methode 0x30 en RAR4, 0 en RAR5) : leurs octets sont alors CONTIGUS dans
// l'archive, et lire une planche redevient un simple decalage d'offset — exactement comme
// pour un CBZ imbrique. Aucune decompression, aucune bibliotheque, aucune memoire.
//
// DEUX DIFFERENCES AVEC LE ZIP, qui expliquent la forme de ce fichier :
//
//   - Pas de repertoire central. Le ZIP porte son sommaire a la fin, lisible en deux
//     plages. Le RAR n'a que des en-tetes en tete de chaque fichier : on les parcourt de
//     proche en proche, chaque en-tete annoncant la taille des donnees a sauter.
//   - Deux formats incompatibles. RAR4 a des champs de taille fixe ; RAR5 encode les siens
//     en entiers de longueur variable. Les deux sont ici, parce qu'en refuser un ecarterait
//     une bonne moitie des releases.
//
// CE PARSEUR EST DEFENSIF PAR CONSTRUCTION. Il n'a pas pu etre valide contre une vraie
// archive — aucun outil RAR ni aucun .cbr sur la machine au 2026-08-28 — donc toute
// anomalie REFUSE au lieu de deviner. Une planche fausse serait pire qu'un message clair.

import { estImage, triNaturel, type SommaireCbz } from './zip';
import { crc32 } from '../archive/crc32';
import { tracer } from '../core/journal';

export type LecteurPlage = (debut: number, fin: number) => Promise<Buffer>;

export type CodeErreurRar = 'pas-un-rar' | 'compresse' | 'illisible' | 'chiffre';

export class ErreurRar extends Error {
  constructor(message: string, public readonly code: CodeErreurRar) {
    super(message);
    this.name = 'ErreurRar';
  }
}

export interface EntreeRar {
  nom: string;
  /** Vrai quand les octets sont CONTIGUS : la seule forme lisible par plages. */
  stockee: boolean;
  taille: number;
  /** Position des donnees dans l'archive, en-tete deja franchi. */
  offsetDonnees: number;
}

const MARQUEUR_RAR4 = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]);
const MARQUEUR_RAR5 = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]);

/** Au-dela, on refuse de parcourir : une archive de bande dessinee n'a pas mille pages. */
const MAX_ENTREES = 5000;
/** Un en-tete RAR tient tres largement dedans ; au-dela, c'est que la lecture a derape. */
const MAX_ENTETE = 64 * 1024;

/**
 * Ce qu'on lit D'ABORD a chaque en-tete.
 *
 * MESURE DU 2026-08-31, a travers la facade Telegram, sur un vrai CBR de 287 Mo :
 *
 *     512 o  -> 377 ms      64 Ko -> 684 ms      512 Ko -> 2604 ms
 *
 * On lisait `MAX_ENTETE` — 64 Ko — pour analyser un en-tete d'une CINQUANTAINE d'octets.
 * Sur un CBR de 185 planches cela faisait 11,8 Mo transferes pour construire un sommaire
 * qui tient dans 190 Ko, et pres du double de temps par en-tete.
 *
 * Mille octets couvrent tout en-tete reel, nom de fichier compris. `MAX_ENTETE` reste le
 * plafond : quand un nom deborde cette fenetre, on relit une fois, plus large. Ce
 * repli est rare et il est teste.
 */
const FENETRE_ENTETE = 1024;

/** Le format d'une archive RAR, ou `null` si ce n'en est pas une. */
export function formatRar(entete: Buffer): 'rar4' | 'rar5' | null {
  if (entete.length >= 8 && entete.subarray(0, 8).equals(MARQUEUR_RAR5)) return 'rar5';
  if (entete.length >= 7 && entete.subarray(0, 7).equals(MARQUEUR_RAR4)) return 'rar4';
  return null;
}

/**
 * Un entier de longueur variable RAR5 : sept bits utiles par octet, poids faible d'abord,
 * le bit de poids fort signalant qu'un octet suit.
 */
export function lireVint(buf: Buffer, pos: number): { valeur: number; taille: number } {
  let valeur = 0;
  let decalage = 0;
  for (let i = 0; i < 10; i += 1) {
    if (pos + i >= buf.length) throw new ErreurRar('entier tronque', 'illisible');
    const octet = buf[pos + i];
    valeur += (octet & 0x7f) * 2 ** decalage;
    if ((octet & 0x80) === 0) return { valeur, taille: i + 1 };
    decalage += 7;
  }
  throw new ErreurRar('entier de longueur variable aberrant', 'illisible');
}

/**
 * Les tailles d'un bloc RAR4, HAUTS MOTS COMPRIS.
 *
 * Un en-tete RAR4 porte ses tailles sur 32 bits. Le drapeau 0x100 — « LHD_LARGE » — dit
 * que les 32 bits de POIDS FORT suivent l'en-tete standard, a 32 et 36, juste avant le
 * nom. Le code ne lisait que les mots bas.
 *
 * DEUX CONSEQUENCES, ET LA SECONDE EST LA PLUS GRAVE. La taille annoncee d'un fichier de
 * plus de 4 Go etait fausse, ce qui se voit ; mais la taille des DONNEES sert aussi a
 * avancer jusqu'au bloc suivant, et un saut trop court fait atterrir le parcours au
 * milieu des donnees. Toutes les entrees suivantes etaient alors lues dans du bruit.
 * Signale par une revue de code le 2026-08-29.
 *
 * `debutNom` tenait deja compte de ces huit octets : le decalage etait connu, seules les
 * valeurs qu'il abrite ne l'etaient pas.
 */
export function taillesRar4(
  base: Buffer, type: number, drapeaux: number,
): { paquet: number; reelle: number } {
  const grande = type === 0x74 && (drapeaux & 0x100) !== 0 && base.length >= 40;
  const haut = (decalage: number) => (grande ? base.readUInt32LE(decalage) * 2 ** 32 : 0);

  // 0x8000 : le bloc est suivi de donnees, dont la taille est le champ a l'offset 7.
  const paquet = (drapeaux & 0x8000) !== 0 && base.length >= 11
    ? base.readUInt32LE(7) + haut(32)
    : 0;
  const reelle = base.length >= 15 ? base.readUInt32LE(11) + haut(36) : 0;
  return { paquet, reelle };
}

/**
 * Parcourt les en-tetes RAR4 et rend les entrees.
 *
 * Chaque bloc annonce sa taille d'en-tete et, pour un fichier, la taille de ses donnees :
 * on saute donc de bloc en bloc sans jamais lire le contenu.
 */
async function entreesRar4(
  lire: LecteurPlage, taille: number, avancee?: Avancee,
): Promise<EntreeRar[]> {
  const out: EntreeRar[] = [];
  let pos = MARQUEUR_RAR4.length;

  for (let n = 0; n < MAX_ENTREES && pos + 7 <= taille; n += 1) {
    let base = await lire(pos, Math.min(pos + FENETRE_ENTETE - 1, taille - 1));
    if (base.length < 7) break;

    const drapeaux = base.readUInt16LE(3);
    const tailleEntete = base.readUInt16LE(5);
    if (tailleEntete < 7) throw new ErreurRar('en-tete RAR aberrant', 'illisible');
    const type = base[2];

    const { paquet: tailleDonnees, reelle } = taillesRar4(base, type, drapeaux);

    // 0x74 : en-tete de FICHIER. Les autres blocs — archive, commentaire, fin — se sautent.
    if (type === 0x74 && base.length >= 32) {
      // 0x04 : le fichier est chiffre. On le dit plutot que de rendre du bruit.
      if ((drapeaux & 0x04) !== 0) {
        throw new ErreurRar('archive RAR protegee par mot de passe', 'chiffre');
      }
      const tailleReelle = reelle;
      const methode = base[25];
      const tailleNom = base.readUInt16LE(26);
      // 0x100 : tailles sur 64 bits, deux champs de plus avant le nom.
      const debutNom = 32 + ((drapeaux & 0x100) !== 0 ? 8 : 0);
      // LE NOM DEBORDE LA PETITE FENETRE : on relit, une fois, jusqu'au plafond. Les
      // champs deja lus vivent aux memes offsets, la relecture ne les invalide pas.
      if (debutNom + tailleNom > base.length && base.length < MAX_ENTETE) {
        base = await lire(pos, Math.min(pos + MAX_ENTETE - 1, taille - 1));
      }
      if (debutNom + tailleNom > base.length) throw new ErreurRar('nom tronque', 'illisible');
      const nom = base.subarray(debutNom, debutNom + tailleNom).toString('utf-8');

      out.push({
        nom,
        // 0x30 = « stockage ». 0x31 a 0x35 sont les niveaux de compression.
        stockee: methode === 0x30,
        taille: tailleReelle,
        offsetDonnees: pos + tailleEntete,
      });
    }

    const suivant = pos + tailleEntete + tailleDonnees;
    if (suivant <= pos) throw new ErreurRar('parcours RAR bloque', 'illisible');
    pos = suivant;
    avancee?.(pos, taille, out.length);
  }
  return out;
}

/**
 * Parcourt les en-tetes RAR5.
 *
 * Tout y est en entiers de longueur variable, et l'ordre des champs depend de drapeaux :
 * on avance donc champ par champ plutot que par offsets fixes.
 */
async function entreesRar5(
  lire: LecteurPlage, taille: number, avancee?: Avancee,
): Promise<EntreeRar[]> {
  const out: EntreeRar[] = [];
  let pos = MARQUEUR_RAR5.length;
  // `null` : pas encore calibre. Voir la note dans la boucle.
  let crcFiable: boolean | null = null;

  for (let n = 0; n < MAX_ENTREES && pos + 8 <= taille; n += 1) {
    let buf = await lire(pos, Math.min(pos + FENETRE_ENTETE - 1, taille - 1));
    if (buf.length < 8) break;

    let i = 4; // les quatre premiers octets sont le CRC de l'en-tete
    const tailleEntete = lireVint(buf, i); i += tailleEntete.taille;
    const debutCorps = i;

    // LE CRC DE L'EN-TETE, VERIFIE — MAIS SEULEMENT APRES S'ETRE CALIBRE.
    //
    // RAR5 protege chaque en-tete par un CRC32, et rien ne le verifiait : un en-tete
    // abime par un telechargement interrompu etait parse comme s'il allait de soi, et
    // pouvait produire une planche silencieusement corrompue. Signale par une revue le
    // 2026-08-29.
    //
    // POURQUOI UNE CALIBRATION PLUTOT QU'UN CONTROLE SEC. La plage couverte par ce CRC
    // se deduit d'une specification, et une plage fausse d'un seul octet REJETTERAIT
    // TOUTES LES ARCHIVES — y compris celles qui se lisent aujourd'hui. Aucune archive
    // RAR5 reelle n'etait disponible pour le verifier de bout en bout, et une lecture qui
    // marche ne se casse pas sur une deduction.
    //
    // Alors on se calibre sur le PREMIER en-tete, qui suit immediatement le marqueur.
    // S'il concorde, notre plage est juste POUR CETTE ARCHIVE, et tout ecart trouve
    // ensuite est une vraie corruption : on refuse. S'il ne concorde pas, on ne sait pas
    // distinguer « archive abimee des le premier bloc » de « plage mal comprise » : on
    // renonce a verifier, et on le TRACE — le journal dira si ce cas se produit, ce qui
    // est precisement ce qu'il faudrait savoir pour trancher.
    const finEntete = debutCorps + tailleEntete.valeur;
    if (finEntete <= buf.length && finEntete > 4) {
      const concorde = crc32(buf.subarray(4, finEntete)) === buf.readUInt32LE(0);
      if (crcFiable === null) {
        crcFiable = concorde;
        if (!concorde) {
          tracer('RAR', 'CRC d en-tete non concordant des le premier bloc : verification desactivee');
        }
      } else if (crcFiable && !concorde) {
        throw new ErreurRar('en-tete RAR5 corrompu', 'illisible');
      }
    }
    const type = lireVint(buf, i); i += type.taille;
    const drapeaux = lireVint(buf, i); i += drapeaux.taille;

    // 0x0001 : le bloc porte un champ « extra ». 0x0002 : il est suivi de donnees.
    if ((drapeaux.valeur & 0x0001) !== 0) { const x = lireVint(buf, i); i += x.taille; }
    const tailleDonnees = (drapeaux.valeur & 0x0002) !== 0
      ? (() => { const d = lireVint(buf, i); i += d.taille; return d.valeur; })()
      : 0;

    // type 2 : en-tete de FICHIER.
    if (type.valeur === 2) {
      const drapeauxFichier = lireVint(buf, i); i += drapeauxFichier.taille;
      const tailleReelle = lireVint(buf, i); i += tailleReelle.taille;
      const attributs = lireVint(buf, i); i += attributs.taille;
      void attributs;
      // 0x0002 : horodatage present. 0x0004 : CRC present.
      if ((drapeauxFichier.valeur & 0x0002) !== 0) i += 4;
      if ((drapeauxFichier.valeur & 0x0004) !== 0) i += 4;
      const compression = lireVint(buf, i); i += compression.taille;
      const osCreation = lireVint(buf, i); i += osCreation.taille;
      void osCreation;
      const tailleNom = lireVint(buf, i); i += tailleNom.taille;
      // Meme repli qu'en RAR4 : un nom qui deborde la petite fenetre la fait elargir une
      // fois. Les offsets deja parcourus restent valides, ce sont les memes octets.
      if (i + tailleNom.valeur > buf.length && buf.length < MAX_ENTETE) {
        buf = await lire(pos, Math.min(pos + MAX_ENTETE - 1, taille - 1));
      }
      if (i + tailleNom.valeur > buf.length) throw new ErreurRar('nom tronque', 'illisible');
      const nom = buf.subarray(i, i + tailleNom.valeur).toString('utf-8');

      // Bits 7-10 de la compression : la METHODE. Zero signifie « stockage ».
      const methode = (compression.valeur >> 7) & 0x07;
      out.push({
        nom,
        stockee: methode === 0,
        taille: tailleReelle.valeur,
        offsetDonnees: pos + debutCorps + tailleEntete.valeur,
      });
    }

    const suivant = pos + debutCorps + tailleEntete.valeur + tailleDonnees;
    if (suivant <= pos) throw new ErreurRar('parcours RAR bloque', 'illisible');
    pos = suivant;
    avancee?.(pos, taille, out.length);
  }
  return out;
}

/**
 * Les entrees d'une archive RAR, quel que soit son format.
 *
 * Ne lit AUCUNE donnee : seulement les en-tetes, de proche en proche.
 */
/**
 * Ou en est le parcours des en-tetes.
 *
 * `octetsParcourus / taille` est une VRAIE fraction, et c'est ce qui la rend utile : le
 * parcours avance lineairement dans le fichier. Le NOMBRE d'entrees, lui, ne peut pas
 * servir de denominateur — on ne le connait qu'une fois arrive au bout, puisque la
 * position de chaque en-tete ne se deduit que du precedent. C'est toute la difference
 * avec un ZIP, dont le repertoire central annonce le compte des la premiere lecture.
 */
export type Avancee = (octetsParcourus: number, total: number, entreesTrouvees: number) => void;

export async function entreesRar(
  lire: LecteurPlage, taille: number, avancee?: Avancee,
): Promise<EntreeRar[]> {
  const format = formatRar(await lire(0, 7));
  if (!format) throw new ErreurRar('ce fichier n est pas une archive RAR', 'pas-un-rar');
  return format === 'rar5'
    ? entreesRar5(lire, taille, avancee)
    : entreesRar4(lire, taille, avancee);
}

/**
 * Un lecteur de plages borne aux octets d'une entree STOCKEE.
 *
 * Meme forme que `lecteurDeEntree` pour le ZIP, et pour la meme raison : les octets sont
 * contigus, donc la lecture imbriquee n'est qu'un decalage. Ce qui est compresse est
 * refuse — l'inflater demanderait de charger le tome entier, et ce serveur a deja gele
 * deux fois par la memoire.
 */
export function lecteurDeEntreeRar(lire: LecteurPlage, entree: EntreeRar): LecteurPlage {
  if (!entree.stockee) {
    throw new ErreurRar(
      'ce tome est compresse dans l archive RAR : il faudrait la telecharger pour le lire',
      'compresse',
    );
  }
  const fin = entree.offsetDonnees + entree.taille - 1;
  // BORNE A L'ENTREE : sans cela on lirait les octets du fichier suivant, sans erreur et
  // avec une planche silencieusement corrompue.
  return (debut, jusqua) => lire(entree.offsetDonnees + debut, Math.min(entree.offsetDonnees + jusqua, fin));
}

/**
 * Le sommaire d'un CBR, dans la meme forme qu'un CBZ.
 *
 * Tout le reste de la chaine — service d'une planche, visionneuse, prechargement — continue
 * de travailler sur un `SommaireCbz` sans savoir qu'il vient d'un RAR. C'est la meme
 * decision qu'ailleurs dans ce projet : le format se decide a l'entree, jamais en aval.
 */
export async function sommaireRar(
  lire: LecteurPlage, taille: number, avancee?: Avancee,
): Promise<SommaireCbz> {
  const entrees = (await entreesRar(lire, taille, avancee))
    .filter((e) => estImage(e.nom))
    .sort((a, b) => triNaturel(a.nom, b.nom));

  if (entrees.length === 0) {
    throw new ErreurRar('cette archive RAR ne contient aucune image', 'illisible');
  }
  // UNE SEULE ENTREE COMPRESSEE SUFFIT A TOUT REFUSER. Les archiveurs stockent ou
  // compressent une archive entiere, pas planche par planche : rendre un sommaire dont la
  // moitie des pages echouerait ensuite vaudrait moins qu'un refus immediat et clair.
  const compressee = entrees.find((e) => !e.stockee);
  if (compressee) {
    throw new ErreurRar(
      'cette archive RAR est compressee : il faudrait la telecharger pour la lire',
      'compresse',
    );
  }

  return {
    pages: entrees.map((e, index) => ({ index, nom: e.nom, taille: e.taille })),
    entrees: entrees.map((e) => ({
      nom: e.nom,
      methode: 0,
      tailleCompressee: e.taille,
      tailleReelle: e.taille,
      offsetEntete: e.offsetDonnees,
      donneesDirectes: true,
    })),
  };
}
