/**
 * UNE ERREUR DONT LE MESSAGE PEUT ETRE MONTRE.
 *
 * Le gestionnaire d'erreurs HTTP rend « erreur interne » pour tout, et c'est le bon defaut :
 * le texte d'une exception peut porter un chemin, une requete SQL, un jeton. Mais certains
 * echecs sont des faits d'exploitation que la personne devant l'ecran est la seule a pouvoir
 * corriger — et lui cacher la cause la laisse sans recours.
 *
 * Signale le 2026-09-30 par un hebergeur : son conteneur ne pouvait pas ecrire ses reglages,
 * l'ecran disait « erreur interne », et il a fallu ses journaux pour trouver un EACCES. Le
 * message qu'il lui fallait tenait en une ligne.
 *
 * Le message d'une `ErreurLisible` est donc REDIGE POUR ETRE LU : il ne recopie jamais le texte
 * d'une exception tierce, il dit ce qui ne va pas et quoi faire.
 */
export class ErreurLisible extends Error {
  readonly statut: number;

  constructor(message: string, statut = 500) {
    super(message);
    this.name = 'ErreurLisible';
    this.statut = statut;
  }
}

/**
 * LE DERNIER RECOURS HTTP. « erreur interne » pour tout, SAUF une `ErreurLisible`, qui a ete
 * redigee pour etre montree. Vit ici plutot que dans `index.ts` pour etre testable : la regle
 * « quoi montrer, quoi taire » est exactement celle qu'on veut pincer par un test.
 */
export function middlewareErreurLisible(journaliser: (e: Error) => void) {
  return (
    err: Error,
    _req: import('express').Request,
    res: import('express').Response,
    _next: import('express').NextFunction,
  ): void => {
    journaliser(err);
    if (err instanceof ErreurLisible) {
      res.status(err.statut).json({ erreur: err.message });
      return;
    }
    res.status(500).json({ erreur: 'erreur interne' });
  };
}
