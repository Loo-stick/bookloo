// Ce que la visionneuse sait ouvrir, et ce qu'elle ne sait pas.
//
// POURQUOI CE FICHIER EXISTE. `zip.ts` lit du ZIP, et rien d'autre. Un `.cbr` est une
// archive RAR — un format entierement different, dont les en-tetes sont entrelaces avec
// les donnees au lieu de vivre en fin de fichier. Sonde du 2026-08-21 : le lister par
// plages coute environ une seconde par planche, soit trois minutes pour un tome de 185
// pages. Ce n'est pas une lacune a combler par un essai, c'est une impossibilite pratique
// a annoncer.
//
// Le depot a deja tranche ce genre de cas ailleurs, en toutes lettres : « un bouton qui
// echoue apres une attente vaut moins qu'un bouton absent et une explication ».
//
// PUR, sans DOM : c'est ce qui le rend reellement executable par ses tests, au lieu
// d'etre seulement relu.

/** Archives que le lecteur par plages sait ouvrir. */
const FORMATS_LISIBLES = ['cbz', 'zip'];

function lisibleEnLigne(format) {
  return FORMATS_LISIBLES.includes(String(format || '').toLowerCase());
}

/**
 * Pourquoi ce format ne se lit pas. Rend `null` quand il se lit.
 *
 * Le message nomme le format ET dit ce que la visionneuse attend : « non lisible » seul
 * laisserait croire a une panne passagere.
 */
function raisonNonLisible(format) {
  const f = String(format || '').toLowerCase();
  if (lisibleEnLigne(f)) return null;
  if (f === 'cbr' || f === 'rar') {
    return 'archive RAR — la visionneuse lit les archives ZIP (cbz)';
  }
  // L'EPUB N'EST PAS « NON LISIBLE » : il a sa propre surface, la liseuse. Ce message
  // s'affichait sur des epub Telegram parfaitement lisibles, parce qu'il ne connaissait
  // que la visionneuse.
  if (f === 'epub') return null;
  // L'AUDIO N'EST PAS « NON LISIBLE » NON PLUS : il a sa propre surface, l'ecoute. Ce
  // message annoncait « pas de lecture en ligne » sur des livres audio parfaitement
  // ecoutables, parce qu'il ne connaissait que la visionneuse — exactement le defaut
  // deja corrige pour l'epub, deux lignes plus haut.
  if (f === 'audio') return null;
  if (f === 'kindle') return `${f} — format Kindle, ni lu ni converti ici`;
  if (!f || f === 'inconnu') return 'format inconnu — la visionneuse lit les cbz';
  return `${f} — la visionneuse lit les cbz`;
}

/**
 * Le debit annonce dans un nom de release, en kb/s, ou null.
 *
 * L UNITE EST OBLIGATOIRE, et c est tout l interet de cette fonction. « [M4B 44.1kHz] »
 * annonce une frequence d echantillonnage : lue comme un debit, elle donnerait soixante
 * et une heures au lieu de trois. « Dome 2 » n annonce rien du tout.
 *
 * Formes admises, relevees le 2026-08-26 : « 128 Kb/s », « 160kbps », « 128kbits »,
 * « 64 Kb/s », « 320 kbit/s ».
 *
 * Pas de quantificateur borne dans l expression : CLAUDE.md de la machine. Le garde-fou
 * est une comparaison de valeur, ce qui est de toute facon plus juste.
 */
function debitAnnonce(titre) {
  const m = /(\d+)\s*k\s*b(?:it)?s?(?:\s*\/\s*s|ps)?\b/i.exec(String(titre || ''));
  if (!m) return null;
  const kbs = Number(m[1]);
  // La borne haute laisse passer le FLAC, qui tourne autour de 1000 kb/s et fait 1 % de
  // la categorie. A 512 on l aurait ecarte en silence.
  if (!Number.isFinite(kbs) || kbs < 32 || kbs > 1536) return null;
  return kbs;
}

/**
 * La duree d un enregistrement, deduite de sa taille et de son debit.
 *
 * Rend une chaine deja formatee, ou null quand on ne sait pas. NULL EST UNE REPONSE :
 * sans debit annonce on n affiche rien, on ne suppose pas un debit par defaut. C est le
 * principe deja tenu par « en-cache » / « absent » / « inconnu » — l absence
 * d information n est pas une information.
 *
 * Le signe ≈ n est pas decoratif : la taille compte les fichiers annexes (jaquette,
 * .nfo), et un debit annonce peut etre nominal alors que l encodage est variable. La
 * valeur est bonne a quelques minutes pres, pas a la seconde.
 */
function dureeEstimee(titre, octets) {
  const taille = Number(octets);
  if (!Number.isFinite(taille) || taille <= 0) return null;
  const kbs = debitAnnonce(titre);
  if (!kbs) return null;

  const secondes = (taille * 8) / (kbs * 1000);
  const demiHeures = Math.round(secondes / 1800);
  // Sous le quart d heure, un arrondi a la demi-heure ne veut plus rien dire.
  if (demiHeures === 0) return null;

  const heures = Math.floor(demiHeures / 2);
  const minutes = (demiHeures % 2) * 30;
  if (heures === 0) return `≈ ${minutes} min`;
  return minutes ? `≈ ${heures} h ${minutes}` : `≈ ${heures} h`;
}

if (typeof module !== 'undefined') {
  module.exports = {
    FORMATS_LISIBLES, lisibleEnLigne, raisonNonLisible, debitAnnonce, dureeEstimee,
  };
}
