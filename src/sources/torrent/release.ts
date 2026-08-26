// Analyse d'un nom de release de scan.
//
// C'est le coeur du risque fonctionnel du projet. Les noms viennent de quatre trackers
// et d'une dizaine de teams, et ils n'obeissent a aucune convention commune :
//
//     One Piece T106-114 Scan CBZ
//     One.Piece.[T01.T105].1997.2025.FR.[CBZ]-CHROMATIQUE
//     One.Piece.Tome.[1 a 100].3.HS.Eichiro.Oda.FR.[CBZ]-PRiNTER
//     Masashi.KISHIMOTO.Naruto.iNTEGRALE.2002.FRENCH.CBZ-Di3an
//
// Deux pieges reviennent, et les cas de test les fixent :
//
//   - une PLAGE contient un tome unique. Chercher « T106 » avant « T106-114 » perd la
//     fin de la plage, sans que rien ne le signale.
//   - un nombre a quatre chiffres est presque toujours une ANNEE. `1997.2025` est une
//     plage d'annees ; la lire comme des tomes donne « tomes 1997 a 2025 ».

import type { Format, Langue, PlageTomes } from '../types';

/**
 * Forme normalisee d'un titre : casse, accents et ponctuation retires.
 *
 * C'est sur cette forme que se compare une fiche et un nom de release. Les scans
 * circulent en « One.Piece », « One Piece » et « ONE PIECE » selon la team ; sans cette
 * mise a plat, aucun rapprochement ne tient.
 */
