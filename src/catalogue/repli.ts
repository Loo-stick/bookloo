// La cascade des catalogues : le premier qui repond gagne.
//
// POURQUOI CE MODULE EXISTE. La cascade tenait en six lignes dans la route, et elle
// confondait deux situations que rien ne distinguait ensuite : « les catalogues ne
// connaissent pas ce titre » et « les catalogues n'ont pas repondu ». L'interface
// affichait « MangaDex ne connait pas ce titre » quand MangaDex etait tombe — un
// diagnostic faux, donne avec aplomb, et le seul que l'utilisateur pouvait lire.
//
// `openlibrary.ts` porte pourtant la regle depuis le premier jour : « null signale un
// ECHEC, jamais un resultat vide : la distinction remonte jusqu'a l'interface ». Elle ne
// remontait pas. Elle remonte ici.

export interface Interrogeable<T> {
  id: string;
  chercher(): Promise<T[]>;
}

/**
 * Interroge les catalogues DANS L'ORDRE et rend la premiere reponse non vide.
 *
 * - `{ catalogue, oeuvres }` avec des resultats : ce catalogue a trouve.
 * - `{ catalogue, oeuvres: [] }` : au moins un catalogue a REPONDU, aucun ne connait le
 *   titre. `catalogue` nomme celui qui a repondu — jamais celui qui est tombe avant lui,
 *   sinon le message d'erreur accuse le mauvais service.
 * - `null` : AUCUN catalogue n'a repondu. C'est une panne, pas une absence, et l'appelant
 *   doit le dire autrement qu'avec une liste vide.
 *
 * Une liste vide en entree n'est pas une panne : personne n'a echoue.
 */
export async function premierQuiRepond<T>(
  catalogues: Interrogeable<T>[],
): Promise<{ catalogue: string | null; oeuvres: T[] } | null> {
  let repondeur: string | null = null;
  for (const cat of catalogues) {
    let oeuvres: T[];
    try {
      oeuvres = await cat.chercher();
    } catch {
      // Un catalogue qui echoue n'est pas un catalogue qui ne connait pas le titre : on
      // passe au suivant, mais on ne retient pas qu'il a « repondu ».
      continue;
    }
    if (repondeur === null) repondeur = cat.id;
    if (oeuvres.length > 0) return { catalogue: cat.id, oeuvres };
  }
  if (repondeur === null && catalogues.length > 0) return null;
  return { catalogue: repondeur, oeuvres: [] };
}
