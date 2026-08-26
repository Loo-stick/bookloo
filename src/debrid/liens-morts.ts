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
const MAX_ENTREES = 5000;

const morts = new Map<string, number>();

export function marquerMort(url: string): void {
  if (!url) return;
  const maintenant = Date.now();
  for (const [k, v] of morts) if (v < maintenant) morts.delete(k);
  if (morts.size > MAX_ENTREES) {
    const parAnciennete = [...morts.entries()].sort((a, b) => a[1] - b[1]);
    for (const [k] of parAnciennete.slice(0, morts.size - MAX_ENTREES)) morts.delete(k);
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
export function viderMorts(): void {
  morts.clear();
}
