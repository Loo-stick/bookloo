// Schema de la base applicative.
//
// Separee du cache (`core/cache.ts`, sa propre base) : les deux n'ont ni le meme cycle
// de vie ni la meme valeur. Le cache se vide sans consequence ; celle-ci porte les
// comptes et les secrets.

import type { Database } from 'better-sqlite3';
import { ouvrirBase, cheminEtat } from '../core/sqlite';

export function ouvrirMangaloo(fichier?: string): Database {
  const chemin = fichier ?? cheminEtat('mangaloo.db', 'MANGALOO_DB_PATH');
  const db = ouvrirBase(chemin);
  if (chemin !== ':memory:') {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
  }
  // Sans ce pragma, les ON DELETE CASCADE ne se declenchent pas : supprimer un
  // utilisateur laisserait ses cles chiffrees derriere lui.
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS utilisateurs (
      id INTEGER PRIMARY KEY,
      login TEXT UNIQUE NOT NULL,
      hash TEXT NOT NULL,
      sel_kek BLOB NOT NULL,
      dek_chiffre BLOB NOT NULL,
      dek_nonce BLOB NOT NULL,
      role TEXT NOT NULL DEFAULT 'utilisateur',
      cree_le INTEGER NOT NULL,
      echecs INTEGER NOT NULL DEFAULT 0,
      verrouille_jusqua INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES utilisateurs(id) ON DELETE CASCADE,
      token_hash BLOB NOT NULL,
      cree_le INTEGER NOT NULL,
      expire_le INTEGER NOT NULL,
      ip TEXT,
      agent TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_expire ON sessions(expire_le);

    CREATE TABLE IF NOT EXISTS cles (
      user_id INTEGER NOT NULL REFERENCES utilisateurs(id) ON DELETE CASCADE,
      nom TEXT NOT NULL,
      chiffre BLOB NOT NULL,
      nonce BLOB NOT NULL,
      PRIMARY KEY (user_id, nom)
    );

    CREATE TABLE IF NOT EXISTS invitations (
      token_hash BLOB PRIMARY KEY,
      cree_par INTEGER NOT NULL,
      expire_le INTEGER NOT NULL,
      utilise_le INTEGER
    );

    -- La bibliotheque. En CLAIR, contrairement aux cles : ce ne sont pas des
    -- identifiants, personne ne peut s'en servir pour acceder a un compte. En echange le
    -- SQL reste simple, et la bibliotheque est lisible des la connexion.
    --
    -- AUCUN LIEN DEBRIDE N'EST STOCKE : il expire. Ce qu'on garde, c'est la cle de la
    -- release (un hash, ou une identite de la forme ddl:site:id) pour la re-resoudre.
    CREATE TABLE IF NOT EXISTS favoris (
      user_id INTEGER NOT NULL REFERENCES utilisateurs(id) ON DELETE CASCADE,
      oeuvre TEXT NOT NULL,
      titre TEXT NOT NULL,
      couverture TEXT,
      ajoute_le INTEGER NOT NULL,
      -- Raccourci d'acces, remplacable. Dans CETTE table a dessein : une seconde table
      -- n'aurait de sens que pour memoriser plusieurs releases par oeuvre, ce qui est
      -- hors perimetre.
      cle_release TEXT,
      titre_release TEXT,
      source TEXT,
      -- Tomes connus de la release memorisee, en JSON. Renseigne des qu'on liste ses
      -- fichiers : l'etagere montre alors le pack ENTIER et pas seulement ce qui a ete
      -- ouvert, ce qui est la seule facon de passer au tome suivant.
      tomes TEXT,
      PRIMARY KEY (user_id, oeuvre)
    );

    -- Le total de planches est stocke avec la position : sans lui on ne peut ni afficher
    -- « 87 / 180 » ni deduire qu'un tome est fini, et le retrouver imposerait de rouvrir
    -- l'archive a chaque affichage de la bibliotheque.
    CREATE TABLE IF NOT EXISTS progression (
      user_id INTEGER NOT NULL REFERENCES utilisateurs(id) ON DELETE CASCADE,
      oeuvre TEXT NOT NULL,
      tome TEXT NOT NULL,
      planche INTEGER NOT NULL,
      planches INTEGER NOT NULL,
      maj_le INTEGER NOT NULL,
      PRIMARY KEY (user_id, oeuvre, tome)
    );
    CREATE INDEX IF NOT EXISTS idx_progression_maj ON progression(user_id, maj_le);
    -- Les releases qui COMBLENT ce que la principale ne porte pas.
    --
    -- "favoris.cle_release" reste la release principale : rien de ce qui marche ne change
    -- de sens. Un pack est simplement rarement complet, et le cul-de-sac etait deja code
    -- — « Ce tome n est pas dans la release memorisee » n offrait aucune suite.
    CREATE TABLE IF NOT EXISTS releases_appoint (
      user_id INTEGER NOT NULL REFERENCES utilisateurs(id) ON DELETE CASCADE,
      oeuvre TEXT NOT NULL,
      cle_release TEXT NOT NULL,
      titre_release TEXT,
      source TEXT,
      -- Les tomes que CETTE release porte, meme format que "favoris.tomes" : des identites
      -- "t<n>" ou "f:<nom>", en JSON.
      tomes TEXT,
      -- LE TOME QUE CET APPOINT SERT, quand sa propre numerotation ne le dit pas.
      --
      -- "identiteTome" ne numerote un fichier que si son nom porte un numero, sinon il rend
      -- "f:<nom>". Or le cas d usage meme est un tome isole pris sur Telegram ou Z-Library,
      -- dont le nom ne suit aucune convention : sans ce champ il serait inattachable.
      tome_cible TEXT,
      ajoute_le INTEGER NOT NULL,
      -- Une meme release ne s attache pas deux fois a la meme oeuvre : deux lignes
      -- concurrentes pour un meme tome, et le retrait n en enleverait qu une.
      PRIMARY KEY (user_id, oeuvre, cle_release)
    );
  `);

  // Colonnes ajoutees APRES la premiere mise en service. `CREATE TABLE IF NOT EXISTS`
  // ne touche pas a une table existante : sans cette reprise, la base deja deployee
  // garderait son ancien schema et chaque ecriture echouerait sur une colonne absente.
  ajouterColonne(db, 'favoris', 'tomes', 'TEXT');
  // LA FAMILLE EST RETENUE PARCE QU'ELLE NE SE DEDUIT PAS. Changer de release depuis la
  // bibliotheque demande d'interroger les sources, donc de connaitre le rayon — et une
  // identite ne le dit pas : « bn: » ne distingue pas un livre d'un livre audio, ni
  // « md:cv: » un comics d'une BD. On l'enregistre la ou on la connait, au suivi.
  // Vide sur les oeuvres suivies avant cette colonne : l'interface la demande une fois.
  ajouterColonne(db, 'favoris', 'famille', 'TEXT');
  // POUR LES LIVRES. Un chapitre d'EPUB est un flux continu : « chapitre 4 sur 34 » ne
  // dit pas ou on en est dedans. `planche` porte l'index du chapitre, `planches` leur
  // nombre, et cette colonne la position A L'INTERIEUR, en pourcentage.
  //
  // Nullable a dessein : un CBZ n'en a pas, et lui en inventer une ferait croire a une
  // precision qui n'existe pas.
  ajouterColonne(db, 'progression', 'pourcent', 'INTEGER');
  // Le dernier tome annonce par LE CATALOGUE. NULL veut dire « on ne sait pas », et c est
  // un etat de plein droit : la grille s arrete alors au plus grand tome connu. Une serie
  // en cours n a pas de dernier tome, et pretendre le contraire afficherait des trous faux.
  ajouterColonne(db, 'favoris', 'dernier_tome', 'INTEGER');

  return db;
}

/**
 * Ajoute une colonne si elle manque. Idempotent, donc sans effet sur une base neuve
 * (ou le CREATE TABLE l'a deja posee) comme sur une base deja migree.
 */
function ajouterColonne(db: Database, table: string, colonne: string, type: string): void {
  const colonnes = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (colonnes.some((c) => c.name === colonne)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${colonne} ${type}`);
  console.log(`[Base] colonne ${table}.${colonne} ajoutee`);
}

/**
 * Noms de cles acceptes. Toute autre valeur est refusee a l'ecriture.
 *
 * Z-Library occupe DEUX entrees plutot qu'une valeur structuree. La table associe un nom
 * a une valeur, et elle porte les passkeys de tous les utilisateurs : en changer la forme
 * pour accueillir une source de plus serait un risque hors de proportion avec le gain.
 */
export const NOMS_CLES = [
  'c411', 'tr4ker', 'ygg', 'g3mini', 'v3x', 'ad', 'tb', 'rustatio',
  'zlib_email', 'zlib_mdp',
] as const;
export type NomCleStockee = (typeof NOMS_CLES)[number];
