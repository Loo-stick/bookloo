// Ce qu'un glissement de doigt veut dire.
//
// POURQUOI C'EST UN MODULE A PART. Cette decision doit cohabiter avec trois autres gestes
// — le pincement, le deplacement quand on est agrandi, le defilement vertical en mode
// continu — et elle s'inverse en lecture droite a gauche. Chacun de ces cas se trompe SANS
// BRUIT : on tourne une page qu'on ne voulait pas, ou on n'en tourne aucune, et rien ne
// dit pourquoi.

/** En deca de cette fraction de la largeur, c'est un tap, pas un balayage. */
const SEUIL = 0.08;
/** Un balayage doit etre franchement horizontal : sinon c'est un defilement. */
const DOMINANCE = 1.4;

/**
 * Ce que designe un glissement.
 *
 * Rend « suivante », « precedente », ou `null` quand le geste n'est pas un balayage —
 * auquel cas le tap doit garder son effet habituel.
 *
 * LE SENS DE LECTURE INVERSE TOUT. En lecture gauche a droite, pousser le doigt vers la
 * GAUCHE amene la planche suivante — le contenu part du meme cote que le doigt. En manga,
 * c'est l'inverse, et un balayage qui l'ignorerait reculerait a chaque fois qu'on croit
 * avancer.
 *
 * AGRANDI, ON NE TOURNE PAS LA PAGE : le glissement deplace la planche. Confondre les deux
 * ferait sauter une page des qu'on regarde une case de pres.
 *
 * EN MODE CONTINU non plus : le geste horizontal n'a pas de sens dans un defilement
 * vertical, et le capter empecherait le webtoon de defiler en biais.
 */
function gesteDeBalayage({ dx, dy, largeur, zoom = 1, mode = 'page-a-page', sens = 'ltr' }) {
  if (mode !== 'page-a-page') return null;
  if (zoom > 1) return null;
  if (!(largeur > 0)) return null;
  if (Math.abs(dx) < largeur * SEUIL) return null;
  // Le geste doit etre franchement horizontal : sans cette dominance, un defilement
  // legerement de travers tournerait une page.
  if (Math.abs(dx) < Math.abs(dy) * DOMINANCE) return null;

  const versLaGauche = dx < 0;
  const avance = sens === 'rtl' ? !versLaGauche : versLaGauche;
  return avance ? 'suivante' : 'precedente';
}

if (typeof module !== 'undefined') {
  module.exports = { gesteDeBalayage, SEUIL, DOMINANCE };
}
