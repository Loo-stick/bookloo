import type { Database } from 'better-sqlite3';
import { NOMS_CLES, type NomCleStockee } from './schema';

export interface CleStockee {
  nom: NomCleStockee;
  chiffre: Buffer;
  nonce: Buffer;
}

export function poserCle(
  db: Database,
  userId: number,
  nom: string,
  chiffre: Buffer,
  nonce: Buffer,
): void {
  if (!(NOMS_CLES as readonly string[]).includes(nom)) {
    throw new Error(`nom de cle inconnu: ${nom}`);
  }
  db.prepare(
    'INSERT OR REPLACE INTO cles (user_id, nom, chiffre, nonce) VALUES (?, ?, ?, ?)',
  ).run(userId, nom, chiffre, nonce);
}

export function retirerCle(db: Database, userId: number, nom: string): void {
  db.prepare('DELETE FROM cles WHERE user_id = ? AND nom = ?').run(userId, nom);
}

export function lireCles(db: Database, userId: number): CleStockee[] {
  return db.prepare('SELECT nom, chiffre, nonce FROM cles WHERE user_id = ?').all(userId) as CleStockee[];
}
