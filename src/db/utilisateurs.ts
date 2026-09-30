import type { Database } from 'better-sqlite3';

export interface NouvelUtilisateur {
  login: string;
  hash: string;
  selKek: Buffer;
  dekChiffre: Buffer;
  dekNonce: Buffer;
  role?: string;
}

export interface Utilisateur {
  id: number;
  login: string;
  hash: string;
  sel_kek: Buffer;
  dek_chiffre: Buffer;
  dek_nonce: Buffer;
  role: string;
  cree_le: number;
  echecs: number;
  verrouille_jusqua: number;
}

export function creerUtilisateur(db: Database, u: NouvelUtilisateur): number {
  const res = db
    .prepare(
      `INSERT INTO utilisateurs (login, hash, sel_kek, dek_chiffre, dek_nonce, role, cree_le)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(u.login, u.hash, u.selKek, u.dekChiffre, u.dekNonce, u.role ?? 'utilisateur', Date.now());
  return Number(res.lastInsertRowid);
}

export function parLogin(db: Database, login: string): Utilisateur | undefined {
  return db.prepare('SELECT * FROM utilisateurs WHERE login = ?').get(login) as
    | Utilisateur
    | undefined;
}

export function parId(db: Database, id: number): Utilisateur | undefined {
  return db.prepare('SELECT * FROM utilisateurs WHERE id = ?').get(id) as Utilisateur | undefined;
}

export function listerUtilisateurs(db: Database): Utilisateur[] {
  return db.prepare('SELECT * FROM utilisateurs ORDER BY cree_le').all() as Utilisateur[];
}

export function compterUtilisateurs(db: Database): number {
  const r = db.prepare('SELECT COUNT(*) AS n FROM utilisateurs').get() as { n: number };
  return r.n;
}

/** Palier de verrouillage apres N echecs consecutifs. Progressif, pas binaire. */
export function enregistrerEchec(db: Database, login: string): void {
  const u = parLogin(db, login);
  if (!u) return;
  const echecs = u.echecs + 1;
  // 5 echecs : 1 min. 10 : 15 min. Au-dela : 1 h. Un verrouillage definitif serait un
  // deni de service offert a n'importe qui connaissant un login.
  const attente = echecs >= 10 ? 3_600_000 : echecs >= 5 ? 900_000 : 0;
  db.prepare('UPDATE utilisateurs SET echecs = ?, verrouille_jusqua = ? WHERE id = ?').run(
    echecs,
    attente > 0 ? Date.now() + attente : 0,
    u.id,
  );
}

export function reinitialiserEchecs(db: Database, id: number): void {
  db.prepare('UPDATE utilisateurs SET echecs = 0, verrouille_jusqua = 0 WHERE id = ?').run(id);
}

export function estVerrouille(u: Utilisateur): boolean {
  return u.verrouille_jusqua > Date.now();
}

export function changerSecretsUtilisateur(
  db: Database,
  id: number,
  hash: string,
  selKek: Buffer,
  dekChiffre: Buffer,
  dekNonce: Buffer,
): void {
  db.prepare(
    'UPDATE utilisateurs SET hash = ?, sel_kek = ?, dek_chiffre = ?, dek_nonce = ? WHERE id = ?',
  ).run(hash, selKek, dekChiffre, dekNonce, id);
}
