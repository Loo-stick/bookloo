// La preparation d'un sommaire, ligne a ligne.
//
// POURQUOI CE FICHIER EXISTE. Un CBZ se resume en deux ou trois lectures : son repertoire
// central vit en fin de fichier et annonce tout d'un coup. Un CBR n'a pas de repertoire —
// ses en-tetes sont entrelaces avec les donnees, et la position de chacun ne se deduit que
// du precedent. Le parcours est sequentiel, une requete de plage par planche.
//
// MESURE DU 2026-08-31, a travers la facade Telegram, sur « I''s T01 (Katsura) » : 287 Mo,
// 189 planches, 197 requetes, 66 secondes. Derriere un « ouverture de l archive… » fige,
// soixante-six secondes passent pour une panne. C'est le decoupage des lignes qui fait la
// difference, et c'est precisement ce qui se teste sans navigateur.
//
// PUR, sans DOM ni `fetch` : il recoit un flux de morceaux de texte et rend le sommaire.

/**
 * Decoupe un flux NDJSON en objets, en respectant les lignes coupees entre deux morceaux.
 *
 * UNE LIGNE PEUT ARRIVER EN DEUX FOIS. C'est le defaut classique de ce genre de lecture :
 * decouper chaque morceau sur « \n » sans garder le reste perd la ligne a cheval, et ici
 * ce serait le « pret » final — donc l'archive ne s'ouvrirait jamais, au hasard de la
 * taille des paquets.
 */
function decoupeurNdjson() {
  let reste = '';
  return {
    /** Les objets complets contenus dans ce morceau. */
    absorber(morceau) {
      const lignes = (reste + morceau).split('\n');
      reste = lignes.pop() ?? '';
      const out = [];
      for (const l of lignes) {
        const t = l.trim();
        if (!t) continue;
        // Une ligne illisible ne casse pas le flux : on l'ecarte et on continue.
        try { out.push(JSON.parse(t)); } catch { /* ligne tronquee ou bruit */ }
      }
      return out;
    },
    /** Ce qui reste apres le dernier « \n » : un flux peut finir sans saut de ligne. */
    fin() {
      const t = reste.trim();
      reste = '';
      if (!t) return [];
      try { return [JSON.parse(t)]; } catch { return []; }
    },
  };
}

/**
 * Reduit un flux de lignes a un sommaire, en signalant l'avancee au passage.
 *
 * LEVE sur une ligne « erreur », et leve aussi si le flux se termine SANS « pret » : un
 * flux coupe en cours de route laisserait sinon la visionneuse attendre pour toujours.
 */
async function sommaireDuFlux(morceaux, surAvancee) {
  const decoupeur = decoupeurNdjson();
  let sommaire = null;
  for await (const morceau of morceaux) {
    for (const ligne of decoupeur.absorber(morceau)) {
      if (ligne.type === 'progres') surAvancee?.(ligne);
      else if (ligne.type === 'erreur') throw new Error(ligne.erreur || 'preparation impossible');
      else if (ligne.type === 'pret') sommaire = ligne;
    }
  }
  for (const ligne of decoupeur.fin()) {
    if (ligne.type === 'erreur') throw new Error(ligne.erreur || 'preparation impossible');
    if (ligne.type === 'pret') sommaire = ligne;
  }
  if (!sommaire) throw new Error('la preparation s est interrompue avant la fin');
  return sommaire;
}

if (typeof module !== 'undefined') {
  module.exports = { decoupeurNdjson, sommaireDuFlux };
}
