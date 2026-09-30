// Ecriture NDJSON — une ligne JSON par evenement.
//
// LA CONTRE-PRESSION EST LA RAISON D'ETRE DE CE FICHIER. `res.write()` rend `false`
// quand le tampon de sortie est plein, et Node accumule alors en memoire en attendant
// que le client lise. Ignorer ce retour, c'est un tampon qui grossit sans limite — sur
// une connexion lente, ca se voit.
//
// `ecrire` ne tient donc sa promesse qu'une fois le tampon vide. Effet secondaire
// heureux : un client lent RALENTIT le fan-out au lieu de le faire gonfler.

import { tracerErreur } from './journal';

export interface Ecrivain {
  /** Ecrit une ligne. La promesse n'est tenue qu'une fois le tampon vide. */
  ecrire(objet: unknown): Promise<void>;
  terminer(): void;
}

export function ecrivainNdjson(sortie: NodeJS.WritableStream): Ecrivain {
  let fini = false;

  return {
    async ecrire(objet: unknown): Promise<void> {
      if (fini) return;

      let ligne: string;
      try {
        ligne = `${JSON.stringify(objet)}\n`;
      } catch (e) {
        // Une ligne fautive ne doit pas casser tout le flux : on l'ecarte et on
        // continue. Perdre une source vaut mieux que perdre la recherche entiere.
        tracerErreur('Flux', e);
        return;
      }

      const place = sortie.write(ligne);
      if (place) return;

      // Tampon plein : on attend qu'il se vide avant de rendre la main a l'appelant.
      await new Promise<void>((resoudre) => {
        const fait = () => {
          sortie.off('drain', fait);
          sortie.off('close', fait);
          sortie.off('error', fait);
          resoudre();
        };
        sortie.once('drain', fait);
        sortie.once('close', fait);
        sortie.once('error', fait);
      });
    },

    terminer(): void {
      if (fini) return;
      fini = true;
      sortie.end();
    },
  };
}
