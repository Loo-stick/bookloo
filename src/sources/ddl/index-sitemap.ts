// Un inventaire de site, bati sur ses sitemaps ou ses pages de liste, et tenu sur disque.
//
// Le nom du fichier date de ses deux premieres sources, qui lisaient des sitemaps.
// worldivx, arrive ensuite, n'en a pas : il lit ses pages de liste. Le module ne sait rien
// de la facon dont les fiches arrivent — c'est `lire` qui le sait.
//
// POURQUOI UN MODULE COMMUN. Deux sources en ont besoin — 1001ebooks et downmagaz — pour
// la meme raison : leur recherche est fermee aux automates par leur `robots.txt`, alors
// que leur sitemap, lui, est publie pour ca. La construction, le verrou, la fraicheur et
// la recherche par mots entiers etaient ecrits pour la premiere ; les recopier pour la
// seconde aurait donne deux regles qui divergent le jour ou l'une se corrige.
//
// POURQUOI SUR DISQUE. Mesure du 2026-09-08 : 47 501 fiches tiennent en 11,9 Mo de tas
// sous la forme la plus simple, et ce conteneur est plafonne. Une base a cote — jetable,
// reconstructible, comme `cache.db` l'est de `mangaloo.db` — coute zero octet de tas,
// survit aux redemarrages, et rend la recherche a SQLite qui sait la faire.
//
// LA CONSTRUCTION EST LENTE ET RARE. Elle ne peut donc pas vivre dans une recherche : elle
// part en arriere-plan, une seule a la fois, et l'index precedent continue de servir.

import type { Database } from 'better-sqlite3';
import { ouvrirBase, cheminEtat } from '../../core/sqlite';

/** Une fiche telle que la source la range. */
export interface FicheIndexable {
  categorie: string;
  slug: string;
  /** Les rayons qu'elle sert. Vide : la fiche est ignoree. */
  familles: readonly string[];
  /** Ses mots, deja normalises. */
  mots: readonly string[];
  /**
   * Son rang de tri, le plus grand en tete. Absent : l'ordre d'ecriture.
   *
   * Pour un periodique c'est ce qui decide de ce qu'on voit : 513 numeros d'Investir pour
   * quarante places, et le premier rendu datait de novembre 2025 quand le dernier paru
   * etait du 12 septembre 2026.
   */
  rang?: number;
  /**
   * Ce que la source veut retrouver A LA RECHERCHE sans rouvrir la page : pour un torrent,
   * son empreinte, sa taille, ses seeders et son nom exact. Absent : rien de plus que le
   * slug. Range en JSON, rendu tel quel.
   */
  donnees?: Record<string, unknown>;
}

export interface FicheIndexee {
  categorie: string;
  slug: string;
  /** Present seulement quand la source en a range : voir `FicheIndexable.donnees`. */
  donnees?: Record<string, unknown>;
}

export interface OptionsIndex {
  /** Pour les journaux : « [1001ebooks] index reconstruit… ». */
  nom: string;
  fichier: string;
  /** La variable d'environnement qui peut designer un autre fichier — les tests s'en servent. */
  variable: string;
  fraicheurMs: number;
  /**
   * Lit le site et remet les fiches PAR LOTS. Le rythme — une pause entre deux requetes,
   * la trace de chaque appel — appartient a la source, qui connait son site.
   */
  lire: (
    ecrire: (lot: readonly FicheIndexable[]) => void,
    signal?: AbortSignal,
    /** L'index connait-il deja cette fiche ? Sert a savoir OU S'ARRETER de lire. */
    connait?: (categorie: string, slug: string) => boolean,
  ) => Promise<void>;
}

export interface IndexSitemap {
  taille(): number;
  perime(): boolean;
  chercher(famille: string, mots: readonly string[], limite?: number): FicheIndexee[];
  construire(signal?: AbortSignal): Promise<number>;
  assurer(): boolean;
}

