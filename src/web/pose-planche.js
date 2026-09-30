// Ou poser la planche dans la scene, une fois qu'on lui a retire ses marges, qu'on n'en
// montre qu'une moitie, et qu'on l'a agrandie.
//
// POURQUOI CE MODULE EXISTE. Ces quatre reglages se composent, et leur composition ne se
// verifie pas a l'oeil sans navigateur : une planche mal posee s'affiche quand meme —
// decalee, coupee, ou minuscule — sans lever la moindre erreur. Le calcul est donc ici,
// pur, et la visionneuse ne fait qu'appliquer ce qu'il rend.

/**
 * La pose d'une planche.
 *
 * `nat` : ses dimensions reelles. `cadre` : la place disponible. `boite` : la zone utile
 * en fractions (voir `boiteUtile`) — `null` pour ne rien rogner. `moitie` : `null` pour la
 * planche entiere, 0 ou 1 pour une double page coupee, 0 etant la moitie GAUCHE.
 * `ajustement` : « hauteur », « largeur » ou « originale ». `zoom` : multiplicateur.
 *
 * Rend la taille a donner a l'image, le decalage qui centre la zone visible dans le cadre,
 * et le rognage en pourcentages — un `clip-path: inset(...)`, qui ne change pas la mise en
 * page et se compose donc proprement avec le reste.
 */
const pourcent = (f) => Math.round(f * 100000) / 1000;

function poseDePlanche({ nat, cadre, boite, moitie, ajustement, zoom = 1 }) {
  const b = boite || { haut: 0, bas: 1, gauche: 0, droite: 1 };
  // La zone utile, en fractions de l'image.
  let g = b.gauche;
  let d = b.droite;
  const hb = b.haut;
  const bb = b.bas;

  // Une moitie se prend DANS la zone utile, pas dans l'image brute : sinon le rognage des
  // marges decalerait la coupure et un dessin serait tranche de travers.
  if (moitie !== null && moitie !== undefined) {
    const milieu = (g + d) / 2;
    if (moitie === 0) d = milieu;
    else g = milieu;
  }

  const visibleL = Math.max(1, (d - g) * nat.l);
  const visibleH = Math.max(1, (bb - hb) * nat.h);

  let echelle;
  if (ajustement === 'originale') echelle = 1;
  else if (ajustement === 'largeur') echelle = cadre.l / visibleL;
  else echelle = Math.min(cadre.l / visibleL, cadre.h / visibleH);
  echelle *= zoom;

  // Le centre de la zone visible, en pixels de l'image mise a l'echelle.
  const centreX = (g + d) / 2 * nat.l * echelle;
  const centreY = (hb + bb) / 2 * nat.h * echelle;

  return {
    largeur: Math.round(nat.l * echelle),
    hauteur: Math.round(nat.h * echelle),
    // Le decalage amene le centre de la zone visible au centre du cadre.
    dx: Math.round(cadre.l / 2 - centreX),
    dy: Math.round(cadre.h / 2 - centreY),
    // ARRONDI A TROIS DECIMALES, et ce n'est pas de la coquetterie : `0.1 * 100` ne vaut
    // pas exactement 10 en virgule flottante, et ce nombre-la partirait tel quel dans un
    // `clip-path: inset(10.000000000000002% ...)`. Le navigateur l'accepte, mais la valeur
    // devient impossible a comparer — dans un test comme a l'oeil.
    clip: {
      haut: pourcent(hb),
      droite: pourcent(1 - d),
      bas: pourcent(1 - bb),
      gauche: pourcent(g),
    },
  };
}

if (typeof module !== 'undefined') {
  module.exports = { poseDePlanche };
}
