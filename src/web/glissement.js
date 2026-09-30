// De quel cote la planche sort, et de quel cote la suivante entre.
//
// POURQUOI C'EST UN MODULE A PART. Ce sont deux signes, et les intervertir donne une
// animation qui part du mauvais cote — la page semble alors reculer pendant qu'on avance.
// Rien ne le signale : ca s'anime, simplement a l'envers. Et tout s'inverse en lecture
// droite a gauche, ou l'on tourne comme une page de papier japonais.

/**
 * Le trajet d'un tour de page.
 *
 * `sortie` est le decalage vers lequel la planche courante s'en va, `entree` celui d'ou la
 * suivante arrive. Tous deux en pixels, relatifs a la position de repos.
 *
 * EN LECTURE GAUCHE A DROITE, avancer fait sortir la planche par la GAUCHE — elle part du
 * cote vers lequel le doigt a pousse — et la nouvelle arrive par la droite. En manga,
 * exactement l'inverse.
 */
function glissementDePage(quoi, sens, largeur) {
  const versLaGauche = sens === 'rtl' ? quoi === 'precedente' : quoi === 'suivante';
  const signe = versLaGauche ? -1 : 1;
  return { sortie: signe * largeur, entree: -signe * largeur };
}

if (typeof module !== 'undefined') {
  module.exports = { glissementDePage };
}
