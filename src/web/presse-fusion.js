// Fusionner les numeros venus des trois sites, cote client.
//
// POURQUOI COTE CLIENT. La rubrique arrive EN FLUX, site par site : bookys met quinze
// secondes la ou les deux autres en mettent une. Le serveur ne peut pas trier ce qui n'est
// pas encore arrive — il faudrait attendre le dernier, c'est-a-dire annuler l'interet du
// flux. La liste se retrie donc a chaque arrivee, sur ce qu'on a.
//
// PUR, sans DOM : c'est ce qui le rend reellement executable par ses tests.

/** Une cle de regroupement stable : la casse et les espaces ne font pas deux parutions. */
function cleFusion(numero) {
  const titre = String(numero.titre || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ');
  // LA DATE ENTRE DANS LA CLE TELLE QUELLE. « 2026-09 » et « 2026-09-05 » sont deux
  // parutions differentes — un mensuel et un hebdomadaire du meme titre — et les
  // confondre en masquerait une.
  return `${titre}@${numero.date || ''}`;
}

/**
 * Fusionne des listes de numeros en une seule, triee.
 *
 * Le meme titre a la meme date, chez deux sites, ne fait QU'UNE ligne — qui porte les
 * deux. Savoir qu'un numero existe ailleurs a de la valeur le jour ou un hebergeur est
 * mort ; jeter le doublon jetterait ce recours.
 *
 * Tri par date DECROISSANTE, les sans-date A LA FIN : le kiosque existe pour montrer ce
 * qui vient de paraitre, et un titre mal date ne doit pas en truster le haut.
 */
function fusionnerNumeros(listes) {
  const parCle = new Map();
  for (const liste of listes || []) {
    for (const numero of liste || []) {
      const cle = cleFusion(numero);
      const connu = parCle.get(cle);
      if (connu) {
        if (!connu.sites.some((s) => s.site === numero.site)) {
          connu.sites.push({ site: numero.site, id: numero.id });
        }
        // La taille n'est pas toujours annoncee : on garde la premiere connue.
        if (connu.taille === undefined && numero.taille !== undefined) connu.taille = numero.taille;
        continue;
      }
      parCle.set(cle, {
        titre: numero.titre,
        brut: numero.brut,
        date: numero.date || null,
        rubrique: numero.rubrique,
        taille: numero.taille,
        sites: [{ site: numero.site, id: numero.id }],
      });
    }
  }

  return [...parCle.values()].sort((a, b) => {
    if (a.date === b.date) return a.titre.localeCompare(b.titre, 'fr');
    if (!a.date) return 1;
    if (!b.date) return -1;
    // Des chaines ISO s'ordonnent d'elles-memes : c'est pour ca que la date en est une.
    return b.date.localeCompare(a.date);
  });
}

/** « 2026-08-28 » -> « 28 aout 2026 ». « 2026-09 » -> « septembre 2026 ». */
function dateLisible(iso) {
  if (!iso) return '';
  const MOIS = ['janvier', 'fevrier', 'mars', 'avril', 'mai', 'juin',
    'juillet', 'aout', 'septembre', 'octobre', 'novembre', 'decembre'];
  const p = String(iso).split('-');
  const mois = MOIS[Number(p[1]) - 1] || '';
  return p[2] ? `${Number(p[2])} ${mois} ${p[0]}` : `${mois} ${p[0]}`;
}

if (typeof module !== 'undefined') {
  module.exports = { fusionnerNumeros, cleFusion, dateLisible };
}
