// Premier compte administrateur.
//
// Cree au tout premier demarrage, avec un mot de passe aleatoire affiche UNE SEULE FOIS
// dans les logs. C'est le motif d'Inkshelf, et il est bon : il evite d'exposer un
// formulaire d'inscription public sur une application accessible depuis Internet.

import { randomInt } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { compterUtilisateurs } from './utilisateurs';
import { creerCompte } from '../routes/admin';

/** Alphabet sans caracteres ambigus : un mot de passe recopie a la main doit l'etre juste. */
const ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * Un mot de passe tire UNIFORMEMENT dans l'alphabet.
 *
 * `randomBytes[i] % 56` n'est pas uniforme : 256 = 4 x 56 + 32, donc les 32 premiers
 * caracteres de l'alphabet sortaient 5 fois sur 256 et les 24 autres 4 fois — un biais
 * de 25 %. Sur vingt caracteres l'entropie perdue se compte en fractions de bit, et ce
 * mot de passe est fait pour etre change des la premiere connexion. On le corrige parce
 * qu'un generateur de secret biaise n'a aucune raison de le rester, et que `randomInt`
 * fait le rejet d'echantillon pour nous. Signale par une revue le 2026-08-29.
 */
export function motDePasseAleatoire(longueur = 20): string {
  let out = '';
  for (let i = 0; i < longueur; i++) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

export async function assurerPremierAdmin(
  db: Database,
): Promise<{ login: string; motDePasse: string } | null> {
  if (compterUtilisateurs(db) > 0) return null;
  const login = process.env.ADMIN_LOGIN?.trim() || 'admin';
  const motDePasse = motDePasseAleatoire();
  await creerCompte(db, login, motDePasse, 'admin');
  return { login, motDePasse };
}
