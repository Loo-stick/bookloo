// Le chrome d'une surface de lecture : la barre qui s'efface, et l'appui qui la rappelle.
//
// POURQUOI PARTAGE. Deux surfaces plein ecran l'utilisent — la visionneuse et la liseuse
// PDF — et elles doivent se ressembler : le depot le note deja pour la liseuse EPUB,
// « deux surcouches qui ne se ressembleraient pas » desorienteraient.
//
// MAIS SURTOUT, LE RECOPIER A DEJA COUTE UNE FONCTIONNALITE. La liseuse PDF reprenait les
// classes `visionneuse` et `lecteur-barre` sans poser `chrome` : le style gardait donc sa
// barre a `opacity: 0` et `pointer-events: none`. Les boutons « ‹ » et « › » existaient,
// invisibles et incliquables — on ne pouvait plus tourner les pages d'un PDF qu'au
// clavier. Signale a l'usage, et invisible autrement : aucune erreur, un bouton
// simplement transparent.
//
// Une regle de style qui depend d'une classe posee ailleurs est un contrat. Il vaut mieux
// qu'un seul code le tienne.

/** Combien de temps la barre reste avant de s'effacer. */
const DELAI_MS = 2600;

/**
 * Installe le chrome sur une surcouche.
 *
 * La barre est visible A L'OUVERTURE — sinon rien n'apprend qu'elle existe — puis
 * s'efface. Le pointeur pose dessus la retient : on ne veut pas qu'elle disparaisse sous
 * le doigt au moment de viser un bouton.
 */
function installerChrome(surcouche, barre) {
  let minuteur = null;

  function montrer(effacer = true) {
    surcouche.classList.add('chrome');
    clearTimeout(minuteur);
    if (effacer) minuteur = setTimeout(() => surcouche.classList.remove('chrome'), DELAI_MS);
  }

  function basculer() {
    if (surcouche.classList.contains('chrome')) {
      clearTimeout(minuteur);
      surcouche.classList.remove('chrome');
    } else {
      montrer();
    }
  }

  if (barre) {
    barre.addEventListener('pointerenter', () => montrer(false));
    barre.addEventListener('pointerleave', () => montrer());
  }

  return { montrer, basculer, arreter: () => clearTimeout(minuteur) };
}

if (typeof module !== 'undefined') {
  module.exports = { installerChrome, DELAI_MS };
}
