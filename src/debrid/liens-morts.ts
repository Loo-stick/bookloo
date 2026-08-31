// Memoire des liens morts.
//
// POURQUOI C'EST NECESSAIRE ICI, alors que ca ne l'etait pas pour les torrents : un
// lien d'hebergeur MEURT, et le site continue de l'afficher pendant des semaines.
// Mesure du 2026-08-20 : sur les deux premiers liens essayes d'une meme fiche, le
// premier repondait LINK_DOWN.
//
// Sans cette memoire, chaque ouverture de la release repaierait le meme aller-retour
// pour le meme echec.

const TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_ENTREES = 5000;

const morts = new Map<string, number>();

export function marquerMort(url: string): void {
  if (!url) return;
  const maintenant = Date.now();
  // RETIRER D'ABORD L'URL COURANTE : sans ca un re-marquage la comptait dans la taille
  // avant de la reecrire, et la purge sacrifiait une entree pour rien.
  morts.delete(url);
  for (const [k, v] of morts) if (v < maintenant) morts.delete(k);
  // ON FAIT DE LA PLACE POUR CELLE QU'ON AJOUTE. La condition testait la taille AVANT
  // l'insertion et taillait a `MAX_ENTREES` exactement : le `set` qui suit repassait
  // aussitot a `MAX_ENTREES + 1`, ou la table se stabilisait. Sans consequence reelle,
  // mais un plafond qui n'est pas le plafond annonce finit par tromper quelqu'un.
  if (morts.size >= MAX_ENTREES) {
    const parAnciennete = [...morts.entries()].sort((a, b) => a[1] - b[1]);
    for (const [k] of parAnciennete.slice(0, morts.size - MAX_ENTREES + 1)) morts.delete(k);
  }
  morts.set(url, maintenant + TTL_MS);
}

export function estMort(url: string): boolean {
  const expire = morts.get(url);
  if (expire === undefined) return false;
  if (expire < Date.now()) {
    morts.delete(url);
    return false;
  }
  return true;
}

/** Depuis quand ce lien est-il connu mort ? Sert a l'afficher, pas a decider. */
export function morteDepuis(url: string): Date | undefined {
  const expire = morts.get(url);
  return expire === undefined ? undefined : new Date(expire - TTL_MS);
}

/** Exportee pour les tests. */
/** Le nombre d'entrees retenues. Exporte pour que le plafond se VERIFIE, pas se relise. */
export function tailleCache(): number {
  return morts.size;
}

export function viderMorts(): void {
  morts.clear();
}
