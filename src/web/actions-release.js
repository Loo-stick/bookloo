// Ce qu'on propose sur la ligne d'un hebergeur, et pourquoi.
//
// POURQUOI CE FICHIER EXISTE. La decision vivait dans trois `if` imbriques, et elle avait
// DERIVE : « Lire » consultait la sonde, « Telecharger » non. Quand la sonde concluait que
// les liens ne repondent plus, l'interface affichait ce motif ET un bouton « Telecharger »
// juste en dessous. Signale a l'usage — « ok mais pourquoi j'ai quand meme le bouton ? ».
//
// Un commentaire du fichier affirmait pourtant que « Telecharger suit desormais la MEME
// regle que Lire ». C'etait vrai a un autre endroit. Une regle enoncee a deux endroits
// finit toujours par n'etre vraie qu'a un seul.
//
// PUR, sans DOM : c'est ce qui le rend reellement executable par ses tests.

/**
 * Ce que la ligne d'un hebergeur doit proposer.
 *
 * Rend `{ etat, motif }` : `etat` vaut « lire », « telecharger », ou un refus nomme. Les
 * refus ne sont PAS interchangeables — « ce debrideur n'a pas su l'ouvrir », « non pris en
 * charge » et « plus aucun lien ne repond » demandent trois gestes differents : en choisir
 * un autre, configurer un debrideur, ou changer de release.
 */
function actionsRelease(hebergeur, service, archive) {
  // LE REFUS PORTE LE NOM DE CELUI QUI L'A PRONONCE.
  //
  // On affichait « lien mort », qui etait le mot d'AllDebrid repris a notre compte. Il dit
  // qu'ALLDEBRID n'a pas su ouvrir ce lien — pas que le fichier a disparu. Signale a
  // l'usage : « lien mort » sur un fichier qui s'ouvrait parfaitement au navigateur.
  //
  // ET LE REFUS D'UN AUTRE SERVICE NE COMPTE PAS ICI : cette ligne parle du service
  // choisi. Ce qu'AllDebrid ne sait pas ouvrir, TorBox le peut peut-etre.
  if ((hebergeur.refusePar || []).includes(service)) {
    const depuis = hebergeur.refuseDepuis ? ` — ${hebergeur.refuseDepuis}` : '';
    return { etat: 'refuse', motif: `${service} n a pas su ouvrir ce lien${depuis}` };
  }
  if (!hebergeur.supporte || !hebergeur.supporte[service]) {
    return { etat: 'non-pris-en-charge', motif: `non pris en charge par ${service}` };
  }
  // LA SONDE A LE DERNIER MOT. Elle a essaye TOUS les liens utilisables et aucun n'a
  // repondu : proposer de telecharger celui-ci promet ce qui vient d'echouer.
  if (archive && archive.aucunLienVivant) {
    return { etat: 'aucun-lien-vivant', motif: archive.motif || 'aucun lien ne repond plus' };
  }
  if (archive && archive.lisible) return { etat: 'lire' };
  return { etat: 'telecharger' };
}

if (typeof module !== 'undefined') {
  module.exports = { actionsRelease };
}
