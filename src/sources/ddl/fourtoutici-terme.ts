// Le mot a envoyer a fourtoutici.
//
// LE SITE N'ACCEPTE QU'UN SEUL MOT ALPHANUMERIQUE. Mesure du 2026-09-07 : « Shining »
// rend 200, tandis que « stephen king », « stephen+king », « stephen-king » et meme le
// mot accentue « epee » rendent tous un 403 de nginx. Un espace, un tiret ou un accent
// suffisent a faire refuser la requete.
//
// Or une recherche porte un TITRE, qui en contient presque toujours. Sans ce module, la
// source repondait « n'a pas repondu » sur a peu pres tout — signale a l'usage sur
// « Shining » de Stephen King, que le site contient pourtant deux fois.
//
// On envoie donc le mot le plus DISTINCTIF du titre, et c'est le rapprochement par titre
// qui trie ensuite ce qui revient. C'est exactement ce que fait un humain devant leur
// barre de recherche.

/** Mots trop communs pour distinguer quoi que ce soit dans un catalogue. */
const VIDES = new Set([
  'le', 'la', 'les', 'un', 'une', 'des', 'du', 'de', 'et', 'ou', 'au', 'aux',
  'the', 'a', 'an', 'of', 'and', 'tome', 'vol', 'volume', 'integrale',
]);

/** Sans accents ni signes : c'est la seule forme que le site accepte. */
function plier(mot: string): string {
  return mot
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]/g, '');
}

/**
 * Le mot a envoyer, ou `null` quand aucun ne convient.
 *
 * LE PLUS LONG L'EMPORTE, parce que c'est le plus distinctif : dans « Le Monde des
 * Merveilles », « Merveilles » ramene bien moins de bruit que « Monde ». A longueur
 * egale, le premier gagne — l'ordre du titre porte du sens.
 *
 * Rend `null` plutot qu'un mot de deux lettres : « It » de Stephen King n'a aucun mot
 * utilisable, et interroger le site avec « it » rendrait mille fichiers sans rapport. Ne
 * rien demander vaut mieux que demander n'importe quoi.
 */
export function motPourFourtoutici(titre: string): string | null {
  const mots = String(titre || '')
    .split(/[^A-Za-z0-9À-ɏ]+/)
    .map(plier)
    .filter((m) => m.length >= 3 && !VIDES.has(m.toLowerCase()));
  if (mots.length === 0) return null;

  let meilleur = mots[0];
  for (const m of mots) if (m.length > meilleur.length) meilleur = m;
  return meilleur;
}
