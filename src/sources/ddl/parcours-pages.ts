// Lire des pages de liste, de la plus recente vers les plus anciennes, jusqu'au connu.
//
// POURQUOI UN MODULE COMMUN. Ecrite d'abord pour downmagaz — dont le sitemap est fige —
// la boucle sert aussi a worldivx, qui n'a pas de sitemap du tout. Les deux sites rangent
// leurs listes du plus recent au plus ancien, et la question est la meme : jusqu'ou lire
// pour tout avoir la premiere fois, et presque rien les fois suivantes. Recopier la
// reponse aurait donne deux regles d'arret qui divergent.
//
// Module pur : le reseau est dans `lirePage`, la lecture du HTML dans `extraire`.

export interface ParcoursPages<T> {
  /** Le HTML de la page `n` (a partir de 1), ou `null` quand elle n'a pas pu etre lue. */
  lirePage: (n: number) => Promise<string | null>;
  /** Les fiches d'une page. */
  extraire: (html: string) => T[];
  /** La cle d'une fiche dans l'index : categorie, slug. */
  cle: (fiche: T) => [string, string];
  /** L'index connait-il deja cette fiche ? */
  connait?: (categorie: string, slug: string) => boolean;
  ecrire: (fiches: T[]) => void;
  maxPages: number;
  /** Combien de pages DE SUITE sans rien de nouveau avant de s'arreter. */
  arretApres: number;
  pause?: () => Promise<void>;
}

/**
 * S'ARRETER APRES PLUSIEURS PAGES CONNUES, PAS UNE : l'ordre des pages n'est pas strict,
 * une fiche modifiee remontant en tete. Mesure du 2026-09-11 chez downmagaz : la page 2
 * descendait jusqu'au numero 124 257 quand la page 3 commencait a 124 366.
 *
 * ET S'ARRETER NET sur une page illisible ou vide : c'est la fin de la liste, ou un site
 * qui ne sert plus ses pages comme avant, et continuer ne rapporterait rien.
 */
export async function parcourirPages<T>(o: ParcoursPages<T>): Promise<{ pages: number; nouvelles: number }> {
  let dejaConnues = 0;
  let pages = 0;
  let total = 0;
  for (let n = 1; n <= o.maxPages && dejaConnues < o.arretApres; n += 1) {
    const html = await o.lirePage(n);
    if (html === null) break;
    const fiches = o.extraire(html);
    if (!fiches.length) break;
    pages += 1;
    const nouvelles = o.connait ? fiches.filter((f) => !o.connait!(...o.cle(f))) : fiches;
    dejaConnues = nouvelles.length ? 0 : dejaConnues + 1;
    if (nouvelles.length) { o.ecrire(nouvelles); total += nouvelles.length; }
    if (o.pause) await o.pause();
  }
  return { pages, nouvelles: total };
}
