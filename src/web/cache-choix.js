// Choix du service par lequel ouvrir une release. PUR : aucune dépendance au DOM, ce qui
// le rend testable pour de vrai plutôt qu'inspectable a la lecture.
//
// POURQUOI CE FICHIER EXISTE. La page bibliotheque lisait `reponse[service]` alors que
// /api/etats-cache repond `{ etats: { torbox, alldebrid, services } }`. Un niveau
// d'imbrication de trop, et AUCUNE release n'etait jamais trouvee en cache — TorBox
// compris. Le symptome portait a croire a un probleme AllDebrid ; c'etait une faute de
// forme, invisible a la relecture. Elle est maintenant tenue par un test.

/**
 * Rend le service qui annonce la release EN CACHE, ou `null`.
 *
 * TorBox d'abord : sa reponse vient d'une consultation en lecture seule, donc gratuite.
 * AllDebrid ne peut etre renseigne ici que par une verification anterieure — chez lui,
 * savoir impose de deposer.
 */
function serviceEnCache(reponse, cle) {
  const etats = reponse && reponse.etats;
  if (!etats) return null;
  for (const service of ['torbox', 'alldebrid']) {
    const table = etats[service];
    // `inconnu` n'est PAS `absent`. Ne pas savoir n'est pas savoir que non — c'est la
    // regle du projet, et la confondre ferait passer une release disponible pour perdue.
    if (table && table[cle] === 'en-cache') return service;
  }
  return null;
}

/**
 * Vrai si AllDebrid reste a interroger : il n'est pas deja confirme, et son etat connu
 * n'est pas un refus franc.
 */
function allDebridResteAVerifier(reponse, cle) {
  const etats = reponse && reponse.etats;
  const connu = etats && etats.alldebrid ? etats.alldebrid[cle] : undefined;
  return connu !== 'en-cache' && connu !== 'absent';
}

/** Une release en lien direct : sa disponibilite ne depend pas du cache d'un debrideur. */
function estLienDirect(cle) {
  return typeof cle === 'string' && cle.startsWith('ddl:');
}

if (typeof module !== 'undefined') {
  module.exports = { serviceEnCache, allDebridResteAVerifier, estLienDirect };
}
