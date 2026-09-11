// Tome isole ou pack ?
//
// La reponse vient de l'ARBORESCENCE du .torrent, pas du nom de la release. Le nom ment
// plus souvent : « One Piece T01-T105 » peut livrer une archive unique, et « One Piece
// Integrale » peut livrer 108 fichiers. Or le .torrent, il faut de toute facon aller le
// chercher — un hash nu n'ouvre rien sur un tracker prive — donc l'information est
// gratuite, et elle est exacte.
//
// Le numero de tome se lit sur le NOM DE FICHIER pour la meme raison.

import type { FichierTorrent } from '../../core/bencode';
import { identiteTome } from '../../bibliotheque/identites';

/** Extensions qui portent reellement de la bande dessinee. */
const EXT_BD = /\.(cbz|cbr|cb7|pdf|epub)$/i;

/**
 * Un quantieme suivi d'un nom de mois : « 26 Aout », « 1er septembre ».
 *
 * Les mois sont ecrits SANS ACCENT dans l'expression et la comparaison se fait sans y
 * prendre garde : un nom de fichier ecrit « Aout » aussi souvent que « Août », et les deux
 * doivent compter.
 */
const RE_QUANTIEME =
  /(^|[\s._([-])\d{1,2}(?:er)?[\s._-]+(janvier|f[eé]vrier|mars|avril|mai|juin|juillet|ao[uû]t|septembre|octobre|novembre|d[eé]cembre)/gi;
/**
 * Les fichiers sonores d'une release.
 *
 * SEPARE DE `EXT_BD`, ET CE N'EST PAS UN DETAIL. `estBd` ne dit pas « c'est le contenu » :
 * il dit « ceci compte comme un TOME ». `bibliotheque.js` et `tomesDuPack` construisent
 * l'etagere avec `filter(estBd)` — y verser les mp3 aurait pose vingt-huit faux tomes
 * dans la bibliotheque pour un seul livre audio.
 *
 * Le `.m4b` y figure alors qu'il ne s'ecoute pas encore en ligne : « le navigateur
 * sait-il le jouer » et « est-ce le contenu de la release » sont deux questions
 * differentes, et pour le TELECHARGEMENT seule la seconde compte.
 */
const EXT_AUDIO = /\.(mp3|m4a|m4b|ogg|opus|wav|flac|aac)$/i;

// Le separateur entre le mot et le numero est libre : « Tome 3 », « Tome.3 », « Tome #3 »,
// « Vol. n°3 ». Le diese manquait, et le pack « One Piece [Team Chromatique] », qui nomme
// ses fichiers « Tome #001 », n'avait donc AUCUN tome numerote — cent quatre fichiers
// tombes en « f:<nom> », et le tome 20 affiche comme manquant dans une release qui le
// contient. Signale a l'usage le 2026-08-28.
// « 第N巻 » : le compteur de volumes japonais, tel qu'il apparait dans les noms de raws.
const RE_VOLUME_JP = /\u7b2c\s*(\d{1,4})\s*\u5dfb/;
const RE_PREFIXE = /\b(?:t(?:ome)?|v(?:ol)?)\s*\.?\s*(?:#|n[o°]\.?)?\s*(\d{1,4})\b/i;
// Nombre nu borde de separateurs, trois chiffres au plus : « (2023) » n'est pas un tome.
const RE_NU = /(?:^|[\s._#-])(\d{1,3})(?:[\s._()-]|$)/;

function estAnnee(n: string): boolean {
  return /^(19|20)\d{2}$/.test(n);
}

export interface FichierTome extends FichierTorrent {
  tome?: number;
  /** Vrai pour un fichier de bande dessinee, numerote ou non. */
  estBd: boolean;
  /**
   * Identite du tome pour la bibliotheque, calculee ICI et pas ailleurs.
   *
   * Le client en a besoin pour enregistrer l'avancement. La recalculer de son cote
   * marcherait aujourd'hui et divergerait un jour : deux regles pour une meme chose
   * finissent toujours par se separer, et la panne serait muette — des positions
   * enregistrees sous une cle que plus rien ne relit.
   */
  tomeId: string;
  /** Fichier sonore : du contenu, mais jamais un tome. Voir `EXT_AUDIO`. */
  estPiste: boolean;
}

export interface Structure {
  estPack: boolean;
  nbTomes: number;
  fichiers: FichierTome[];
}

/** Numero de tome lu sur un nom de fichier, ou `undefined`. */
export function numeroDeFichier(chemin: string): number | undefined {
  const base = chemin.split('/').pop() || chemin;
  const sansExtension = base.replace(/\.[A-Za-z0-9]+$/, '');

  // « v2 » EST UNE VERSION DE SCAN, PAS UN TOME. C'est la convention des scanlateurs pour
  // une correction : « Serie v2.cbz » est le meme tome, refait. Le lire comme « tome 2 »
  // faisait atterrir le fichier corrige sur le tome 2 et ecrasait sa position de lecture.
  // Signale par une revue de code le 2026-08-29.
  //
  // On ne neutralise QUE la forme courte et collee — « v » suivi d'UN chiffre, sans point
  // ni espace. « Vol. 2 », « vol 2 » et « v03 » restent des volumes : c'est le zero ou
  // l'unite de longueur qui fait la difference, et les scanlateurs n'ecrivent jamais « v03 »
  // pour une version.
  const sansVersion = sansExtension.replace(/(^|[\s._([-])v(\d)(?=$|[\s._)\]-])/gi, '$1');

  // UNE DATE N'EST PAS UN TOME, et c'est le meme piege que « v2 » un cran plus haut.
  //
  // « Le Journal de Spirou - 26 Aout 2026.pdf » rendait le TOME 26 : le quantieme du mois.
  // La bibliotheque affichait alors « 0 / 26 tomes lu, en cours Tome 26 » pour un numero
  // 4611, et l'etagere s'en serait remplie. Signale a l'usage le 2026-09-01.
  //
  // On neutralise le quantieme QUAND IL EST SUIVI D'UN NOM DE MOIS — c'est ce qui en fait
  // une date. « Tome 26 » et « 26 » seuls restent des tomes : un periodique n'est pas la
  // seule chose numerotee, et retirer tous les nombres a deux chiffres casserait tout le
  // reste.
  const sansDate = sansVersion.replace(RE_QUANTIEME, '$1');


  // « 第042巻 » : « volume 42 » en japonais. Les packs de raws le nomment ainsi, et sans
  // cela leurs cent neuf volumes tombaient tous en « f:<nom> » — aucun tome numerote.
  // Signale a l'usage le 2026-08-28 sur « ワンピース 第01-109巻 ».
  const japonais = RE_VOLUME_JP.exec(sansDate);
  if (japonais) return Number(japonais[1].replace(/^0+(?=\d)/, ''));

  const prefixe = RE_PREFIXE.exec(sansDate);
  if (prefixe && !estAnnee(prefixe[1])) return Number(prefixe[1].replace(/^0+(?=\d)/, ''));

  const nu = RE_NU.exec(sansDate);
  if (nu) return Number(nu[1].replace(/^0+(?=\d)/, ''));

  return undefined;
}

/**
 * Analyse une arborescence.
 *
 * Les fichiers annexes — .nfo, couvertures, .sfv — ne comptent pas comme des tomes mais
 * RESTENT listes : l'utilisateur peut vouloir la couverture, et les faire disparaitre
 * serait decider a sa place.
 */
export function analyser(fichiers: FichierTorrent[]): Structure {
  const avecTome: FichierTome[] = fichiers.map((f) => {
    const estBd = EXT_BD.test(f.chemin);
    // `estBd` et `tome` sont deux choses differentes, et les confondre coute cher :
    // une release de CHAPITRE (« One.Piece.C1186.cbz ») n'a pas de numero de tome, mais
    // c'est bien de la bande dessinee. Selectionner sur le numero laissait l'utilisateur
    // devant « 0 fichier selectionne » — constate en conditions reelles.
    const tome = estBd ? numeroDeFichier(f.chemin) : undefined;
    const estPiste = EXT_AUDIO.test(f.chemin);
    return { ...f, estBd, estPiste, tome, tomeId: identiteTome({ tome, chemin: f.chemin }) };
  });

  const numeros = new Set<number>();
  for (const f of avecTome) if (f.tome !== undefined) numeros.add(f.tome);

  // Tri NATUREL sur le numero : un tri lexical placerait T10 avant T2. Les fichiers
  // sans numero passent apres, dans leur ordre d'origine.
  const tomes = avecTome
    .filter((f) => f.tome !== undefined)
    .sort((a, b) => (a.tome! - b.tome!) || a.chemin.localeCompare(b.chemin));
  // Les pistes AVANT les annexes, et triees : elles sont le contenu, une jaquette non.
  // Le tri est numerique — le debrideur rend ses fichiers dans un ordre quelconque, et
  // un tri lexical placerait « 10 » avant « 2 ».
  const pistes = avecTome
    .filter((f) => f.tome === undefined && f.estPiste)
    .sort((a, b) => a.chemin.localeCompare(b.chemin, undefined, { numeric: true, sensitivity: 'base' }));
  const annexes = avecTome.filter((f) => f.tome === undefined && !f.estPiste);

  return {
    // UN LIVRE AUDIO EST UN PACK, LUI AUSSI. Compte sur les seuls numeros de tome,
    // `estPack` valait toujours faux pour lui — et le bouton « Tout recuperer en
    // archive », qui commande dessus, ne paraissait jamais.
    estPack: numeros.size >= 2 || pistes.length >= 2,
    nbTomes: numeros.size,
    fichiers: [...tomes, ...pistes, ...annexes],
  };
}
