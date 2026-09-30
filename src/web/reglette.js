// La reglette de planches : ou l'on pointe, et quelle planche cela designe.
//
// POURQUOI C'EST UN MODULE A PART. La correspondance entre une abscisse et un numero de
// planche se trompe SANS BRUIT : on atterrit sur la planche 40 au lieu de la 42, et rien
// ne dit que c'est faux. En lecture DROITE A GAUCHE elle s'inverse, et c'est precisement
// le genre de detail qu'on croit avoir traite.

/**
 * La planche designee par une abscisse sur la reglette.
 *
 * `x` est relatif au bord gauche de la reglette, `largeur` sa largeur en pixels. En
 * lecture droite a gauche, le bord droit est le DEBUT : la premiere planche d'un manga
 * est a droite, et une reglette qui l'ignorerait mentirait sur le sens de lecture.
 *
 * Le resultat est toujours dans [0, nb-1] : un doigt qui deborde de quelques pixels ne
 * doit pas rendre une planche qui n'existe pas.
 */
function planchePointee(x, largeur, nb, rtl) {
  if (!(nb > 0)) return 0;
  if (!(largeur > 0)) return 0;
  const fraction = Math.min(1, Math.max(0, x / largeur));
  // `floor` et non `round` : chaque planche occupe une bande EGALE, et arrondir donnerait
  // deux demi-bandes aux extremites — viser la premiere planche serait deux fois plus dur
  // que viser la deuxieme.
  const gauche = Math.min(nb - 1, Math.max(0, Math.floor(fraction * nb)));
  // ON REFLETE L'INDICE, PAS LA FRACTION. Inverser la fraction AVANT d'arrondir decale
  // d'une planche au milieu exact : sur cent planches, le centre rendait la 50 au lieu de
  // la 49. Le miroir de l'indice est symetrique par construction, et le test le verifie.
  return rtl ? nb - 1 - gauche : gauche;
}

if (typeof module !== 'undefined') {
  module.exports = { planchePointee };
}
