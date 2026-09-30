// Relire l'en-tete `Range` d'un navigateur.
//
// PUR, et teste : une plage mal relue ne plante pas, elle sert les MAUVAIS octets. Le
// lecteur PDF affiche alors une page blanche ou refuse le fichier, sans rien dire de
// pourquoi.

/** Ce qu'on sert au plus d'un coup. pdf.js demande de petites plages ; il n'a pas besoin
 *  qu'on lui en donne plus, et un magazine pese trente megaoctets. */
export const TRANCHE_MAX = 2 * 1024 * 1024;

export interface Plage {
  debut: number;
  fin: number;
  /** Vrai quand le client a DEMANDE une plage : la reponse doit alors etre un 206. */
  partielle: boolean;
}

/**
 * La plage a servir, bornee au fichier ET a `TRANCHE_MAX`.
 *
 * Formes admises : `bytes=0-1023`, `bytes=1024-` (jusqu'au bout), `bytes=-2048` (les
 * derniers octets — c'est ainsi qu'un lecteur ZIP cherche le repertoire central, et
 * pdf.js la table des objets).
 *
 * Sans en-tete, ou avec un en-tete illisible, on rend le DEBUT du fichier en reponse
 * complete : un client qui ne demande pas de plage en attend une.
 */
export function plageDemandee(entete: string | undefined, taille: number): Plage {
  const vide = { debut: 0, fin: Math.max(0, Math.min(taille, TRANCHE_MAX) - 1), partielle: false };
  if (taille <= 0) return { debut: 0, fin: 0, partielle: false };
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(entete || '').trim());
  if (!m || (m[1] === '' && m[2] === '')) return vide;

  if (m[1] === '') {
    // « bytes=-N » : les N DERNIERS octets. Le lire comme « de 0 a N » servirait le debut
    // du fichier a un client qui cherche sa fin — et il n'y verrait que du bruit.
    const n = Math.min(Number(m[2]), taille);
    return { debut: taille - n, fin: taille - 1, partielle: true };
  }

  const debut = Math.min(Number(m[1]), Math.max(0, taille - 1));
  const demande = m[2] === '' ? taille - 1 : Math.min(Number(m[2]), taille - 1);
  const fin = Math.min(demande, debut + TRANCHE_MAX - 1);
  return { debut, fin: Math.max(debut, fin), partielle: true };
}
