// Lecture d'un CBZ par plages d'octets.
//
// Un CBZ est un ZIP, et un ZIP se lit PAR LA FIN : son repertoire central — la liste de
// toutes les entrees avec leur position — vit dans les derniers octets du fichier. On
// peut donc connaitre les 108 planches d'un tome de 350 Mo en lisant 64 Ko, puis
// atteindre la planche 42 sans avoir lu les quarante et une precedentes.
//
// C'est ce qui permet a Mangaloo de tenir sa promesse d'ouverture : rien n'est
// telecharge, rien n'est stocke.
//
// AUCUN RESEAU DANS CE FICHIER. Il ne connait qu'une fonction `LecteurPlage`, ce qui le
// rend testable sur de vraies archives construites en memoire, sans debrideur ni cle.

import { inflateRawSync } from 'node:zlib';

export type LecteurPlage = (debut: number, fin: number) => Promise<Buffer>;

export interface EntreeZip {
  nom: string;
  /** 0 = stockee, 8 = degonflee. Toute autre valeur est refusee. */
  methode: number;
  tailleCompressee: number;
  tailleReelle: number;
  /** Position de l'en-tete LOCAL, pas des donnees : elles sont derriere lui. */
  offsetEntete: number;
  /**
   * `offsetEntete` designe deja LES DONNEES, sans en-tete a franchir.
   *
   * Sert aux archives RAR : leurs entrees stockees n'ont pas d'en-tete local au sens ZIP,
   * et `entreesRar` a deja calcule ou commencent les octets. Le reste de la chaine —
   * sommaire, service d'une planche, visionneuse — n'a alors rien a savoir du format.
   */
  donneesDirectes?: boolean;
}

export interface SommaireCbz {
  pages: { index: number; nom: string; taille: number }[];
  entrees: EntreeZip[];
}

export type CodeErreurZip = 'pas-un-zip' | 'zip64' | 'sans-image' | 'illisible';

export class ErreurZip extends Error {
  constructor(message: string, public readonly code: CodeErreurZip) {
    super(message);
    this.name = 'ErreurZip';
  }
}

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

/** Zone lue en fin de fichier pour y trouver la fin du repertoire central. */
const QUEUE_OCTETS = 64 * 1024;
const MAX_SOMMAIRE_OCTETS = 8 * 1024 * 1024;
const MAX_ENTREE_OCTETS = 32 * 1024 * 1024;

/**
 * Marge demandee en plus des donnees pour couvrir l'en-tete local — signature, nom,
 * champ « extra ». Genereuse : 8 Ko de trop sur une planche de 500 Ko, c'est 1,6 % de
 * debit gaspille pour eviter un aller-retour qui en coute 130 a 460 ms.
 */
const MARGE_ENTETE_OCTETS = 8 * 1024;

/**
 * Plafond d'une plage, aligne sur celui de `plages.ts`. Duplique a dessein : ce fichier
 * ignore le reseau et ne doit pas dependre du module qui s'en sert.
 */
const MAX_PLAGE_OCTETS = 16 * 1024 * 1024;

const EXT_IMAGE = /\.(jpe?g|png|webp|avif|gif)$/i;

/**
 * Entrees d'archivage que macOS ajoute et qui ne sont PAS des planches.
 *
 * Un ZIP fabrique sous macOS double chaque fichier : `page00.jpg` et
 * `__MACOSX/._page00.jpg`, ce second etant un fork de ressource de quelques centaines
 * d'octets. Il finit par `.jpg`, donc toute regle fondee sur l'extension l'accepte.
 *
 * Constate a l'usage sur « Spirou et Fantasio » : 134 planches annoncees pour 67 reelles,
 * et comme le tri est naturel, `__MACOSX/._page00.jpg` passait EN TETE — la planche 1
 * etait donc toujours un fork de ressource, que le navigateur ne savait pas afficher.
 */
const ARTEFACT_MACOS = /(^|\/)(__MACOSX\/|\._)/;

/** Vrai pour une vraie planche : une image, et pas un artefact d'archivage. */
export function estImage(nom: string): boolean {
  if (nom.endsWith('/')) return false;
  if (ARTEFACT_MACOS.test(nom)) return false;
  return EXT_IMAGE.test(nom);
}


/**
 * Tri naturel : « p2.jpg » avant « p10.jpg ».
 *
 * Un tri lexical placerait p10 avant p2, et la planche 10 s'afficherait en deuxieme
 * position. Le lecteur ne s'en apercevrait qu'au milieu d'une scene.
 */
