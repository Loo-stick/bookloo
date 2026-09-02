// La vignette d'une oeuvre SANS couverture.
//
// POURQUOI ELLE EXISTE. La BnF ne fournit aucune image : une notice decrit un PERIODIQUE,
// et un periodique n'a pas de couverture — ses numeros en ont, chacun la sienne. Booknode
// est dans le meme cas, son CDN refusant le hotlinking. Un carre vide, c'est ce que
// l'utilisateur a appele « moche », et il a raison : une grille de trous ne se lit pas.
//
// POURQUOI PAS LE VRAI LOGO. Il faudrait ouvrir la CSP a une origine externe et afficher
// depuis ce serveur la marque deposee d'un tiers. Et cela ne marcherait que pour les
// titres celebres : sur les 364 periodiques qu'une recherche « Le Monde » rend, la plupart
// n'ont aucun logo trouvable.
//
// CE QU'ON FAIT A LA PLACE, ET C'EST MIEUX. L'identite visuelle d'un journal EST sa
// manchette : son nom, compose. Une vignette typographique n'est donc pas un pis-aller
// pour la presse, c'est la bonne representation — et elle marche pour les 364.
//
// PUR, sans DOM : la teinte se verifie en l'executant.

/**
 * Une teinte stable, tiree du titre.
 *
 * DEUX TITRES VOISINS DOIVENT SE DISTINGUER. « Le Monde » et « Le Monde diplomatique » se
 * suivent dans une liste : leur donner deux bleus identiques ne servirait a rien. Le
 * hachage brasse donc chaque caractere, position comprise.
 *
 * Rend 0 a 359. La saturation et la clarte, elles, sont FIXES dans la feuille de style :
 * une teinte libre par-dessus un fond sombre suffit a distinguer sans faire un arc-en-ciel.
 */
function teinteDuTitre(titre) {
  const t = String(titre || '');
  let h = 2166136261;
  for (let i = 0; i < t.length; i++) {
    h ^= t.charCodeAt(i);
    // Le melange de FNV-1a : sans lui, deux anagrammes auraient la meme teinte.
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % 360;
}

/**
 * Ce qu'on ecrit sur la vignette.
 *
 * LE NOM ENTIER, PAS DES INITIALES. « CDC » ne dit rien ; « Cahiers du cinéma » se
 * reconnait d'un coup d'oeil. On retire seulement ce que le catalogage ajoute et que
 * `titrePourRecherche` retire deja cote serveur — la vignette peut recevoir un titre brut.
 */
function texteDeVignette(titre) {
  return String(titre || '')
    .split(/\s+[/;]\s+/)[0]
    .replace(/\s*\([^)]*\)\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

if (typeof module !== 'undefined') {
  module.exports = { teinteDuTitre, texteDeVignette };
}
