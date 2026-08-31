// PAR OU ROUVRIR une oeuvre de la bibliotheque. PUR : aucune dependance au DOM.
//
// POURQUOI CE FICHIER EXISTE. La decision vivait dans `bibliotheque.js`, un bloc ferme
// sans rien d'exportable : les tests ne pouvaient que RELIRE LE TEXTE du fichier et
// verifier a quoi il ressemblait, jamais ce qu'il faisait. Trois defauts de suite sont
// passes a travers — un bouton de verification propose sur une release Telegram, une
// reprise qui repondait « pas de cache a verifier » au lieu d'ouvrir.
//
// Meme raison d'etre que `cache-choix.js`, et meme lecon.

/** Une empreinte de torrent, et rien d'autre. */
function estEmpreinte(cle) {
  return typeof cle === 'string' && /^[0-9a-f]{40}$/i.test(cle);
}

/**
 * Ce que la bibliotheque doit faire d'un tome, sans rien savoir de l'ecran.
 *
 * Rend `{ voie, cle, service }` :
 *   `ecoute`      — livre audio, toujours une release de tracker : il faut un debrideur
 *   `liseuse`     — livre servi par sa source (Telegram, Z-Library) : rien a demander
 *   `visionneuse` — planches servies par leur source, pareil
 *   `debrideur`   — il faut trouver chez qui la release est en cache
 *   `sans-release`— aucun chemin d'acces memorise
 */
function commentRouvrir(tomeId, entree) {
  const id = String(tomeId || '');
  const estLivre = id.startsWith('epub:');
  const estEcoute = id.startsWith('audio:');

  if (estLivre || estEcoute) {
    // Le premier deux-points separe le prefixe ; ceux d'apres appartiennent a l'identite.
    const identite = id.slice(id.indexOf(':') + 1);
    // L'IDENTITE DE LA POSITION L'EMPORTE, TOUJOURS. Elle dit par ou le livre a ete LU,
    // et c'est la seule qui corresponde a la progression enregistree.
    //
    // DEFAUT REEL, releve dans une vraie base le 2026-08-27 : un Talisman lu depuis une
    // release de tracker (`epub:fe91e485...`) dont le favori pointait ensuite vers une
    // version Telegram (`tg:7:284006`). En preferant le raccourci du favori, la
    // reouverture cherchait le cache d'une identite Telegram et repondait « cette
    // release ne passe pas par un debrideur » — sur un livre parfaitement lisible.
    //
    // Le raccourci du favori sert a ouvrir l'oeuvre EN GENERAL ; il ne dit rien de la
    // position deja enregistree.
    if (estEcoute) return { voie: 'ecoute', cle: identite };
    if (identite.startsWith('tg:') || identite.startsWith('zl:')) {
      return { voie: 'liseuse', cle: identite };
    }
    return { voie: 'debrideur', cle: identite };
  }

  const cle = entree && entree.cleRelease;
  if (!cle) return { voie: 'sans-release' };
  if (cle.startsWith('tg:')) return { voie: 'visionneuse', cle, service: 'telegram' };
  if (cle.startsWith('zl:')) return { voie: 'visionneuse', cle, service: 'zlibrary' };
  if (cle.startsWith('ddl:')) return { voie: 'lien-direct', cle };
  return { voie: 'debrideur', cle };
}

/**
 * Ce que la ligne doit ANNONCER : la release memorisee, celle que « Reprendre » ouvrira.
 *
 * Depuis que le raccourci commande, il n'y a plus de divergence a arbitrer : la ligne et
 * le bouton designent la meme chose. Cette fonction reste le seul endroit qui le decide.
 */
function releaseAffichee(_tomeId, entree) {
  const e = entree || {};
  return { source: e.source || null, titre: e.titreRelease || null };
}

/**
 * L'etiquette COURTE d'un dos de tome, celle qu'on lit sur l'etagere.
 *
 * DEFAUT REEL, vu sur une capture le 2026-08-27 : un dos affichait
 * « epub:fe91e485debb7… » en brut. La fonction ne connaissait que t<numero> et f:<nom>,
 * et rendait tout le reste tel quel.
 *
 * Elle avait DIVERGE de son equivalent long, qui traitait pourtant epub: et audio:
 * correctement mais ne servait qu'a l'infobulle. Deux orthographes de la meme idee.
 */