export function triNaturel(a: string, b: string): number {
  const segments = (s: string) => s.toLowerCase().match(/\d+|\D+/g) ?? [];
  const sa = segments(a);
  const sb = segments(b);
  for (let i = 0; i < Math.max(sa.length, sb.length); i++) {
    const x = sa[i];
    const y = sb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d/.test(x);
    const ny = /^\d/.test(y);
    if (nx && ny) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Position de la fin du repertoire central, cherchee EN PARTANT DE LA FIN.
 *
 * Un commentaire d'archive peut contenir la meme signature plus tot dans la queue :
 * chercher depuis le debut trouverait alors la mauvaise.
 */
function trouverEocd(queue: Buffer): number {
  for (let i = queue.length - 22; i >= 0; i--) {
    if (queue.readUInt32LE(i) === SIG_EOCD) return i;
  }
  return -1;
}

/**
 * Nomme le format d'une archive d'apres ses premiers octets, ou `null` si on ne sait pas.
 *
 * PUR, donc testable sans reseau. Sert UNIQUEMENT a expliquer un echec : « aucune fin de
 * repertoire central » est exact et n'apprend rien a personne.
 *
 * L'extension ne suffit pas a le deviner, et c'est mesure dans les deux sens : sur
 * Telegram, 40 fichiers `.cbr` sur 40 sont vraiment du RAR ; sur les trackers, un `.cbr`
 * s'est ouvert parce que c'etait un ZIP renomme. Seuls les octets disent la verite.
 */
export function formatArchive(entete: Buffer): string | null {
  if (entete.length < 4) return null;
  if (entete.subarray(0, 4).toString('latin1') === 'Rar!') return 'RAR';
  if (entete.subarray(0, 4).toString('latin1') === '%PDF') return 'PDF';
  if (entete.subarray(0, 2).toString('latin1') === '7z') return '7z';
  if (entete[0] === 0x1f && entete[1] === 0x8b) return 'gzip';
  if (entete.subarray(0, 5).toString('latin1') === 'ustar') return 'tar';
  return null;
}

/** Entrees brutes du repertoire central. Partage entre `lireSommaire` et `inspecterZip`. */
/**
 * TOUTES les entrees d'un ZIP, sans filtre.
 *
 * Exportee pour l'EPUB : un livre n'est pas un dossier d'images, c'est un manifeste XML
 * qui designe des chapitres XHTML. `inspecterZip` ne rend que les images et les archives
 * imbriquees — parfait pour un CBZ, aveugle pour un EPUB.
 */
export async function lireEntrees(lire: LecteurPlage, taille: number): Promise<EntreeZip[]> {
  if (taille < 22) throw new ErreurZip('fichier trop court pour etre un ZIP', 'pas-un-zip');

  const debutQueue = Math.max(0, taille - QUEUE_OCTETS);
  const queue = await lire(debutQueue, taille - 1);
  const posEocd = trouverEocd(queue);
  if (posEocd === -1) {
    // On ne lit les premiers octets QU'ICI, sur le chemin d'echec : nommer le format
    // coute un aller-retour, et il ne sert a rien quand tout se passe bien.
    //
    // « Aucune fin de repertoire central » est exact et n'apprend rien. Dire « c'est du
    // RAR » dit a l'utilisateur pourquoi, et ce qu'il peut faire a la place.
    let format: string | null = null;
    try {
      format = formatArchive(await lire(0, 7));
    } catch {
      /* illisible : on s'en tiendra au message generique */
    }
    throw new ErreurZip(
      format
        ? `cette archive est du ${format}, pas du ZIP : la visionneuse ne sait pas l ouvrir`
        : 'ce fichier n est pas une archive ZIP',
      'pas-un-zip',
    );
  }

  const nbEntrees = queue.readUInt16LE(posEocd + 10);
  const tailleSommaire = queue.readUInt32LE(posEocd + 12);
  const debutSommaire = queue.readUInt32LE(posEocd + 16);

  // ZIP64 : les champs 32 bits saturent et la vraie valeur vit dans un enregistrement
  // separe. Lire un ZIP64 avec ce decodeur donnerait des octets FAUX, pas une erreur —
  // on refuse donc explicitement plutot que de servir n'importe quoi.
  if (nbEntrees === 0xffff || tailleSommaire === 0xffffffff || debutSommaire === 0xffffffff) {
    throw new ErreurZip('archive ZIP64, non prise en charge', 'zip64');
  }
  if (tailleSommaire > MAX_SOMMAIRE_OCTETS) {
    throw new ErreurZip('repertoire central aberrant', 'illisible');
  }

  const sommaire = await lire(debutSommaire, debutSommaire + tailleSommaire - 1);

  const entrees: EntreeZip[] = [];
  let i = 0;
  while (i + 46 <= sommaire.length && sommaire.readUInt32LE(i) === SIG_CENTRAL) {
    const methode = sommaire.readUInt16LE(i + 10);
    const tailleCompressee = sommaire.readUInt32LE(i + 20);
    const tailleReelle = sommaire.readUInt32LE(i + 24);
    const longNom = sommaire.readUInt16LE(i + 28);
    const longExtra = sommaire.readUInt16LE(i + 30);
    const longCommentaire = sommaire.readUInt16LE(i + 32);
    const offsetEntete = sommaire.readUInt32LE(i + 42);
    const nom = sommaire.toString('utf-8', i + 46, i + 46 + longNom);

    entrees.push({ nom, methode, tailleCompressee, tailleReelle, offsetEntete });
    i += 46 + longNom + longExtra + longCommentaire;
  }

  if (entrees.length === 0) throw new ErreurZip('repertoire central vide ou illisible', 'pas-un-zip');
  return entrees;
}

export async function lireSommaire(lire: LecteurPlage, taille: number): Promise<SommaireCbz> {
  const { images } = await inspecterZip(lire, taille);
  if (images.length === 0) {
    throw new ErreurZip('cette archive ne contient aucune image', 'sans-image');
  }
  return {
    pages: images.map((e, index) => ({ index, nom: e.nom, taille: e.tailleReelle })),
    entrees: images,
  };
}

/** Extensions d'archives de BD imbriquees dans un pack. */
const EXT_ARCHIVE = /\.(cbz|cbr|cb7|pdf|epub)$/i;

export interface ContenuZip {
  /** Entrees images : l'archive est directement lisible. */
  images: EntreeZip[];
  /** Archives imbriquees : c'est un PACK, un fichier par tome. */
  archives: EntreeZip[];
}

/**
 * Que contient ce ZIP ?
 *
 * `lireSommaire` refuse une archive sans image, ce qui est juste pour la visionneuse.
 * Mais un PACK contient des .cbz — un par tome — et il faut pouvoir les lister sans
 * traiter ce cas comme une erreur.
 *
 * Mesure du 2026-08-20 sur Wawacity : la moitie des releases sont des ZIP, l'autre des
 * RAR, et la distinction ne suit pas celle entre pack et tome unique.
 */
export async function inspecterZip(lire: LecteurPlage, taille: number): Promise<ContenuZip> {
  const entrees = await lireEntrees(lire, taille);
  return {
    images: entrees.filter((e) => estImage(e.nom)).sort((a, b) => triNaturel(a.nom, b.nom)),
    archives: entrees.filter((e) => EXT_ARCHIVE.test(e.nom)).sort((a, b) => triNaturel(a.nom, b.nom)),
  };
}

/**
 * Un lecteur de plages restreint aux octets d'une entree STOCKEE de l'archive.
 *
 * C'est ce qui permet de lire un CBZ contenu DANS un ZIP sans jamais charger l'archive :
 * les octets de l'entree sont contigus, donc une lecture imbriquee n'est qu'un decalage
 * d'offset. Toute la chaine — `lireSommaire`, `lireEntree`, la visionneuse — fonctionne
 * ensuite dessus sans rien savoir de l'imbrication.
 *
 * Signale a l'usage le 2026-08-28 : la release « One.Piece.[T01.T105]…CHROMATIQUE » n'est
 * pas cent cinq CBZ mais UN fichier .zip de 15,3 Go qui les contient.
 *
 * REFUSE CE QUI EST COMPRESSE, et c'est un choix. Lire une entree degonflee imposerait de
 * l'inflater entierement — 150 a 250 Mo par tome, dans un conteneur borne a 512 Mo, sur une
 * machine qui a deja gele deux fois par la memoire. Un CBZ contient des JPEG deja
 * compresses, que les archiveurs stockent presque toujours : le cas refuse est rare, et le
 * dire vaut mieux que de le tenter.
 */
export async function lecteurDeEntree(
  lire: LecteurPlage,
  entree: EntreeZip,
): Promise<LecteurPlage> {
  if (entree.methode !== 0) {
    throw new ErreurZip(
      'ce tome est compresse dans l archive : il faudrait la telecharger pour le lire',
      'illisible',
    );
  }

  // ON RELIT L'EN-TETE LOCAL. Meme raison que dans `lireEntree` : la longueur du champ
  // « extra » y differe couramment de celle annoncee par le repertoire central, et s'en
  // remettre au sommaire decale la position des donnees — sans lever la moindre erreur.
  const entete = await lire(entree.offsetEntete, entree.offsetEntete + 29);
  if (entete.length < 30 || entete.readUInt32LE(0) !== SIG_LOCAL) {
    throw new ErreurZip('en-tete local absent', 'illisible');
  }
  const base = entree.offsetEntete + 30 + entete.readUInt16LE(26) + entete.readUInt16LE(28);
  const fin = base + entree.tailleReelle - 1;

  // BORNE A L'ENTREE. Sans cela, une lecture au-dela rendrait les octets du fichier
  // suivant : aucune erreur levee, une planche silencieusement corrompue.
  return (debut, jusqua) => lire(base + debut, Math.min(base + jusqua, fin));
}

export async function lireEntree(lire: LecteurPlage, entree: EntreeZip): Promise<Buffer> {
  // LES DEUX TAILLES, ET C'EST LA SECONDE QUI PROTEGE. Le plafond ne portait que sur la
  // taille compressee : or le deflate atteint des rapports de mille contre un sur des
  // donnees repetees, donc une entree d'un megaoctet peut se degonfler en plusieurs
  // gigaoctets. Un seul CBZ piege suffisait a faire tomber le conteneur — sans boucle ni
  // repetition. Signale par une revue de code le 2026-08-29.
  //
  // `tailleReelle` vient du ZIP lui-meme, donc de l'exterieur : on ne lui fait pas
  // confiance, on s'en sert seulement pour REFUSER tot. Ce qu'on obtient reellement est
  // verifie apres l'inflation.
  if (entree.tailleCompressee > MAX_ENTREE_OCTETS || entree.tailleReelle > MAX_ENTREE_OCTETS) {
    throw new ErreurZip('planche anormalement volumineuse', 'illisible');
  }

  // ON RELIT L'EN-TETE LOCAL, et ce n'est pas une precaution de style : sa longueur de
  // champ « extra » differe couramment de celle annoncee par le repertoire central. S'en
  // remettre au sommaire decale la position des donnees — ce qui ne leve aucune erreur,
  // rend simplement une image corrompue.
  //
  // Mais cette relecture ne vaut pas un aller-retour a elle seule. Comparaison controlee
  // du 21/08/2026 sur un CBZ TorBox de 462 Mo (meme planche pour les deux trajets, ordre
  // alterne pour ne pas confondre le gain avec l'echauffement de la connexion) : mediane
  // de 289 ms en une plage contre 358 ms en deux, le nouveau trajet gagnant aux six tours.
  // Environ 69 ms par planche. On demande donc l'en-tete ET les donnees en une fois, avec
  // une marge pour le nom et le champ extra, puis on decoupe.
  //
  // Deux cas font retomber sur une seconde requete, et dans les deux la correction passe
  // avant la vitesse : une entree trop grosse pour tenir dans une seule plage, et un
  // champ extra plus long que la marge.
  // RIEN A FRANCHIR : les octets commencent la. C'est le cas d'une entree RAR stockee,
  // dont `entreesRar` connait deja la position exacte.
  if (entree.donneesDirectes) {
    return lire(entree.offsetEntete, entree.offsetEntete + entree.tailleCompressee - 1);
  }

  const combine = 30 + MARGE_ENTETE_OCTETS + entree.tailleCompressee;
  const aDemander = combine <= MAX_PLAGE_OCTETS ? combine : 30;

  const bloc = await lire(entree.offsetEntete, entree.offsetEntete + aDemander - 1);
  if (bloc.length < 30 || bloc.readUInt32LE(0) !== SIG_LOCAL) {
    throw new ErreurZip('en-tete local absent', 'illisible');
  }
  const debutDonnees = 30 + bloc.readUInt16LE(26) + bloc.readUInt16LE(28);

  const brut =
    debutDonnees + entree.tailleCompressee <= bloc.length
      ? bloc.subarray(debutDonnees, debutDonnees + entree.tailleCompressee)
      : await lire(
          entree.offsetEntete + debutDonnees,
          entree.offsetEntete + debutDonnees + entree.tailleCompressee - 1,
        );

  if (entree.methode === 0) return brut;
  if (entree.methode === 8) {
    let sorti;
    try {
      // `maxOutputLength` fait porter le plafond a la DECOMPRESSION elle-meme, et pas
      // seulement a ce que l'archive annonce : un en-tete menteur ne suffit plus.
      sorti = inflateRawSync(brut, { maxOutputLength: MAX_ENTREE_OCTETS });
    } catch {
      throw new ErreurZip('planche illisible', 'illisible');
    }
    if (sorti.length > MAX_ENTREE_OCTETS) {
      throw new ErreurZip('planche anormalement volumineuse', 'illisible');
    }
    return sorti;
  }
  throw new ErreurZip(`methode de compression ${entree.methode} non prise en charge`, 'illisible');
}