export function normaliserTitre(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Un nombre a quatre chiffres entre 1900 et 2099 est une annee, jamais un tome. */
function estAnnee(n: string): boolean {
  return /^(19|20)\d{2}$/.test(n);
}

function nombre(s: string): number {
  return Number(s.replace(/^0+(?=\d)/, ''));
}

const PREFIXE_TOME = '(?:t(?:ome)?s?|v(?:ol)?)';
const SEPARATEUR = '(?:-|\\.|_|\\s|a|à)+';

const RE_PLAGE = new RegExp(
  `\\b${PREFIXE_TOME}\\s*\\.?\\s*\\[?\\s*(\\d{1,4})\\s*${SEPARATEUR}\\s*${PREFIXE_TOME}?\\s*(\\d{1,4})\\s*\\]?`,
  'i',
);
const RE_UNIQUE = new RegExp(`\\b${PREFIXE_TOME}\\s*\\.?\\s*(\\d{1,4})\\b`, 'i');
/**
 * Unites qui suivent une MESURE, jamais un numero de tome.
 *
 * DEFAUT REEL, signale a l'usage : « Stephen King - Holly [2024] [mp3 a 64 Kb/s] » etait
 * annonce « T64 ». Le debit encadre d'espaces ressemble a un tome nu comme deux gouttes
 * d'eau — seule l'unite qui le suit les distingue.
 */
const UNITES = '(?:k|m|g)?(?:b(?:it)?(?:\\/?s|ps)?|o(?:ctets?)?|hz|dpi|ppp|fps|p\\b)';

// Dernier recours : un nombre nu, borde de separateurs. Limite a trois chiffres pour ne
// jamais happer une annee, et suivi de rien qui ressemble a une unite.
const RE_NU = new RegExp(`(?:^|[\\s._-])(\\d{1,3})(?!\\s*${UNITES})(?:[\\s._-]|\\.cb[zr]|$)`, 'i');

export function parseRelease(titre: string): {
  tomes?: PlageTomes;
  langue: Langue;
  format: Format;
  provenance?: 'retail' | 'scan' | 'hybride';
} {
  const sansAccent = titre.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  // Compare apres retrait des accents : « intégrale », « iNTEGRALE » et
  // « INTEGRALE » sont la meme chose.
  const integrale = /integrale/i.test(sansAccent);

  let tomes: PlageTomes | undefined;

  // 1) Plage explicite, cherchee EN PREMIER : elle contient un tome unique.
  const plage = RE_PLAGE.exec(titre);
  if (plage && !estAnnee(plage[1]) && !estAnnee(plage[2])) {
    const debut = nombre(plage[1]);
    const fin = nombre(plage[2]);
    if (fin >= debut) tomes = { debut, fin, integrale };
  }

  // 2) Tome unique prefixe.
  if (!tomes) {
    const un = RE_UNIQUE.exec(titre);
    if (un && !estAnnee(un[1])) tomes = { debut: nombre(un[1]), integrale };
  }

  // 3) Nombre nu, uniquement si rien de prefixe n'a ete trouve. Sans cette condition,
  //    « Naruto 2002 » deviendrait le tome 2002.
  if (!tomes) {
    const nu = RE_NU.exec(titre);
    if (nu) tomes = { debut: nombre(nu[1]), integrale };
  }

  // Une integrale sans numerotation lisible reste une integrale : on ne la perd pas.
  if (!tomes && integrale) tomes = { debut: 1, integrale: true };

  return {
    tomes, langue: langueDe(titre), format: formatDe(titre),
    provenance: provenanceDe(titre),
  };
}

function langueDe(t: string): Langue {
  // VOSTFR d'abord : il contient « fr » et serait avale par le test suivant.
  if (/\bvostfr\b/i.test(t)) return 'VOSTFR';
  if (/\b(fr|vf|vff|vfi|french|francais|français|multi)\b/i.test(t)) return 'FR';
  // PAS de « en » nu : c'est un mot francais tres courant. « One Piece en couleurs »
  // etait classe anglais a cause de lui — constate sur une vraie release Tr4ker.
  if (/\b(eng|english|vostang)\b/i.test(t)) return 'EN';
  if (/\b(jp|ja|jap|raw)\b/i.test(t)) return 'JA';
  return 'inconnue';
}

/**
 * Provenance d'une release, selon la convention Tr4ker.
 *
 * HYBRiD EN PREMIER, et l'ordre compte : « RETAiL.HYBRiD » existe, et c'est bien un
 * melange de sources. Tester RETAiL d'abord le classerait comme officiel.
 *
 * `undefined` quand rien ne le dit : environ la moitie des releases ne suivent aucune
 * convention (mesure du 2026-08-25 sur 226 noms), et deviner serait pire que se taire.
 */
export function provenanceDe(t: string): 'retail' | 'scan' | 'hybride' | undefined {
  if (/\bhybrid\b/i.test(t)) return 'hybride';
  if (/\bretail\b/i.test(t)) return 'retail';
  if (/\bscans?\b/i.test(t)) return 'scan';
  return undefined;
}

/**
 * Ce qui, dans un nom, designe un ENREGISTREMENT.
 *
 * Extrait en constante parce que deux endroits en ont besoin : reconnaitre le format
 * audio, et savoir qu'un « CBR » voisin qualifie un debit et non une archive.
 */
const MARQUEUR_SONORE =
  /\b(?:mp3|m4[ab]|flac|ogg|opus|aac|wav|audiobook|audio ?book|livre audio)\b/i;

/**
 * Retire « CBR » et « VBR » quand le nom porte un codec audio.
 *
 * DEFAUT REEL, mesure le 2026-08-26 sur la categorie 7105 d'Ygg : « Livre audio -
 * Bernard Werber - Le miroir de Cassandre [FR MP3 CBR 128] » sortait en « cbr ». Le
 * detecteur lisait « Comic Book RAR » la ou le nom dit « debit constant », et ce livre
 * audio se rangeait dans la famille BD.
 *
 * C'est la deuxieme fois que ce projet lit une mesure comme un identifiant : « [mp3 a
 * 64 Kb/s] » annoncait un tome « T64 ». Le debit s'y deguisait en nombre ; ici il se
 * deguise en lettres.
 *
 * La regle est ETROITE expres : sans marqueur sonore, rien n'est retire, et une vraie
 * bande dessinee en .cbr n'en porte jamais.
 */
function sansModeDeDebit(t: string): string {
  return MARQUEUR_SONORE.test(t) ? t.replace(/\b[cv]br\b/gi, ' ') : t;
}

function formatDe(brut: string): Format {
  const t = sansModeDeDebit(brut);
  if (/\bcbz\b/i.test(t)) return 'cbz';
  if (/\bcbr\b/i.test(t)) return 'cbr';
  if (/\bepub\b/i.test(t)) return 'epub';
  if (/\bpdf\b/i.test(t)) return 'pdf';
  // MOBI, AZW, KF8 et PRC sont les formats Kindle. Le wiki Tr4ker les nomme dans sa
  // convention de nommage : ils sortaient tous en « inconnu », alors qu'on sait
  // parfaitement qu'aucun n'est lisible ici.
  if (/\b(?:mobi|azw3?|kf8|prc)\b/i.test(t)) return 'kindle';
  // L'AUDIO EN DERNIER, ET C'EST L'ORDRE QUI COMPTE : « Livre audio [PDF+MP3] » est un
  // PDF accompagne de sa lecture, pas un livre audio. Le format qui se LIT prime.
  //
  // Signale a l'usage : « Stephen King - Holly [2024] [mp3 a 64 Kb/s] » remontait dans
  // une recherche de livres sans que rien ne dise que c'etait un enregistrement. Le
  // tracker le range en categorie Ebook — on ne peut pas l'y empecher, on peut le DIRE.
  // `AUDIOBOOK` est le tag obligatoire de la convention Tr4ker pour les livres audio.
  if (MARQUEUR_SONORE.test(t)) {
    return 'audio';
  }
  return 'inconnu';
}
