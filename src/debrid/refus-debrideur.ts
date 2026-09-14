// Memoire des REFUS d un debrideur, par service.
//
// POURQUOI C'EST NECESSAIRE ICI, alors que ca ne l'etait pas pour les torrents : un lien
// d'hebergeur meurt, et le site continue de l'afficher pendant des semaines. Sans cette
// memoire, chaque ouverture de la release repaierait le meme aller-retour pour le meme
// echec.
//
// CE N'EST PAS UNE MEMOIRE DE « LIENS MORTS », ET LE NOM COMPTAIT.
//
// Elle s'appelait ainsi, et je l'ai crue. `LINK_DOWN` est le mot d'AllDebrid : il dit
// qu'ALLDEBRID n'a pas su ouvrir ce lien, pas que le fichier a disparu. Signale a l'usage
// le 2026-09-02 — « lien mort — 2026-09-02 » sur
// `dailyuploads.net/nq2nitcpihiz/M.mento.Septembre.2026.pdf`, qui s'ouvrait parfaitement
// au navigateur. L'URL retenue etait identique au caractere pres : ce n'etait pas une
// erreur de lecture, c'etait une conclusion trop large.
//
// DEUX CONSEQUENCES, ET ELLES ETAIENT GRAVES A LA MEME HAUTEUR :
//
// Le refus valait pour TOUS les services. Ce qu'AllDebrid ne sait pas ouvrir, un autre
// debrideur le peut ; la memoire est donc indexee par (service, url).
//
// Il durait SEPT JOURS. Sur le mot d'un tiers, a propos d'un fichier qu'on n'a pas
// verifie soi-meme, c'est une eternite : une release parfaitement vivante restait fermee
// une semaine. Six heures suffisent a ne pas repayer l'aller-retour.

/** Six heures : de quoi ne pas repayer l'echec, pas de quoi condamner une release. */
const TTL_MS = 6 * 60 * 60 * 1000;
export const MAX_ENTREES = 5000;

const refus = new Map<string, number>();

const cle = (service: string, url: string) => `${service}|${url}`;

export function marquerRefus(service: string, url: string): void {
  if (!url) return;
  const maintenant = Date.now();
  // RETIRER D'ABORD L'ENTREE COURANTE : sans ca un re-marquage la comptait dans la taille
  // avant de la reecrire, et la purge sacrifiait une entree pour rien.
  const k = cle(service, url);
  refus.delete(k);
  for (const [x, v] of refus) if (v < maintenant) refus.delete(x);
  // Le plafond se verifie APRES la purge et AVANT l'insertion : la premiere redaction
  // taillait a `MAX_ENTREES` exactement, et le `set` qui suivait repassait aussitot a
  // `MAX_ENTREES + 1`. Sans consequence reelle, mais un plafond qui n'est pas le plafond
  // annonce finit par tromper quelqu'un.
  if (refus.size >= MAX_ENTREES) {
    const parAnciennete = [...refus.entries()].sort((a, b) => a[1] - b[1]);
    for (const [x] of parAnciennete.slice(0, refus.size - MAX_ENTREES + 1)) refus.delete(x);
  }
  refus.set(k, maintenant + TTL_MS);
}

/** Ce service a-t-il RECEMMENT refuse ce lien ? Jamais « ce lien est mort ». */
export function estRefuse(service: string, url: string): boolean {
  const k = cle(service, url);
  const expire = refus.get(k);
  if (expire === undefined) return false;
  if (expire < Date.now()) {
    refus.delete(k);
    return false;
  }
  return true;
}

/** Depuis quand ce service refuse-t-il ce lien ? Sert a l'afficher, pas a decider. */
export function refuseDepuis(service: string, url: string): Date | undefined {
  const expire = refus.get(cle(service, url));
  return expire === undefined ? undefined : new Date(expire - TTL_MS);
}

/** Le nombre d'entrees retenues. Exporte pour que le plafond se VERIFIE, pas se relise. */
export function nombreRefus(): number {
  return refus.size;
}

/** Vide la memoire — les tests, et rien d'autre. */
export function viderRefus(): void {
  refus.clear();
}
