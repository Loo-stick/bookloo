// Les sites en LIEN DIRECT, et comment ouvrir une de leurs fiches.
//
// POURQUOI CE MODULE EXISTE, ET IL A UNE DATE. La liste vivait a DEUX endroits :
// `ouvrirDdl` dans `routes/lecture.ts`, et la route des fichiers dans `routes/debrid.ts`.
// Le 2026-09-01, bookys a ete ajoute au premier et pas au second : ses releases
// apparaissaient dans les resultats — un « Berserk Tome [1 a 41] » bien trouve — et
// refusaient de s'ouvrir avec « source « bookys » inconnue ». Signale a l'usage, sur la
// premiere recherche.
//
// Le second endroit codait meme le nom en dur (`decoupe.site !== 'wawacity'`), c'est-a-dire
// exactement le defaut corrige la veille dans le premier. Une connaissance dupliquee
// diverge toujours ; la seule question est quand.

import { ouvrirFicheZoneEbook } from '../../presse/zone-ebook';
import { ouvrirFicheBookys } from './bookys';
import { ouvrirFicheWawacity, type LienDdl } from './wawacity';

/** Ouvre la fiche d'un site : rend ses liens d'hebergeurs, ou `null` si elle est muette. */
export type OuvreurDdl = (id: string, signal?: AbortSignal) => Promise<LienDdl[] | null>;

const TABLE: Record<string, OuvreurDdl> = {
  wawacity: ouvrirFicheWawacity,
  'zone-ebook': ouvrirFicheZoneEbook,
  bookys: ouvrirFicheBookys,
};

/** Les sites connus. Sert aux tests et aux messages d'erreur, qui NOMMENT le site refuse. */
export const SITES_DDL: readonly string[] = Object.keys(TABLE);

/** Rend `null` sur un site inconnu : jamais de site par defaut. */
export function ouvreurDdl(site: string): OuvreurDdl | null {
  return TABLE[site] ?? null;
}
