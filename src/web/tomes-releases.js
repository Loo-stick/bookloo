// Quelle release sert quel tome, et jusqu'ou va la grille.
//
// Un pack est rarement complet. La release principale sert ce qu'elle porte ; les appoints
// comblent le reste. La garantie qui rend tout ca previsible tient en une phrase : UN
// APPOINT NE REPREND JAMAIS UN TOME QUE LA PRINCIPALE SERT DEJA. Ajouter une release ne
// peut donc pas degrader ce qui marchait — c'est la condition posee a l'usage, « sans tout
// casser ».
//
// Module pur, sans DOM : ces regles doivent etre EXECUTEES par les tests, pas relues.

/** Le numero d'un tome, ou `null` quand l'identite n'en porte pas. */
function numeroDeTomeId(tomeId) {
  const m = /^t(\d+)$/.exec(String(tomeId || ''));
  return m ? Number(m[1]) : null;
}

/**
 * Les tomes qu'une release sert reellement, `tomeCible` ayant le dernier mot.
 *
 * `tomeCible` existe parce que `identiteTome` ne numerote un fichier que si son nom porte
 * un numero. Un tome isole pris sur Telegram ou Z-Library — le cas d'usage meme — s'appelle
 * `f:<nom>` et serait sinon inattachable au tome 3. Quand il est pose, il fait foi SEUL :
 * la release ne sert que ce tome-la.
 */
function tomesServis(r) {
  if (!r) return [];
  if (r.tomeCible) return [r.tomeCible];
  return Array.isArray(r.tomes) ? r.tomes : [];
}

/**
 * La release qui sert ce tome, ou `null` s'il manque.
 *
 * La principale d'abord, pour tout ce qu'elle contient. Puis le premier appoint qui le
 * porte, par ordre d'ajout — l'ordre suffit a departager, et le retrait existe pour
 * corriger un mauvais choix.
 */
function releaseDuTome(tomeId, principale, appoints) {
  const id = String(tomeId || '');
  if (principale && tomesServis(principale).includes(id)) {
    return {
      cle: principale.cleRelease,
      titre: principale.titreRelease || null,
      source: principale.source || null,
      appoint: false,
    };
  }
  for (const a of Array.isArray(appoints) ? appoints : []) {
    if (tomesServis(a).includes(id)) {
      return {
        cle: a.cleRelease,
        titre: a.titreRelease || null,
        source: a.source || null,
        appoint: true,
      };
    }
  }
  return null;
}

/**
 * Les cases de la grille : `t1…tN` d'abord, puis les identites non numerotees.
 *
 * N est le MAXIMUM entre ce que le catalogue annonce et le plus grand tome reellement
 * connu — un catalogue peut etre en retard sur une serie en cours. Quand il ne dit rien,
 * la grille s'arrete au plus grand tome connu : JAMAIS DE PASTILLE FANTOME. C'est ce que
 * l'etagere refusait a raison de faire ; la difference est qu'on dispose maintenant d'une
 * source quand elle existe.
 */
function tomesDeLaGrille(principale, appoints, positions, dernierTome) {
  const connus = [
    ...tomesServis(principale),
    ...(Array.isArray(appoints) ? appoints : []).flatMap(tomesServis),
    ...(Array.isArray(positions) ? positions : []).map((p) => p && p.tome),
  ];

  let max = Number.isFinite(dernierTome) && dernierTome > 0 ? Math.trunc(dernierTome) : 0;
  for (const t of connus) {
    const n = numeroDeTomeId(t);
    if (n !== null && n > max) max = n;
  }

  const grille = [];
  for (let n = 1; n <= max; n += 1) grille.push(`t${n}`);

  // Les tomes sans numero n'ont pas de place dans une suite. Ils suivent, dans l'ordre ou
  // on les a rencontres, et sans doublon.
  const vus = new Set(grille);
  for (const t of connus) {
    if (t && numeroDeTomeId(t) === null && !vus.has(t)) { grille.push(t); vus.add(t); }
  }
  return grille;
}

/**
 * La liste des tomes qu'une release ANNONCE, d'apres la plage tiree de son titre.
 *
 * Le serveur analyse deja « One.Piece.Tome.[1 a 100] » en { debut: 1, fin: 100 } — c'est ce
 * qui trie les resultats de recherche. La bibliotheque, elle, ne s'en servait pas : elle ne
 * savait rien du contenu d'un pack tant qu'aucun tome n'avait ete ouvert DEPUIS l'etagere,
 * et la grille se rabattait alors sur la position la plus haute deja lue. Signale a
 * l'usage : quarante-trois tomes affiches pour un pack qui en annonce cent.
 *
 * C'est une annonce, pas un inventaire : un titre peut mentir. La vraie liste la remplace
 * des la premiere ouverture depuis l'etagere, ou le debrideur dit ce que l'archive contient.
 */
function tomesDeLaPlage(plage) {
  if (!plage || typeof plage !== 'object') return [];
  const debut = Number(plage.debut);
  const fin = plage.fin === undefined || plage.fin === null ? debut : Number(plage.fin);
  if (!Number.isInteger(debut) || debut < 1) return [];
  if (!Number.isInteger(fin) || fin < debut) return [];
  // REFUSER PLUTOT QUE TRONQUER. Un titre mal analyse peut rendre une plage enorme ;
  // tronquer donnerait une liste plausible et fausse, alors que rendre vide laisse la
  // grille se rabattre sur ce qu'on sait vraiment. Le plafond passe les vraies longues
  // series — One Piece depasse cent tomes.
  if (fin - debut + 1 > 300) return [];

  const liste = [];
  for (let n = debut; n <= fin; n += 1) liste.push(`t${n}`);
  return liste;
}

/**
 * Cette release peut-elle servir ce tome ? `null` quand on ne sait pas.
 *
 * POURQUOI FILTRER PLUTOT QUE CIBLER LA REQUETE. Chercher « One Piece tome 105 » au lieu de
 * « One Piece » cassait deux choses a la fois — mesure du 2026-08-28 :
 *
 *   - le rapprochement notait « One.Piece.T105… » a 0,275 au lieu de 0,90, donc ZERO
 *     correspondance certaine et quarante-cinq incertaines ;
 *   - les sources elles-memes ne trouvaient plus le fichier Telegram « One Piece 105
 *     (2023) », qui ne porte pas le mot « tome ».
 *
 * La plage, elle, est deja calculee par le serveur pour chaque candidat. On cherche donc
 * comme avant, et on ecarte a l'affichage ce qui ne peut pas convenir.
 *
 * UNE PLAGE ILLISIBLE N'ECARTE RIEN : « ONE PIECE (01-100+3HS) » ne s'analyse pas, et
 * masquer ce qu'on n'a pas su lire ferait disparaitre des releases valables.
 */
function couvreLeTome(plage, numero) {
  if (!Number.isInteger(numero) || numero < 1) return null;
  if (!plage || typeof plage !== 'object') return null;
  const debut = Number(plage.debut);
  if (!Number.isInteger(debut)) return null;
  const fin = plage.fin === undefined || plage.fin === null ? debut : Number(plage.fin);
  if (!Number.isInteger(fin)) return null;
  return numero >= debut && numero <= fin;
}

if (typeof module !== 'undefined') {
  module.exports = {
    releaseDuTome, tomesDeLaGrille, numeroDeTomeId, tomesServis, tomesDeLaPlage,
    couvreLeTome,
  };
}
