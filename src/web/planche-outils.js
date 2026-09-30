// Trois calculs de planche, sortis de la visionneuse pour etre executes par des tests.
//
// Chacun se trompe SANS BRUIT : un rognage trop gourmand mange un bord de case, une
// double page mal detectee coupe un dessin en deux, une navigation en demi-pages saute
// une moitie. Rien de tout cela ne leve d'erreur — cela s'affiche, simplement faux.

/**
 * La boite utile d'une planche : ou commencent les dessins, marges retirees.
 *
 * `luminosite(x, y)` rend 0 (noir) a 255 (blanc). On travaille sur une VIGNETTE, jamais
 * sur la planche pleine : deux cents pixels de large suffisent a trouver une marge, et
 * scanner dix millions de pixels par page ferait ramer le navigateur.
 *
 * Rend des FRACTIONS, pas des pixels : la vignette et la planche n'ont pas la meme taille,
 * et une fraction s'applique a l'une comme a l'autre.
 *
 * PRUDENTE PAR CONSTRUCTION : une ligne compte comme marge seulement si TOUS ses pixels
 * sont clairs. Un seul pixel de dessin la sauve — mieux vaut garder une marge que manger
 * un trait.
 */
function boiteUtile(luminosite, largeur, hauteur, seuil = 247) {
  const ligneVide = (y) => {
    for (let x = 0; x < largeur; x++) if (luminosite(x, y) < seuil) return false;
    return true;
  };
  const colonneVide = (x) => {
    for (let y = 0; y < hauteur; y++) if (luminosite(x, y) < seuil) return false;
    return true;
  };

  let haut = 0;
  while (haut < hauteur - 1 && ligneVide(haut)) haut++;
  let bas = hauteur - 1;
  while (bas > haut && ligneVide(bas)) bas--;
  let gauche = 0;
  while (gauche < largeur - 1 && colonneVide(gauche)) gauche++;
  let droite = largeur - 1;
  while (droite > gauche && colonneVide(droite)) droite--;

  // Une planche ENTIEREMENT claire — une page blanche, un intercalaire — ne doit pas se
  // reduire a un point : on la rend telle quelle.
  if (bas <= haut || droite <= gauche) return { haut: 0, bas: 1, gauche: 0, droite: 1 };

  return {
    haut: haut / hauteur,
    bas: (bas + 1) / hauteur,
    gauche: gauche / largeur,
    droite: (droite + 1) / largeur,
  };
}

/**
 * Cette planche est-elle une double page ?
 *
 * Un scan de manga garde parfois la double page en UN seul fichier, deux fois plus large
 * que haut. Le seuil est a 1,2 et non a 1,0 : une planche simple peut etre legerement
 * plus large que haute — une couverture, un format a l'italienne — sans etre une double.
 */
function estDoublePage(largeur, hauteur) {
  return hauteur > 0 && largeur / hauteur >= 1.2;
}

/**
 * La position suivante, en tenant compte des demi-pages.
 *
 * `position` vaut `{ page, moitie }`. `moitie` ne compte que sur une double page coupee :
 * 0 est la moitie qu'on lit EN PREMIER, et ce n'est pas la meme des deux cotes — en
 * lecture droite a gauche, on commence par la moitie DROITE.
 *
 * LE NUMERO DE PAGE NE CHANGE PAS quand on passe d'une moitie a l'autre. C'est ce qui
 * permet a la reprise de lecture, a la reglette et aux positions deja enregistrees de
 * continuer a designer la meme chose : couper une planche en deux ne doit pas renumeroter
 * le tome.
 */
function avancer(position, nb, estCoupee) {
  const { page, moitie } = position;
  if (estCoupee(page) && moitie === 0) return { page, moitie: 1 };
  if (page + 1 >= nb) return { page, moitie };
  return { page: page + 1, moitie: 0 };
}

/** La position precedente. On revient sur la SECONDE moitie de la planche d'avant. */
function reculer(position, estCoupee) {
  const { page, moitie } = position;
  if (moitie === 1) return { page, moitie: 0 };
  if (page - 1 < 0) return { page, moitie };
  return { page: page - 1, moitie: estCoupee(page - 1) ? 1 : 0 };
}

if (typeof module !== 'undefined') {
  module.exports = { boiteUtile, estDoublePage, avancer, reculer };
}
