// Fermer une surface de lecture, c'est trois gestes dans un ordre qui n'est pas libre :
// enregistrer, retirer l'ecran, puis SEULEMENT ENSUITE prevenir l'appelant. C'est ce dernier
// geste qui redessine l'etagere ; parti trop tot, il la redessine sur la position d'AVANT et
// un livre qu'on vient de lire se raffiche « Commencer », au debut.
//
// La visionneuse tenait cet ordre, la liseuse et l'ecoute ne l'ont jamais tenu. Trois copies
// d'une meme regle, dont une seule etait juste : d'ou ce module, pour qu'il ne reste qu'un
// seul endroit ou elle puisse etre fausse.

/**
 * @param {() => unknown} envoyer   Enregistre la position. Appele TOUT DE SUITE, sans
 *                                  attendre : l'envoi doit partir avant que l'ecran tombe.
 * @param {() => void} retirer      Demonte l'ecran de lecture.
 * @param {(() => void)=} prevenir  Averti seulement une fois l'enregistrement acquis.
 * @returns {Promise<void>}
 */
function fermerEnEnregistrant(envoyer, retirer, prevenir) {
  let enregistre;
  try {
    enregistre = Promise.resolve(envoyer());
  } catch {
    enregistre = Promise.resolve();
  }
  retirer();
  // L'avancement est un confort : un envoi perdu ne doit JAMAIS laisser l'etagere figee
  // sur une surface deja fermee. On previent, meme apres un echec.
  return enregistre.catch(() => {}).then(() => {
    if (typeof prevenir === 'function') prevenir();
  });
}

if (typeof module !== 'undefined') {
  module.exports = { fermerEnEnregistrant };
}
