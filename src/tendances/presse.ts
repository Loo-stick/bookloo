// La presse comme rayon du kiosque.
//
// ELLE S'Y REPLIE PAR UN ADAPTATEUR, PAS PAR UNE EXCEPTION. Le kiosque de presse existait
// avant celui-ci et sait deja lire trois sites ; le refaire aurait donne deux lecteurs qui
// divergent — la faute que ce projet a payee quatre fois cette semaine. On traduit donc un
// `Numero` en `Entree`, et rien d'autre.
//
// CE QUE CET ADAPTATEUR NE PORTE PAS : les rubriques, les categories bookys et la
// recherche par titre. Ce sont des gestes propres a la presse, et ils restent sur l'ecran
// dedie. Le kiosque en montre les DERNIERS PARUS, comme pour tous les autres rayons.

import { KIOSQUES } from '../presse';
import { RUBRIQUES } from '../presse/types';
import { libelleParution } from '../presse/parution';
import type { Numero } from '../presse/types';
import type { Entree, SourceKiosque } from './types';

const MAX = 24;

/**
 * Un numero de presse, dans la forme du kiosque.
 *
 * LA DATE SERT DE `quand` ET DE `detail`. Un periodique se repere par sa parution — c'est
 * la regle etablie le 2026-09-02, apres qu'un quantieme de mois a ete pris pour un tome.
 */
export function entreeDeNumero(n: Numero): Entree {
  return {
    id: `ddl:${n.site}:${n.id}`,
    titre: n.titre,
    source: n.site,
    // La date de parution vaut `2026-09` sur un mensuel : on la complete pour l'ordre,
    // sans pretendre connaitre le jour — le libelle, lui, ne l'invente pas.
    quand: n.date ? `${n.date.length === 7 ? `${n.date}-01` : n.date}T00:00:00.000Z` : null,
    detail: n.date ? (libelleParution(n.date) ?? undefined) : undefined,
    // PAS D'OEUVRE : `ddl:<site>:<id>` designe un numero depose, pas un titre de
    // catalogue. Le clic cherchera « Le Monde », qui trouve le periodique.
    famille: 'presse',
  };
}

/**
 * Les derniers parus, JOURNAUX ET MAGAZINES CONFONDUS.
 *
 * Le kiosque montre un rayon, pas une rubrique : les separer ici demanderait deux sections
 * la ou tous les autres rayons n'en ont qu'une, et l'ecran dedie fait deja ce partage.
 */
export const presseKiosque: SourceKiosque = {
  id: 'presse',
  libelle: 'presse',
  familles: ['presse'],

  async nouveautes(_famille, signal?: AbortSignal): Promise<Entree[]> {
    const lots = await Promise.all(
      KIOSQUES.flatMap((k) => RUBRIQUES.map(async (rubrique) => {
        try {
          return await k.dernieres(rubrique, signal);
        } catch {
          // UN SITE QUI TOMBE N'EMPORTE PAS LES DEUX AUTRES. La route ne verrait qu'un
          // echec global la ou deux sites sur trois ont repondu.
          return [] as Numero[];
        }
      })),
    );

    const parId = new Map<string, Entree>();
    for (const e of lots.flat().map(entreeDeNumero)) {
      if (!parId.has(e.id)) parId.set(e.id, e);
    }
    // LE PLUS RECENT EN TETE, et ce qui n'a pas de date passe derriere plutot que devant :
    // une parution qu'on n'a pas su lire ne doit pas ouvrir le rayon.
    return [...parId.values()]
      .sort((a, b) => String(b.quand ?? '').localeCompare(String(a.quand ?? '')))
      .slice(0, MAX);
  },
};
