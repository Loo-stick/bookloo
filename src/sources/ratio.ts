// Quelles sources coutent du ratio, et pourquoi.
//
// POURQUOI CE FICHIER EXISTE. Deposer une release chez AllDebrid ou TorBox fait
// telecharger le torrent PAR LE DEBRIDEUR, avec la passkey de l'utilisateur. Sur un
// tracker prive, c'est compte sur son compte comme un telechargement — et il ne
// reuploade jamais, puisque le fichier ne passe pas par sa machine. Le deficit est
// structurel, et invisible depuis l'interface : on clique sans savoir ce que ca coute.
//
// La regle est simple et se lit sur la source elle-meme : un tracker qui exige une
// PASSKEY compte ce qu'on lui prend. Les autres non.

/**
 * Sources dont on SAIT qu'elles ne debitent rien.
 *
 * La liste enumere les gratuites, et non les payantes, et ce sens n'est pas indifferent :
 * une source ajoutee demain sans qu'on pense a ce fichier sera traitee comme couteuse.
 * L'erreur fera rater une occasion, au lieu de promettre une gratuite qui n'existe pas —
 * et dans ce second cas c'est le compte de l'utilisateur qui paie.
 *
 * Aucune n'exige de passkey : rien n'identifie le compte de l'utilisateur aupres d'elles.
 */
const SANS_RATIO = new Set(['nyaa', 'knaben', 'wawacity', 'telegram', 'zone-ebook', 'bookys']);

/**
 * Vrai si obtenir une release de cette source debite le ratio.
 *
 * Une source INCONNUE est traitee comme coutant du ratio : c'est le sens prudent.
 */
export function compteAuRatio(sourceId: string): boolean {
  return !SANS_RATIO.has(sourceId);
}

/**
 * Vrai si la release s'obtient SANS toucher au ratio, par l'une au moins de ses sources.
 *
 * Le dedoublonnage fusionne une meme release trouvee sur plusieurs trackers : la source
 * principale est celle qui a repondu la premiere, les autres vivent dans `aussiSur`. Une
 * release trouvee sur Ygg ET sur Nyaa s'obtient donc gratuitement, meme si Ygg l'a
 * annoncee en premier — et c'est precisement le cas qu'on veut faire ressortir.
 */
export function sansRatio(c: { source: string; aussiSur?: string[] }): boolean {
  if (!compteAuRatio(c.source)) return true;
  return (c.aussiSur || []).some((s) => !compteAuRatio(s));
}
