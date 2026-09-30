// Sessions opaques, et DEK gardee hors du disque.
//
// PAS DE JWT, et ce n'est pas une question de gout : un JWT ne se revoque pas. Une
// session en table se supprime, ce qui permet de couper un acces immediatement.
//
// LE JETON N'EST PAS STOCKE. Seul son SHA-256 l'est : une fuite de la base ne donne
// aucune session utilisable.
//
// LA DEK NE TOUCHE JAMAIS LE DISQUE. Elle vit dans une Map du processus, indexee par
// identifiant de session. Consequence assumee et testee : un redemarrage du serveur
// force une reconnexion — c'est exactement la contrepartie du modele de chiffrement
// choisi, et la faire disparaitre reviendrait a poser une cle maitre a cote de la base.

import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { Database } from 'better-sqlite3';

const DUREE_MS = 12 * 60 * 60 * 1000;

/** Secret de processus : regenere a chaque demarrage, jamais persiste. */
const SECRET_PROCESSUS = randomBytes(32);

/** id de session -> DEK en clair. Jamais serialisee, jamais journalisee. */
const dekParSession = new Map<string, Buffer>();

function empreinte(jeton: string): Buffer {
  return createHash('sha256').update(jeton).digest();
}

export interface SessionOuverte {
  id: string;
  jeton: string;
  expireLe: number;
}

export function ouvrirSession(
  db: Database,
  userId: number,
  dek: Buffer,
  ip: string,
  agent: string,
): SessionOuverte {
  const id = randomBytes(16).toString('hex');
  const jeton = randomBytes(32).toString('hex');
  const maintenant = Date.now();
  const expireLe = maintenant + DUREE_MS;

  db.prepare(
    `INSERT INTO sessions (id, user_id, token_hash, cree_le, expire_le, ip, agent)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, userId, empreinte(jeton), maintenant, expireLe, ip, agent.slice(0, 200));

  dekParSession.set(id, dek);
  return { id, jeton, expireLe };
}

export interface SessionValide {
  id: string;
  userId: number;
  dek: Buffer;
}

export function verifierSession(db: Database, jeton: string): SessionValide | null {
  if (!jeton) return null;
  const ligne = db
    .prepare('SELECT id, user_id, expire_le FROM sessions WHERE token_hash = ?')
    .get(empreinte(jeton)) as { id: string; user_id: number; expire_le: number } | undefined;
  if (!ligne) return null;
  if (ligne.expire_le < Date.now()) return null;

  const dek = dekParSession.get(ligne.id);
  // La ligne existe mais la DEK a disparu : redemarrage du serveur. Sans elle, la
  // session ne peut rien dechiffrer — la declarer valide serait mentir.
  if (!dek) return null;

  return { id: ligne.id, userId: ligne.user_id, dek };
}

export function fermerSession(db: Database, id: string): void {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  dekParSession.delete(id);
}

export function fermerSessionsDe(db: Database, userId: number): void {
  const ids = db.prepare('SELECT id FROM sessions WHERE user_id = ?').all(userId) as { id: string }[];
  for (const { id } of ids) dekParSession.delete(id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

/** Exportee pour les tests : simule la perte de memoire d'un redemarrage. */
export function oublierDek(id: string): void {
  dekParSession.delete(id);
}

export function purgerSessionsExpirees(db: Database): number {
  const expirees = db
    .prepare('SELECT id FROM sessions WHERE expire_le < ?')
    .all(Date.now()) as { id: string }[];
  for (const { id } of expirees) dekParSession.delete(id);
  const res = db.prepare('DELETE FROM sessions WHERE expire_le < ?').run(Date.now());
  return res.changes;
}

/**
 * Jeton CSRF en double-submit.
 *
 * `SameSite=Lax` ne suffit pas : il laisse passer les POST de premier niveau declenches
 * par une navigation. Le jeton est lie a la session — vole ailleurs, il ne sert a rien —
 * et derive d'un secret de processus, donc il ne se devine pas depuis l'identifiant.
 */
export function jetonCsrf(idSession: string): string {
  return createHmac('sha256', SECRET_PROCESSUS).update(idSession).digest('hex');
}
