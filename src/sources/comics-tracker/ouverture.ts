// Ouvrir une edition Comics Tracker : le jeton, puis l'adresse des octets.
//
// POURQUOI CE MODULE EXISTE SEPAREMENT. Trois surfaces en ont besoin — la sonde avant
// « Lire », la liseuse, et le lien de telechargement — et chacune reecrivait sinon la meme
// sequence : un jeton, un lien, et un second essai si la session vient de mourir.
//
// UNE SESSION SE REJOUE UNE FOIS. Le jeton vaut une heure ; la lecture d'un album de 200 Mo
// peut la depasser, et `ouvrirDistant` redemande alors une adresse. Rendre la meme erreur
// casserait la lecture sur un compte parfaitement valide.

import { jetonPour, sessionRefusee } from './session';
import { MOTIF_SANS_LIEN, resoudreFichierCt } from './fichier';

export const MOTIF_SANS_COMPTE = 'aucun compte Comics Tracker utilisable — verifiez votre '
  + 'adresse et votre mot de passe dans Compte';

export interface DependancesCt {
  jetonPour: typeof jetonPour;
  sessionRefusee: typeof sessionRefusee;
  resoudreFichierCt: typeof resoudreFichierCt;
}

const REELLES: DependancesCt = { jetonPour, sessionRefusee, resoudreFichierCt };

/**
 * Le resolveur a donner a `ouvrirDistant` : une adresse fraiche a chaque appel.
 *
 * Le `uuid` de Drive est propre a chaque demande (mesure du 2026-09-16) : garder l'adresse
 * n'apporterait rien, et la rejouer coute deux requetes.
 */
export function resolveurCt(
  userId: number,
  cles: Record<string, string | undefined>,
  editionId: string,
  signal?: AbortSignal,
  deps: DependancesCt = REELLES,
): () => Promise<string> {
  return async () => {
    const jeton = await deps.jetonPour(userId, cles, signal);
    if (!jeton) throw new Error(MOTIF_SANS_COMPTE);
    try {
      return await deps.resoudreFichierCt(editionId, jeton, signal);
    } catch (e) {
      // SEUL UN REFUS DE LIEN SE REJOUE. Un quota Drive n'a rien a voir avec la session :
      // reessayer avec un jeton neuf redonnerait exactement le meme refus, deux fois plus tard.
      if ((e as Error).message !== MOTIF_SANS_LIEN) throw e;
      deps.sessionRefusee(userId);
      const neuf = await deps.jetonPour(userId, cles, signal);
      if (!neuf) throw e;
      return deps.resoudreFichierCt(editionId, neuf, signal);
    }
  };
}
