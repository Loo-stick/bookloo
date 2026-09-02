// Ce qui, dans une release, s'ecoute — et dans quel ordre.
//
// Fonctions pures, sans reseau : c'est ici que se decide le sommaire d'un livre audio, et
// un sommaire se teste. Le reste du chantier (depot chez le debrideur, relais des octets)
// n'a plus qu'a s'appuyer dessus.

/** Une piste du sommaire, telle que le navigateur la recevra. */
export interface Piste {
  /** Index dans le sommaire, a partir de zero — comme `planche` pour la visionneuse. */
  n: number;
  /** Chemin complet dans la release. Le relais s'en sert pour retrouver le fichier. */
  nom: string;
  titre: string;
  octets?: number;
  id?: number | string;
}

/**
 * Extensions que TOUS les navigateurs visés savent jouer dans une balise `<audio>`.
 *
 * `m4b` n'y est pas, et ce n'est pas un oubli : voir `raisonNonEcoutable`.
 */
const ECOUTABLES = new Set(['mp3', 'm4a', 'ogg', 'opus', 'wav', 'flac', 'aac']);

function extension(nom: string): string {
  const base = nom.split('/').pop() || nom;
  const i = base.lastIndexOf('.');
  return i === -1 ? '' : base.slice(i + 1).toLowerCase();
}

export function estEcoutable(nom: string): boolean {
  return ECOUTABLES.has(extension(nom));
}

/**
 * Pourquoi un fichier n'est pas offert a l'ecoute. `null` s'il l'est.
 *
 * LE M4B EST UN REFUS DELIBERE, PAS UNE LIMITE TECHNIQUE. Le navigateur sait jouer le
 * conteneur ; ce qu'on ne sait pas encore lire, ce sont ses chapitres, qui vivent dans
 * l'entete MP4 sous deux formes incompatibles — un atome `chpl` sous `moov/udta`, ou une
 * piste de texte designee par `tref/chap`.
 *
 * Aucun des 7 M4B de la categorie 7105 n'etait en cache le 2026-08-26, ni chez AllDebrid
 * ni chez TorBox : la structure n'a pas pu etre mesuree. Ecrire l'analyseur en devinant
 * laquelle des deux formes employer serait refaire l'erreur que ce projet a payee trois
 * fois cette semaine. Le fichier reste donc telechargeable, et on le DIT.
 */
export function raisonNonEcoutable(nom: string): string | null {
  const ext = extension(nom);
  if (ECOUTABLES.has(ext)) return null;
  if (ext === 'm4b') {
    return 'm4b — ses chapitres ne sont pas encore lus ici ; le fichier reste telechargeable';
  }
  return `${ext || 'sans extension'} — ce n est pas un enregistrement`;
}

/**
 * Le titre affiche pour une piste, tire de son nom de fichier.
 *
 * Le numero de tete est retire — « 01 - Chapitre 1.mp3 » donne « Chapitre 1 » — mais
 * SEULEMENT si ce qui suit commence par une lettre. Sans cette garde, « 22-11-63.mp3 »
 * deviendrait « 11-63 », et un fichier nomme « 07.mp3 » perdrait son seul libelle.
 */
export function titreDePiste(nom: string): string {
  const base = (nom.split('/').pop() || nom).replace(/\.[a-z0-9]+$/i, '');
  const sansNumero = base.replace(/^\d+\s*[-._)\]]?\s*/, '');
  return /^[^\W\d]/u.test(sansNumero) ? sansNumero : base;
}

/**
 * Le sommaire d'une release : ses pistes ecoutables, dans l'ordre.
 *
 * L'ORDRE VIENT D'ICI, PAS DU DEBRIDEUR, qui rend ses fichiers comme il veut. Le tri est
 * numerique : un tri alphabetique placerait « 10 » avant « 2 », et l'auditeur ecouterait
 * le dixieme chapitre en croyant reprendre le deuxieme.
 */
export function sommaireAudio(
  fichiers: { nom: string; taille?: number; id?: number | string }[],
): Piste[] {
  return fichiers
    .filter((f) => estEcoutable(f.nom))
    .sort((a, b) => a.nom.localeCompare(b.nom, undefined, { numeric: true, sensitivity: 'base' }))
    .map((f, n) => ({
      n, nom: f.nom, titre: titreDePiste(f.nom), octets: f.taille, id: f.id,
    }));
}

/**
 * Le type MIME d'une piste, deduit de son extension.
 *
 * POURQUOI ON NE REPREND PAS CELUI DE L'AMONT. Mesure du 2026-08-26 sur un lien
 * AllDebrid deverrouille : il annonce `application/octet-stream`. Les navigateurs
 * devinent souvent le contenu d'une balise `<audio>` malgre un type faux, mais pas
 * toujours, et le relais est justement l'endroit ou cela se corrige.
 */
export function typeMimeAudio(nom: string): string {
  switch (extension(nom)) {
    case 'mp3': return 'audio/mpeg';
    case 'm4a': case 'aac': return 'audio/mp4';
    case 'ogg': case 'opus': return 'audio/ogg';
    case 'wav': return 'audio/wav';
    case 'flac': return 'audio/flac';
    // Une piste dont l'extension n'est pas reconnue n'aurait pas passe `estEcoutable` :
    // ce repli ne sert qu'a ne jamais rendre une chaine vide.
    default: return 'application/octet-stream';
  }
}
