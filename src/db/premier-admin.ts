// Premier compte administrateur.
//
// Cree au tout premier demarrage, avec un mot de passe aleatoire affiche UNE SEULE FOIS
// dans les logs. C'est le motif d'Inkshelf, et il est bon : il evite d'exposer un
// formulaire d'inscription public sur une application accessible depuis Internet.

import { randomBytes } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import { compterUtilisateurs } from './utilisateurs';
import { creerCompte } from '../routes/admin';

/** Alphabet sans caracteres ambigus : un mot de passe recopie a la main doit l'etre juste. */
const ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function motDePasseAleatoire(longueur = 20): string {
  const octets = randomBytes(longueur);
  let out = '';
  for (let i = 0; i < longueur; i++) out += ALPHABET[octets[i] % ALPHABET.length];
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
