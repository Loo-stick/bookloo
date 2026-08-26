// Comment s'appelle l'archive qu'on telecharge.
//
// Pur, sans dependance : un nom de fichier se teste, et celui-ci traverse un en-tete HTTP
// ou tout n'est pas permis.
//
// LE TITRE DE LA RELEASE, PAS LE DOSSIER DU TORRENT. La premiere version nommait
// l'archive d'apres le premier segment de chemin, c'est-a-dire le dossier racine du
// torrent : « Stephen King - Holly Gibney 4 - Ne jamais trembler » la ou le tracker
// annonce « Stephen King - Ne jamais trembler [2026] [mp3 a 128 Kb/s] ». Le second dit en
// plus le format et l'annee ; le premier les perd. Seul le client connait ce titre, il le
// transmet donc.

/** Ce qu'aucun systeme de fichiers courant n'accepte dans un nom. */
const INTERDITS = /[\\/:*?"<>|]/g;

/** Signes diacritiques, retires pour la forme ASCII de secours. `\p{M}` = marques. */
const DIACRITIQUES = /\p{M}/gu;

/** Tout ce qui n'est pas de l'ASCII imprimable, ecrit en echappements. */
const HORS_ASCII = /[^\x20-\x7E]/g;

/**
 * Plafond de longueur.
 *
 * ext4 s'arrete a 255 OCTETS, pas 255 caracteres — un titre accentue en consomme deux par
 * accent. 150 caracteres laissent la marge, et un nom plus long ne se lit de toute facon
 * plus dans une liste de telechargements.
 */
const MAX = 150;

/**
 * Remplace les caracteres de controle par une espace.
 *
 * PAS DE CLASSE DE CARACTERES ICI, ET C'EST DELIBERE : ecrite a la main, elle contient des
 * octets invisibles a la relecture, qui se perdent au premier copier-coller et que
 * personne ne peut verifier de l'oeil. Un test de point de code se lit.
 *
 * Ils comptent : le nom vient du client et finit dans un en-tete HTTP, ou un retour a la
 * ligne ouvrirait une ligne.
 */
function sansControle(s: string): string {
  let out = '';
  for (const c of s) {
    const p = c.codePointAt(0) ?? 0;
    out += p < 0x20 || p === 0x7f ? ' ' : c;
  }
  return out;
}

/**
 * Le nom de base de l'archive, sans extension.
 *
 * `titre` est celui annonce par le tracker ; `secours` sert quand il manque — le client
 * peut toujours ne rien envoyer, et une archive doit bien s'appeler quelque chose.
 */
export function nomDArchive(titre: string | undefined, secours: string): string {
  for (const candidat of [titre, secours]) {
    const propre = assainir(candidat || '');
    if (propre) return propre;
  }
  return 'archive';
}

function assainir(brut: string): string {
  return sansControle(brut)
    .replace(INTERDITS, '_')
    // Les espaces multiples viennent souvent du remplacement lui-meme.
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX)
    // Windows refuse un nom qui finit par un point ou une espace.
    .replace(/[. ]+$/, '')
    .trim();
}

/**
 * L'en-tete `Content-Disposition`, dans ses DEUX formes.
 *
 * `filename` en ASCII pour les clients anciens, `filename*` en UTF-8 pour les autres. Un
 * titre francais porte des accents, et les poser tels quels dans un en-tete produit un nom
 * illisible ou une erreur selon le navigateur. La forme UTF-8 est integralement encodee,
 * ce qui la met a l'abri de tout ce qui pourrait ressembler a une injection.
 */
export function dispositionFichier(nomBase: string): string {
  const ascii = nomBase
    .normalize('NFD')
    .replace(DIACRITIQUES, '')
    .replace(HORS_ASCII, '_')
    .replace(/"/g, '_') || 'archive';
  return `attachment; filename="${ascii}.zip"; `
    + `filename*=UTF-8''${encodeURIComponent(nomBase)}.zip`;
}
