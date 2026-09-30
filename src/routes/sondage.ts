// Quels liens la sonde a le droit d'essayer, et combien de temps.
//
// POURQUOI CE MODULE EXISTE, ET IL A UNE DATE. `sonderArchive` essayait CHAQUE lien de la
// fiche pour CHAQUE debrideur configure, sans aucune borne de temps. Tant que resoudre un
// lien coutait un appel d'API, cela passait. Le 2026-09-01, bookys est arrive : ses liens
// passent par un redirecteur a lui, et les resoudre demande un passage par flaresolverr —
// treize secondes chacun.
//
// Quatre hebergeurs fois deux debrideurs font alors cent secondes, et le proxy coupe bien
// avant : l'utilisateur recevait un 502 NU, sans message, la ou tous les refus de
// l'application en portent un. Signale a l'usage.
//
// PUR : ces deux decisions se verifient en les executant, pas en relisant la boucle.

/** Combien de liens la sonde essaie, au plus. */
export const MAX_LIENS_SONDES = 2;

/**
 * Le budget de la sonde.
 *
 * Vingt-cinq secondes : de quoi resoudre deux liens bookys, et assez court pour repondre
 * AVANT que le proxy ne coupe. Depasser ce budget n'est pas une erreur — c'est une
 * reponse : « je n'ai pas pu decider, telechargez pour voir ».
 */
export const BUDGET_SONDAGE_MS = 25_000;

/**
 * Les liens qui valent d'etre essayes, dans l'ordre.
 *
 * ON N'ESSAIE PAS TOUT. La sonde ne repond qu'a une question — « la visionneuse saura-t-elle
 * ouvrir ca ? » — et les fichiers d'une meme fiche sont le MEME fichier chez plusieurs
 * hebergeurs. Le second lien ne sert que si le premier ne repond pas ; le quatrieme
 * n'apprend rien que le troisieme n'ait deja dit, et coute treize secondes.
 */
export function liensASonder<T extends { hebergeur: string; url: string }>(
  liens: T[],
  utilisable: (l: T) => boolean,
  max = MAX_LIENS_SONDES,
): T[] {
  const utilisables = liens.filter(utilisable);
  const out: T[] = [];
  const vus = new Set<string>();

  // D'ABORD UN LIEN PAR HEBERGEUR : deux essais chez le meme refusé ne valent pas deux
  // essais, et varier l'hebergeur est ce qui distingue « ce fichier a disparu » de « ce
  // debrideur ne sait pas ouvrir cet hote ».
  for (const l of utilisables) {
    const cle = l.hebergeur.toLowerCase();
    if (vus.has(cle)) continue;
    vus.add(cle);
    out.push(l);
    if (out.length >= max) return out;
  }

  // PUIS ON REMPLIT, MEME CHEZ UN HEBERGEUR DEJA ESSAYE.
  //
  // La regle d'origine s'arretait la, et gaspillait le second essai des qu'une release
  // n'avait qu'un hebergeur : sur quatre liens dailyuploads, UN seul etait tente, et
  // l'ecran annoncait pourtant que « les 4 liens ne repondent plus ». Un fichier efface
  // n'est pas un hebergeur qui refuse — le voisin, chez le meme hote, a son propre sort.
  for (const l of utilisables) {
    if (out.includes(l)) continue;
    out.push(l);
    if (out.length >= max) break;
  }
  return out;
}

/** Ce que les premiers octets suffisent a trancher. `null` : il faut regarder dedans. */
export interface VerdictOctets {
  format: string;
  lisible: boolean;
  motif?: string;
}

/**
 * Le verdict que les premiers octets permettent, et LUI SEUL.
 *
 * UN RAR EST LISIBLE. Ce verdict disait l'inverse, et il avait raison le jour ou il a ete
 * ecrit : le lecteur RAR n'existait pas. Il existe depuis le 2026-08-31, il lit les CBR
 * par plages, et le chemin en lien direct passe deja l'avancee a `sommaireArchive` — la
 * barre de progression couvre l'attente, comme pour Telegram.
 *
 * La porte equivalente cote Telegram (`web/formats.js`) a ete corrigee la veille ;
 * celle-ci, qui garde les liens directs, avait ete manquee. Une capacite ajoutee laisse
 * derriere elle autant de portes fermees qu'il y avait de chemins.
 *
 * UN ZIP N'EST PAS TRANCHE ICI : il peut contenir des images, des tomes, ou rien de
 * lisible. Seul son repertoire central le dit, et c'est a l'appelant d'aller voir.
 */
export function verdictDesPremiersOctets(debut: string): VerdictOctets | null {
  if (debut.startsWith('Rar!')) {
    return {
      format: 'rar',
      lisible: true,
      motif: 'archive RAR — sa preparation demande une minute environ',
    };
  }
  // UN PDF A SA PROPRE SURFACE depuis le 2026-09-01 : la liseuse PDF. `lisible` ne veut
  // pas dire « la visionneuse sait l'ouvrir » mais « l'application sait l'ouvrir » — c'est
  // deja le sens qu'il a pour un EPUB et pour un livre audio.
  if (debut.startsWith('%PDF')) return { format: 'pdf', lisible: true };
  if (!debut.startsWith('PK')) {
    return { format: 'inconnu', lisible: false, motif: 'format d archive non reconnu' };
  }
  return null;
}
