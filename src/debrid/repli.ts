// La regle commune aux deux debrideurs quand le depot du .torrent echoue.
//
// POURQUOI CE MODULE EXISTE. `alldebrid.ts` et `torbox.ts` portent tous les deux le
// commentaire « ON NE RETOMBE PAS SUR LE MAGNET », et tous les deux y retombaient des que
// `deposerFichier` rendait `null`. La promesse etait ecrite a deux endroits, tenue a
// aucun. Elle vit maintenant a un seul, et elle est executee par un test.

/**
 * Faut-il renoncer plutot que deposer un magnet nu, apres l'echec du depot du fichier ?
 *
 * `true` des qu'un `.torrent` etait disponible. Sa seule existence dit que la release
 * vient d'un tracker qui publie un annonceur — et le magnet construit en secours,
 * `magnet:?xt=urn:btih:<hash>`, n'en porte AUCUN. Sur un tracker prive il est inerte : il
 * reste « checking 0 % » dans le compte de l'utilisateur, sans jamais aboutir, et il faut
 * l'y supprimer a la main.
 *
 * Mieux vaut un echec franc, que l'interface sait dire, qu'une entree fantome.
 */
export function abandonnerPlutotQueMagnetNu(torrentUrl: string | null | undefined): boolean {
  return Boolean(torrentUrl && torrentUrl.trim());
}
