// Lecture des cles d'un utilisateur, dechiffrees avec la DEK de sa session.
//
// C'est le SEUL endroit ou un secret repasse en clair, et il n'existe que le temps d'un
// appel. Rien ici ne journalise, ne met en cache ni ne renvoie ces valeurs vers le
// navigateur.

import type { Database } from 'better-sqlite3';
import { dechiffrer } from './crypto';
import { lireCles } from '../db/cles';
import type { NomCleStockee } from '../db/schema';

export type ClesEnClair = Partial<Record<NomCleStockee, string>>;

export function clesEnClair(db: Database, userId: number, dek: Buffer): ClesEnClair {
  const out: ClesEnClair = {};
  for (const c of lireCles(db, userId)) {
    const valeur = dechiffrer(c.chiffre, c.nonce, dek);
    // Une entree illisible est ignoree en silence cote donnees, mais l'utilisateur la
    // verra comme « non renseignee » dans sa page de compte : il pourra la ressaisir.
    if (valeur) out[c.nom] = valeur;
  }
  return out;
}

/**
 * Les identifiants Z-Library, ou `null`.
 *
 * LES DEUX OU AUCUN. Une adresse sans mot de passe n'est pas un demi-compte, c'est une
 * saisie incomplete : la source doit alors se comporter comme si rien n'etait renseigne,
 * plutot que de tenter une connexion vouee a echouer et d'en rendre l'erreur.
 */
export function identifiantsZlibrary(
  cles: ClesEnClair,
): { email: string; motdepasse: string } | null {
  const email = (cles.zlib_email ?? '').trim();
  const motdepasse = cles.zlib_mdp ?? '';
  if (!email || !motdepasse) return null;
  return { email, motdepasse };
}

/** Sous-ensemble attendu par les sources de recherche. */
export function clesDeRecherche(cles: ClesEnClair) {
  return {
    c411: cles.c411, tr4ker: cles.tr4ker, ygg: cles.ygg,
    g3mini: cles.g3mini, v3x: cles.v3x,
  };
}
