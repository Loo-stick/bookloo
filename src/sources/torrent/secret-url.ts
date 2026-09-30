// Retirer un secret d'une URL avant de la mettre en cache, et l'y remettre a la lecture.
//
// POURQUOI. Le cache de ce projet est PERSISTANT sur SQLite, et sa cle n'inclut pas
// l'utilisateur : c'est deliberé, deux personnes qui cherchent la meme oeuvre ne doivent
// interroger le tracker qu'une fois. Mais le lien de telechargement rendu par un tracker
// prive porte la cle de celui qui a declenche la requete — releve le 2026-08-29 dans une
// vraie base :
//
//   https://c411.org/api?t=get&id=7ee2ff05…&apikey=<la cle de l'utilisateur>
//
// Il s'ecrivait donc sur disque, et le compte suivant le recevait tel quel.
//
// LA MUTUALISATION EST CONSERVEE : on cache un lien ANONYME, et chacun y remet sa propre
// cle au moment de s'en servir. Personne ne recoit celle d'un autre, et le tracker n'est
// toujours interroge qu'une fois.

/**
 * Parametres qui portent un secret de tracker. LE NOM EST LA PREUVE : personne n'appelle
 * « passkey » autre chose qu'une passkey.
 *
 * La meme liste que `core/masque.ts`, dans le meme esprit — on ne masque jamais par
 * ressemblance, une empreinte de torrent ayant exactement la forme de certaines cles.
 */
const SECRETS = ['apikey', 'api_key', 'api_token', 'passkey', 'rsskey', 'token', 'key', 'secret', 'auth'];

/** L'URL sans aucun de ses parametres secrets. Rendue telle quelle si elle est illisible. */
export function sansSecretUrl(url: string): string {
  if (!url) return url;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    // Une URL qu'on ne sait pas lire n'est pas nettoyable : l'appelant DOIT alors refuser
    // de la cacher plutot que de la cacher intacte. Voir `cachable()`.
    return url;
  }
  for (const nom of [...u.searchParams.keys()]) {
    if (SECRETS.includes(nom.toLowerCase())) u.searchParams.delete(nom);
  }
  return u.toString().replace(/\?$/, '');
}

/** La meme URL, avec le secret du DEMANDEUR. Remplace une valeur deja presente. */
export function avecSecretUrl(url: string, nom: string, valeur: string): string {
  if (!url || !valeur) return url;
  try {
    const u = new URL(url);
    u.searchParams.set(nom, valeur);
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * Peut-on mettre cette URL en cache sans risque ?
 *
 * UNE SOURCE DONT ON NE SAIT PAS RETIRER LE SECRET N'EST PAS CACHEE. C'est la regle qui
 * rend l'ensemble sur : un lien signe qu'on ne sait pas lire, ou dont le secret vit dans le
 * chemin plutot que dans la requete, ne doit pas etre partage par defaut.
 */
export function cachable(url: string | undefined): boolean {
  if (!url) return true;
  try {
    const u = new URL(url);
    return ![...u.searchParams.keys()].some((n) => SECRETS.includes(n.toLowerCase()));
  } catch {
    return false;
  }
}
