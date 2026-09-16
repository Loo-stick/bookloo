// Filtrer les releases par SOURCE.
//
// La regle vient de la page de recherche, ou elle a ete gagnee a l'usage. Elle vit ici pour
// que le panneau de la bibliotheque la partage plutot que d'en ecrire une seconde : deux
// filtres finiraient par diverger, et c'est le compteur qui mentirait.
//
// Module pur, sans DOM : la regle doit etre EXECUTEE par ses tests, pas relue.

/**
 * Toutes les sources ou cette release a ete vue.
 *
 * LA SOURCE PRINCIPALE NE SUFFIT PAS. Une release trouvee sur deux trackers est fusionnee
 * en une seule carte : le premier arrive devient `source`, les autres passent dans
 * `aussiSur`. Or la pastille compte ce que la source a RENDU, doublons compris — ne
 * regarder que `source` faisait annoncer « C411 : 2 » et n'afficher rien.
 */
function sourcesDe(candidat) {
  if (!candidat) return [];
  const toutes = [candidat.source, ...(Array.isArray(candidat.aussiSur) ? candidat.aussiSur : [])];
  return [...new Set(toutes.filter((s) => typeof s === 'string' && s))];
}

/**
 * Cette release passe-t-elle le filtre ?
 *
 * Un filtre VIDE laisse tout passer : cocher des sources sert a en voir plus, pas moins, et
 * deux cases cochees montrent les deux — jamais leur intersection.
 */
function retenue(candidat, filtres) {
  if (!filtres || filtres.size === 0) return true;
  return sourcesDe(candidat).some((s) => filtres.has(s));
}

/** Combien de releases par source. Le compte doit dire la MEME chose que le filtre. */
function compterParSource(candidats) {
  const n = new Map();
  for (const c of Array.isArray(candidats) ? candidats : []) {
    for (const s of sourcesDe(c)) n.set(s, (n.get(s) || 0) + 1);
  }
  return n;
}

if (typeof module !== 'undefined') {
  module.exports = { sourcesDe, retenue, compterParSource };
}
