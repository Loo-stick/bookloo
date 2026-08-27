// Rapprochement d'une fiche de catalogue et d'un nom de release.
//
// C'est le maillon fragile de la chaine : MangaDex parle en titres officiels, les teams
// de scan en noms de fichiers.
//
// DEUX PIEGES MESURES SUR DE VRAIES DONNEES :
//
//   - Un titre COURT et COURANT valide n'importe quoi. « Smile! » se reduit a « smile »,
//     et laissait passer « Smile Down the Runway », « Kiko-chan's Smile », « Power of
//     Smile » — 91 fausses correspondances sur une seule recherche.
//   - Le NOM DE L'AUTEUR est presque toujours dans le nom de fichier des teams
//     francaises : « Smile.T05.Hattori.Mitei.FR.[CBZ] ». MangaDex le fournit. C'est le
//     signal le plus discriminant dont on dispose, et il etait inutilise.
//
// PRINCIPE INCHANGE : en dessous du seuil, on NE JETTE PAS. La release part dans un
// repli « correspondances incertaines », visible et replie. Un faux negatif silencieux
// est plus penible qu'une ligne en trop.

import { normaliserTitre } from '../sources/torrent/release';
import type { Oeuvre } from './mangadex';

export const SEUIL_CERTAIN = 0.6;

/**
 * Longueur minimale pour qu'un titre CONTENU vaille une correspondance forte.
 *
 * Des fiches portent des alias de deux ou trois lettres. Les traiter comme un titre
 * complet ferait passer toute release qui les contient par hasard.
 */
const LONGUEUR_MIN_CONTENU = 5;

/** Au-dela, un titre d'un seul mot reste discriminant malgre sa brievete. */
const MOT_UNIQUE_SUR = 8;

/**
 * Mots de conditionnement, jamais des titres d'oeuvre.
 *
 * Ils s'intercalent entre le titre et le marqueur de tome — « Smile.PACK.T01.a.T04 » —
 * et empechaient l'egalite exacte qui vaut 0,9. La liste reste courte et prudente :
 * elle ne contient que des marqueurs de format, jamais un mot pouvant appartenir a un
 * titre.
 */
const MOTS_CONDITIONNEMENT = new Set([
  'pack', 'integrale', 'integral', 'scan', 'scans', 'scantrad', 'complet', 'complete',
  'french', 'fr', 'vf', 'vostfr', 'multi', 'cbz', 'cbr', 'pdf', 'epub', 'digital', 'web',
]);

/**
 * Partie « titre » d'un nom de release : ce qui precede le premier marqueur de tome,
 * de chapitre ou d'annee, debarrasse des mots de conditionnement.
 *
 * « Smile.T05.Hattori.Mitei.FR.[CBZ] » -> « smile ». C'est cette partie qu'on compare,
 * parce qu'une egalite avec elle est un signal bien plus fort qu'une simple presence
 * quelque part dans la chaine.
 */
export function partieTitre(titreRelease: string): string {
  const normalise = normaliserTitre(titreRelease);
  const coupure = normalise.search(/\b(?:t|tome|tomes|v|vol|c|ch|chapitre|integrale)\s*\d|\b(?:19|20)\d{2}\b/);
  const avant = coupure === -1 ? normalise : normalise.slice(0, coupure);
  return avant
    .split(' ')
    .filter((m) => m && !MOTS_CONDITIONNEMENT.has(m))
    .join(' ')
    .trim();
}

/** Jetons d'auteur exploitables : « Hattori Mitei » -> ['hattori', 'mitei']. */
function jetonsAuteur(auteur: string | undefined): string[] {
  if (!auteur) return [];
  return normaliserTitre(auteur)
    .split(' ')
    .filter((m) => m.length >= 4);
}

/** Ecritures que `normaliserTitre` efface entierement. */
const NON_LATIN = /[\u0400-\u04FF\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7AF]/;

export function scorer(oeuvre: Oeuvre, titreRelease: string): number {
  const cible = normaliserTitre(titreRelease);
  if (!cible) return 0;
  const partie = partieTitre(titreRelease);

  // `normaliserTitre` efface les caracteres non latins. Sur un titre japonais, elle peut
  // donc FABRIQUER une egalite qui n'existe pas : « ラブライブ! ～Smile～ » se reduisait a
  // « smile » et decrochait 0,9. Constate sur un artbook, dans une recherche Smiley!.
  const artefact = NON_LATIN.test(titreRelease);

  // Le nom de l'auteur dans le nom de fichier est le signal le plus discriminant :
  // « Smile » tout seul est ambigu, « Smile ... Hattori Mitei » ne l'est plus.
  const jetons = jetonsAuteur(oeuvre.auteur);
  const auteurPresent = jetons.length > 0 && jetons.some((j) => cible.includes(j));
  const bonus = auteurPresent ? 0.3 : 0;

  let meilleur = 0;
  for (const forme of oeuvre.titres) {
    const t = normaliserTitre(forme);
    // Les titres non latins se normalisent en chaine vide : ils ne comptent pas, et ne
    // doivent surtout pas faire echouer le calcul.
    if (!t || t.length < LONGUEUR_MIN_CONTENU) continue;

    // Egalite avec la partie titre : le signal le plus fort. « Smile.T05... » -> « smile ».
    // Sauf si cette egalite n'est qu'un residu de normalisation (voir `artefact`).
    if (partie === t && !artefact) {
      meilleur = Math.max(meilleur, 0.9);
      continue;
    }

    if (` ${cible} `.includes(` ${t} `)) {
      const motUnique = !t.includes(' ');
      const brut = Math.min(1, 0.6 + Math.min(0.3, t.length / 40));
      // Un mot unique et court, present sans etre le titre entier, n'est pas une
      // correspondance : c'est une coincidence de vocabulaire. Sauf si l'auteur
      // corrobore.
      meilleur = Math.max(meilleur, motUnique && t.length < MOT_UNIQUE_SUR ? 0.45 : brut);
      continue;
    }

    const motsTitre = t.split(' ');
    const motsCible = new Set(cible.split(' '));
    let communs = 0;
    for (const m of motsTitre) if (motsCible.has(m)) communs++;
    meilleur = Math.max(meilleur, (communs / motsTitre.length) * 0.55);
  }

  return Math.min(1, meilleur + bonus);
}