function etiquetteTome(id) {
  const s = String(id || '');
  if (s.startsWith('audio:')) return 'audio';
  if (s.startsWith('epub:')) return 'livre';
  if (s.startsWith('t')) return s.slice(1);
  return s.replace(/^f:/, '');
}

/** L'identite que porte un tome d'ouvrage : ce qui suit son prefixe de nature. */
function identiteTome(tome) {
  const t = String(tome || '');
  return t.slice(t.indexOf(':') + 1);
}

/**
 * UN LIVRE LU DEPUIS DEUX SOURCES N'EST PAS DEUX TOMES. Chaque source a son identite, donc
 * sa ligne de progression — d'ou « 1 / 2 tomes lu » pour un seul livre, signale a l'usage.
 * On n'en garde qu'une PAR NATURE : deux epub du meme livre sont deux sources d'une meme
 * lecture, mais un epub et sa version ecoutee sont deux lectures differentes, et les fondre
 * en ferait disparaitre une de l'etagere.
 *
 * LA RELEASE CHOISIE L'EMPORTE sur la plus avancee. Sans cela — defaut du 2026-08-27 — un
 * Talisman rechoisi sur Telegram (6/63, soit 9,5 %) etait ecrase par l'ancienne release de
 * tracker (4/24, soit 16,7 %) : la position choisie disparaissait avant meme d'etre
 * cherchee, et l'etagere reaffichait « Commencer » sur un livre repris trois minutes plus
 * tot. Choisir une release veut dire « je lis celle-ci desormais » ; ca vaut aussi ici.
 */
function fusionnerParNature(positions, cleRelease) {
  let liste = Array.isArray(positions) ? positions.slice() : [];
  for (const prefixe of ['epub:', 'audio:']) {
    const meme = (p) => String(p.tome || '').startsWith(prefixe);
    const memes = liste.filter(meme);
    if (memes.length <= 1) continue;
    // Une release choisie mais jamais ouverte ne doit rien faire disparaitre : mieux vaut
    // proposer de reprendre l'ancienne que de n'avoir rien a proposer.
    const choisie = cleRelease && memes.find((p) => identiteTome(p.tome) === cleRelease);
    const garde = choisie || memes.reduce((a, b) => (
      b.planche / (b.planches || 1) > a.planche / (a.planches || 1) ? b : a));
    liste = liste.filter((p) => !meme(p) || p === garde);
  }
  return liste;
}

/**
 * La position que « Reprendre » doit rouvrir.
 *
 * LE RACCOURCI COMMANDE. Choisir une release veut dire « je lis celle-ci desormais » :
 * c'est elle que « Reprendre » ouvre, et l'on y reprend la ou l'on en etait DANS CE
 * FICHIER — au debut s'il n'a jamais ete ouvert.
 *
 * POURQUOI CETTE REGLE A CHANGE. La position commandait, et lire reenregistrait le
 * raccourci sur la release lue : un choix fait a la main etait donc efface au premier
 * « Reprendre ». Signale a l'usage le 2026-08-27 — « du coup je peux pas changer de
 * release ? ». Les deux regles se contredisaient ; celle-ci est celle que le bouton
 * laisse attendre.
 *
 * L'ancienne position n'est pas perdue : elle reste attachee a son fichier et se
 * retrouve si l'on y revient.
 */
function positionAReprendre(positions, entree) {
  const liste = Array.isArray(positions) ? positions : [];
  const cle = entree && entree.cleRelease;
  const ouvrages = liste.filter((p) => {
    const t = String(p.tome || '');
    return t.startsWith('epub:') || t.startsWith('audio:');
  });

  // Un livre : on reprend celui qui correspond au raccourci, et lui seul.
  if (ouvrages.length > 0 && cle) {
    const correspond = ouvrages.find((p) => identiteTome(p.tome) === cle);
    if (correspond) return correspond;
    // Le raccourci designe une release jamais ouverte : on commence.
    if (!liste.some((p) => !String(p.tome || '').startsWith('epub:') && !String(p.tome || '').startsWith('audio:'))) {
      return null;
    }
  }

  // Tomes numerotes : la position ne depend pas de la release, on garde la regle d'avant.
  const enCours = liste.find((p) => p.planche < p.planches - 1);
  return enCours || liste[0] || null;
}

if (typeof module !== 'undefined') {
  module.exports = {
    commentRouvrir, estEmpreinte, releaseAffichee, etiquetteTome, positionAReprendre,
    identiteTome, fusionnerParNature,
  };
}