export function creerIndexSitemap(o: OptionsIndex): IndexSitemap {
  /**
   * La base, ouverte au PREMIER USAGE et pas a la creation.
   *
   * Un module qui cree un fichier sur disque en etant simplement importe est un module
   * qu'on ne peut pas placer ailleurs — les tests l'ont montre tout de suite : la base
   * etait deja ouverte a son chemin par defaut avant qu'ils aient pu en designer une autre.
   * C'est aussi ce qui evite qu'un fichier d'index apparaisse chez quelqu'un qui
   * n'utilisera jamais la source.
   */
  let base: Database | null = null;
  const db = (): Database => {
    if (base) return base;
    base = ouvrirBase(cheminEtat(o.fichier, o.variable));
    base.pragma('journal_mode = WAL');
    base.pragma('synchronous = NORMAL');
    base.exec(`
      CREATE TABLE IF NOT EXISTS fiches (
        categorie TEXT NOT NULL,
        slug TEXT NOT NULL,
        -- LES RAYONS, SEPARES PAR DES ESPACES. Une fiche peut en servir deux — un album
        -- de BD est aussi cherche dans Comics — et une liste en une colonne garde le
        -- schema qu'avait deja l'index de 1001ebooks, ou chaque fiche n'en portait qu'un.
        famille TEXT NOT NULL,
        -- Les mots, ENTOURES D'ESPACES aux deux bouts. C'est ce qui permet a SQLite de
        -- chercher un mot ENTIER — « % elle % » — la ou un « %elle% » nu rendrait
        -- « michelle ».
        mots TEXT NOT NULL,
        PRIMARY KEY (categorie, slug)
      );
      CREATE INDEX IF NOT EXISTS idx_fiches_famille ON fiches(famille);
      CREATE TABLE IF NOT EXISTS meta (cle TEXT PRIMARY KEY, valeur TEXT NOT NULL);
    `);
    // LE RANG EST ARRIVE APRES LA PREMIERE BASE : `CREATE TABLE IF NOT EXISTS` ne touche
    // pas a une table existante, et l'index de 1001ebooks deja deploye n'aurait jamais eu
    // la colonne. Meme reprise que `ajouterColonne` dans le schema applicatif.
    const colonnes = base.prepare('PRAGMA table_info(fiches)').all() as { name: string }[];
    if (!colonnes.some((c) => c.name === 'rang')) base.exec('ALTER TABLE fiches ADD COLUMN rang INTEGER');
    // Les donnees sont arrivees avec worldivx, apres les deux premiers index : meme reprise.
    if (!colonnes.some((c) => c.name === 'donnees')) base.exec('ALTER TABLE fiches ADD COLUMN donnees TEXT');
    return base;
  };

  const taille = (): number =>
    (db().prepare('SELECT COUNT(*) AS n FROM fiches').get() as { n: number }).n;

  const construitLe = (): number => {
    const l = db().prepare('SELECT valeur FROM meta WHERE cle = ?').get('construit_le') as
      { valeur: string } | undefined;
    return l ? Number(l.valeur) || 0 : 0;
  };

  const perime = (): boolean => Date.now() - construitLe() > o.fraicheurMs;

  /**
   * Les fiches d'un rayon qui portent TOUS ces mots.
   *
   * Le rayon se cherche lui aussi en mot entier, dans la liste entouree d'espaces : sans
   * cela « bd » trouverait une famille qui le contiendrait. A cinquante mille lignes, un
   * parcours de SQLite ne se voit pas, et le tas reste libre.
   */
  const chercher = (famille: string, mots: readonly string[], limite = 60): FicheIndexee[] => {
    if (!mots.length || !famille) return [];
    const conditions = mots.map(() => 'mots LIKE ?').join(' AND ');
    // LE PLUS GRAND RANG EN TETE, puis l'ordre d'ecriture. Sous SQLite un rang absent vaut
    // moins que tout : une source qui n'en donne pas garde donc son ordre d'avant.
    const lignes = db()
      .prepare(
        `SELECT categorie, slug, donnees FROM fiches
          WHERE (' ' || famille || ' ') LIKE ? AND ${conditions}
          ORDER BY rang DESC, rowid LIMIT ?`,
      )
      .all(`% ${famille} %`, ...mots.map((m) => `% ${m} %`), limite) as
      { categorie: string; slug: string; donnees: string | null }[];
    // `donnees` N'APPARAIT QUE S'IL EXISTE : une cle a `undefined` rendrait differentes, pour
    // une comparaison stricte, deux fiches identiques d'une source qui n'en range pas.
    return lignes.map((l) => {
      const f: FicheIndexee = { categorie: l.categorie, slug: l.slug };
      if (l.donnees) {
        try { f.donnees = JSON.parse(l.donnees) as Record<string, unknown>; } catch { /* ligne abimee : sans donnees */ }
      }
      return f;
    });
  };

  let enCours: Promise<number> | null = null;

  /**
   * Reconstruit l'index. Une seule construction a la fois.
   *
   * Sans ce verrou, deux recherches lancees coup sur coup doubleraient les requetes chez
   * un site qui n'a rien demande. La seconde attend la premiere et profite du meme travail.
   */
  const construire = (signal?: AbortSignal): Promise<number> => {
    if (enCours) return enCours;
    enCours = (async () => {
      const debut = Date.now();
      let lues = 0;
      const inserer = db().prepare(
        'INSERT OR REPLACE INTO fiches (categorie, slug, famille, mots, rang, donnees) VALUES (?, ?, ?, ?, ?, ?)',
      );
      const ecrire = db().transaction((lot: readonly FicheIndexable[]) => {
        for (const f of lot) {
          if (!f.familles.length || !f.mots.length) continue;
          inserer.run(
            f.categorie, f.slug, f.familles.join(' '), ` ${f.mots.join(' ')} `,
            Number.isFinite(f.rang) ? f.rang : null,
            f.donnees ? JSON.stringify(f.donnees) : null,
          );
          lues += 1;
        }
      });
      const existe = db().prepare('SELECT 1 FROM fiches WHERE categorie = ? AND slug = ?');
      const connait = (categorie: string, slug: string): boolean =>
        Boolean(existe.get(categorie, slug));
      await o.lire((lot) => ecrire(lot), signal, connait);
      if (lues > 0) {
        db().prepare('INSERT OR REPLACE INTO meta (cle, valeur) VALUES (?, ?)')
          .run('construit_le', String(Date.now()));
      }
      // LE NOMBRE DE LIGNES, PAS D'INSERTIONS. Les sitemaps de 1001ebooks se recouvrent :
      // 53 988 adresses publiees pour 47 501 fiches reelles. Annoncer le premier chiffre
      // etait faux de sept mille.
      const n = taille();
      console.log(
        `[${o.nom}] index reconstruit : ${n} fiches (${lues} adresses lues)`
        + ` en ${((Date.now() - debut) / 1000).toFixed(0)} s`,
      );
      return n;
    })().finally(() => { enCours = null; });
    return enCours;
  };

  /**
   * S'assure qu'un index utilisable existe.
   *
   * Rend VRAI quand on peut chercher tout de suite. Un index perime reste utilisable — un
   * catalogue d'hier vaut infiniment mieux qu'une source muette — et sa reconstruction
   * part derriere sans faire attendre la recherche en cours.
   */
  const assurer = (): boolean => {
    const garni = taille() > 0;
    if (!garni || perime()) {
      void construire().catch((e) => {
        console.log(`[${o.nom}] index non reconstruit : ${(e as Error).message}`);
      });
    }
    return garni;
  };

  return { taille, perime, chercher, construire, assurer };
}
