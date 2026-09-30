// L'index des messages Telegram : ecrire, chercher, savoir ou reprendre.
//
// Base ouverte AU PREMIER USAGE, jamais a l'import — meme regle que `creerIndexSitemap`.
// Les mots sont ranges ENTOURES D'ESPACES : c'est ce qui permet a SQLite de chercher un mot
// entier (« % elle % ») la ou un « %elle% » nu rendrait « michelle ».
import Database from 'better-sqlite3';
import { cheminEtat } from '../core/sqlite';
import { normaliserTitre } from '../sources/torrent/release';

export interface MessageIndexe {
  /** Le nom public du canal — pour le lien `t.me` et la reprise par canal. */
  canal: string;
  /**
   * L'IDENTIFIANT NUMERIQUE du canal, et il n'est pas decoratif : l'identite d'une release
   * est validee par `estIdentiteTelegram`, `/^tg:\d+:\d+$/`. Y mettre « bd_fr » ferait
   * refuser toutes les releases, et la bibliotheque existante avec.
   */
  canalId: number;
  message: number;
  nom: string;
  taille: number;
  date: number;
}

/** Un document sans nom garde une identite lisible plutot que de faire echouer le lot. */
export function nomDeRepli(canal: string, message: number): string {
  return `${canal}-${message}`;
}

export interface IndexMessages {
  ecrire(lot: readonly MessageIndexe[]): void;
  chercher(mots: readonly string[], limite?: number): MessageIndexe[];
  /**
   * LE CURSEUR DE MOISSON : le plus haut identifiant de message DEJA LU pour ce canal, qu'il
   * portait un fichier ou non. 0 si le canal n'a jamais ete parcouru.
   *
   * Il ne se deduit PAS du plus grand message ecrit : un canal ou les dix derniers messages
   * ne portent aucun fichier ferait relire ces dix messages a chaque passage, indefiniment.
   * C'est le meme curseur que `last_scraped_message_id` de mangaloo, et pour la meme raison.
   */
  curseur(canal: string): number;
  noterCurseur(canal: string, message: number): void;
  taille(): number;
  oublierCanal(canal: string): void;
  /**
   * Quand la derniere passe de moisson a abouti, en ms depuis l'epoque ; 0 si jamais.
   * C'est la fraicheur de l'index, comme le `construit_le` des index de sitemap.
   */
  derniereMoisson(): number;
  noterMoisson(quand: number): void;
  /**
   * Quand une passe automatique a ete TENTEE, aboutie ou non. `derniereMoisson` ne bouge
   * qu'en cas de reussite : sans cette seconde date, une instance dont Telegram est
   * injoignable retentait a CHAQUE recherche, et le trafic de recherche devenait une boucle
   * de reconnexion MTProto — le meilleur moyen de faire limiter le compte.
   */
  derniereTentative(): number;
  noterTentative(quand: number): void;
  /**
   * Le nom public d'un canal a partir de son identifiant numerique, ou null. Telegram resout
   * un canal par son NOM ; un identifiant numerique nu echoue hors cache d'entites. Or
   * l'identite d'une release ne porte que le numero (`tg:<id>:<message>`).
   */
  canalDe(canalId: number): string | null;
}

let base: Database.Database | null = null;
function db(): Database.Database {
  if (base) return base;
  base = new Database(cheminEtat('index-telegram.db', 'BOOKLOO_INDEX_TELEGRAM'));
  base.pragma('journal_mode = WAL');
  base.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      canal TEXT NOT NULL,
      canalId INTEGER NOT NULL,
      message INTEGER NOT NULL,
      nom TEXT NOT NULL,
      taille INTEGER NOT NULL,
      date INTEGER NOT NULL,
      mots TEXT NOT NULL,
      PRIMARY KEY (canal, message)
    );
    CREATE INDEX IF NOT EXISTS idx_messages_canal ON messages(canal, message DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_canalid ON messages(canalId);
    CREATE TABLE IF NOT EXISTS meta (
      cle TEXT PRIMARY KEY,
      valeur TEXT NOT NULL
    );
  `);
  return base;
}

/** Pour les tests : la base suivante sera rouverte au chemin courant. */
export function oublierBase(): void {
  base?.close();
  base = null;
}

function lireDate(cle: string): number {
  const r = db().prepare('SELECT valeur FROM meta WHERE cle = ?').get(cle) as
    { valeur: string } | undefined;
  return Number(r?.valeur) || 0;
}

function ecrireDate(cle: string, quand: number): void {
  db().prepare('INSERT OR REPLACE INTO meta (cle, valeur) VALUES (?, ?)').run(cle, String(quand));
}

export function indexMessages(): IndexMessages {
  return {
    ecrire(lot) {
      const req = db().prepare(
        'INSERT OR REPLACE INTO messages (canal, canalId, message, nom, taille, date, mots)'
        + ' VALUES (?, ?, ?, ?, ?, ?, ?)',
      );
      const tout = db().transaction((l: readonly MessageIndexe[]) => {
        for (const m of l) {
          const nom = m.nom || nomDeRepli(m.canal, m.message);
          req.run(m.canal, m.canalId, m.message, nom, m.taille, m.date, ` ${normaliserTitre(nom)} `);
        }
      });
      tout(lot);
    },
    chercher(mots, limite = 200) {
      const propres = mots.map((x) => normaliserTitre(x)).filter(Boolean);
      if (!propres.length) return [];
      const ou = propres.map(() => 'mots LIKE ?').join(' AND ');
      return db()
        .prepare(`SELECT canal, canalId, message, nom, taille, date FROM messages WHERE ${ou} ORDER BY date DESC LIMIT ?`)
        .all(...propres.map((m) => `% ${m} %`), limite) as MessageIndexe[];
    },
    curseur(canal) {
      return lireDate(`curseur:${canal}`);
    },
    noterCurseur(canal, message) {
      ecrireDate(`curseur:${canal}`, message);
    },
    taille() {
      return (db().prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n;
    },
    oublierCanal(canal) {
      db().prepare('DELETE FROM messages WHERE canal = ?').run(canal);
      // LE CURSEUR AUSSI : sans cela, remettre le canal repartirait de la ou on s'etait
      // arrete et son historique resterait a jamais hors de portee.
      db().prepare('DELETE FROM meta WHERE cle = ?').run(`curseur:${canal}`);
    },
    derniereMoisson: () => lireDate('moissonne_le'),
    noterMoisson: (quand) => ecrireDate('moissonne_le', quand),
    derniereTentative: () => lireDate('tentative_le'),
    noterTentative: (quand) => ecrireDate('tentative_le', quand),
    canalDe(canalId) {
      const r = db().prepare('SELECT canal FROM messages WHERE canalId = ? ORDER BY rowid DESC LIMIT 1').get(canalId) as { canal: string } | undefined;
      return r?.canal ?? null;
    },
  };
}
