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

/**
 * Cette cle designe-t-elle une release qu'un DEBRIDEUR peut connaitre ?
 *
 * Seule une empreinte de quarante hexadecimaux en est une. Telegram (`tg:`), Z-Library
 * (`zl:`) et les liens directs (`ddl:`) servent leurs octets eux-memes : les passer a
 * `/api/etats-cache` ne rend pas « pas en cache » mais « aucun hash a verifier », une
 * erreur qui ne dit rien a personne.
 *
 * DEFAUT REEL, signale a l'usage : depuis que lire une oeuvre retient sa release, un
 * favori peut porter une identite Telegram comme chemin d'acces — ce qui n'arrivait pas
 * avant. Enumerer les prefixes aurait laisse passer le suivant.
 */
function estCleDebrideur(cle) {
  return typeof cle === 'string' && /^[0-9a-f]{40}$/i.test(cle);
}

/**
 * Par quel debrideur ouvrir une release en LIEN DIRECT, d'apres la sonde des hebergeurs.
 *
 * Un lien direct n'a pas d'etat de cache : sa disponibilite depend de l'hebergeur. La sonde
 * dit lesquels sont vivants et lequel des deux debrideurs sait les debloquer ; le serveur,
 * lui, choisit ensuite l'hebergeur exact et le rechoisit si le lien meurt en cours de
 * lecture. Il ne reste donc au navigateur qu'a nommer un service.
 *
 * L'ordre alldebrid puis torbox est celui de la page de recherche : deux endroits qui
 * choisiraient differemment ouvriraient la meme release de deux facons.
 */
function hebergementUtilisable(structure) {
  const hebergeurs = Array.isArray(structure && structure.hebergeurs) ? structure.hebergeurs : [];
  // Un hebergeur mort n'est pas un hebergeur : le compter ferait choisir un service qui
  // echouera a l'ouverture, apres l'attente.
  const vivants = hebergeurs.filter((h) => h && !h.mort);
  for (const service of ['alldebrid', 'torbox']) {
    const h = vivants.find((x) => x.supporte && x.supporte[service]);
    if (h) return { service, nomFichier: h.nomFichier || null };
  }
  return null;
}

/**
 * Que faire d'une archive sondee : la lire, la telecharger, ou changer de release.
 *
 * La distinction porte sur le FORMAT reconnu. Un RAR ou un ZIP de plusieurs tomes est un
 * fichier bien reel qu'on a su ouvrir — il ne se lit simplement pas en ligne, et le
 * telechargement est la reponse. Un format « inconnu » veut dire qu'on n'a rien pu
 * atteindre : renvoyer vers la recherche ferait alors buter sur exactement le meme mur,
 * puisque c'est la release elle-meme qui ne repond plus.
 */
function issueArchive(archive) {
  const a = archive || {};
  if (a.lisible) return 'lire';
  return a.format === 'rar' || a.format === 'zip' ? 'telecharger' : 'changer';
}

if (typeof module !== 'undefined') {
  module.exports = {
    serviceEnCache, allDebridResteAVerifier, estLienDirect, estCleDebrideur,
    hebergementUtilisable, issueArchive,
  };
}
