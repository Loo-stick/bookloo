// Acces SQL de la bibliotheque.
//
// Aucune regle metier ici : le bornage vient de `identites.ts`, l'authentification des
// routes. Ce fichier ne fait que lire et ecrire — c'est ce qui le rend remplacable sans
// toucher au reste.

import type { Database } from 'better-sqlite3';
import { bornerPlanche } from './identites';

export interface Position {
  tome: string;
  planche: number;
  planches: number;
  /** Position DANS la planche, en pourcentage. Renseignee pour un livre seulement : une
   *  planche de CBZ est indivisible. */
  pourcent?: number;
  majLe: number;
}

/**
 * Une release SUPPLEMENTAIRE, qui comble ce que la principale ne porte pas.
 *
 * Un pack est rarement complet. Plutot que de laisser un tome manquant en cul-de-sac, on
 * attache une autre release pour lui — typiquement un fichier isole pris sur Telegram ou
 * Z-Library.
 */
export interface Appoint {
  cleRelease: string;
  titreRelease: string | null;
  source: string | null;
  tomes: string[];
  /** Le tome que cet appoint sert quand sa propre numerotation ne le dit pas. */
  tomeCible: string | null;
}

export interface EntreeBibliotheque {
  oeuvre: string;
  titre: string;
  couverture: string | null;
  ajouteLe: number;
  cleRelease: string | null;
  titreRelease: string | null;
  source: string | null;
  /** Le rayon, retenu au suivi. `null` sur une oeuvre suivie avant que la colonne existe. */
  famille: string | null;
  /** Tomes connus de la release memorisee, dans l'ordre. Vide tant qu'on n'a rien liste. */
  tomes: string[];
  /** Les releases qui comblent ce que la principale ne porte pas, par ordre d'ajout. */
  appoints: Appoint[];
  /** Dernier tome annonce par le catalogue, ou `null` — on ne le devine jamais. */
  dernierTome: number | null;
  positions: Position[];
  /** Max(derniere position, date d'ajout). Sert au tri, jamais stocke. */
  derniereLecture: number;
}

export function suivre(
  db: Database,
  userId: number,
  f: {
    oeuvre: string;
    titre: string;
    couverture?: string | null;
    cleRelease?: string | null;
    titreRelease?: string | null;
    source?: string | null;
    famille?: string | null;
  },
): void {
  // On met a jour le raccourci SANS ecraser la date d'ajout : suivre a nouveau une oeuvre
  // depuis une autre release doit changer le chemin d'acces, pas l'anciennete — c'est
  // elle qui classe une oeuvre jamais ouverte.
  //
  // Les COALESCE evitent qu'un appel partiel (l'entree automatique en lecture, qui ne
  // connait pas la release) efface un raccourci pose explicitement.
  // LIRE UN APPOINT NE LE PROMEUT PAS. Lire une oeuvre retient la release d'ou on l'a lue
  // — c'est ce qui remplit la bibliotheque toute seule. Mais un tome servi par un appoint
  // n'apprend RIEN : cette release est deja enregistree, a sa place.
  //
  // Signale a l'usage le 2026-08-28 : ouvrir le tome 105, servi par un appoint Telegram,
  // installait ce fichier unique comme raccourci de One Piece. Le pack des tomes 1 a 104
  // disparaissait, sa liste avec — « je dois les rechercher de nouveau ».
  //
  // La garde vit ICI plutot que dans la surface de lecture : trois surfaces envoient une
  // position, et il en viendra d'autres.
  const estAppoint = f.cleRelease
    ? db.prepare('SELECT 1 FROM releases_appoint WHERE user_id = ? AND oeuvre = ? AND cle_release = ?')
      .get(userId, f.oeuvre, f.cleRelease)
    : undefined;
  // Les trois champs decrivent UNE release : on les tait ensemble, sinon la description
  // d'un appoint viendrait coiffer le raccourci qu'on vient de proteger.
  const cleRelease = estAppoint ? null : f.cleRelease ?? null;
  const titreRelease = estAppoint ? null : f.titreRelease ?? null;
  const source = estAppoint ? null : f.source ?? null;

  db.prepare(
    `INSERT INTO favoris (user_id, oeuvre, titre, couverture, ajoute_le, cle_release, titre_release, source, famille)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, oeuvre) DO UPDATE SET
       titre = excluded.titre,
       couverture = COALESCE(excluded.couverture, favoris.couverture),
       cle_release = COALESCE(excluded.cle_release, favoris.cle_release),
       -- LA DESCRIPTION SUIT SA RELEASE. Ces deux champs decrivent « cle_release » : les
       -- proteger chacun par un COALESCE laissait la release changer pendant que sa
       -- description restait celle de la precedente. Releve dans une vraie base le
       -- 2026-08-27 : « cle_release » pointait sur une release de tracker, source disait
       -- encore « telegram », et la bibliotheque affichait donc l'une pour l'autre.
       --
       -- « IS NOT » et non <> : la comparaison doit rester juste quand l'un des deux
       -- vaut NULL, ce que « <> » ne fait pas en SQL.
       titre_release = CASE
         WHEN excluded.cle_release IS NOT NULL AND excluded.cle_release IS NOT favoris.cle_release
         THEN excluded.titre_release
         ELSE COALESCE(excluded.titre_release, favoris.titre_release) END,
       source = CASE
         WHEN excluded.cle_release IS NOT NULL AND excluded.cle_release IS NOT favoris.cle_release
         THEN excluded.source
         ELSE COALESCE(excluded.source, favoris.source) END,
       -- LA LISTE DES FICHIERS AUSSI. Elle decrit le contenu de « cle_release » ; laissee
       -- en place, elle compte les tomes de l'ancienne release en plus de ceux de la
       -- nouvelle. Son Talisman affichait « 0 / 2 tomes lu » pour un seul livre, le tome
       -- en trop etant un fichier d'un autre roman. On l'oublie : la prochaine lecture la
       -- redonne, et sans elle l'etagere retombe sur les tomes deja ouverts — ce qui est
       -- vrai, au lieu d'etre faux.
       tomes = CASE
         WHEN excluded.cle_release IS NOT NULL AND excluded.cle_release IS NOT favoris.cle_release
         THEN NULL ELSE favoris.tomes END,
       famille = COALESCE(excluded.famille, favoris.famille)`,
  ).run(
    userId,
    f.oeuvre,
    f.titre,
    f.couverture ?? null,
    Date.now(),
    cleRelease,
    titreRelease,
    source,
    f.famille ?? null,
  );
}

/**
 * Attache une release d'appoint, ou met a jour celle qui porte deja cette cle.
 *
 * `ON CONFLICT` plutot qu'un INSERT nu : un second clic sur la meme release ferait sinon
 * deux lignes concurrentes pour le meme tome, et le retrait n'en enleverait qu'une.
 *
 * Rend `false` si l'oeuvre n'est pas suivie. La garde vit ICI plutot que dans la route :
 * sans elle on accumulerait des appoints que rien n'affiche et que rien n'efface, `oublier`
 * ne passant que sur les oeuvres suivies.
 */
export function attacherAppoint(
  db: Database,
  userId: number,
  oeuvre: string,
  a: {
    cleRelease: string; titreRelease?: string | null; source?: string | null;
    tomes?: string[]; tomeCible?: string | null;
  },
): boolean {
  const suivie = db
    .prepare('SELECT 1 FROM favoris WHERE user_id = ? AND oeuvre = ?')
    .get(userId, oeuvre);
  if (!suivie) return false;

  db.prepare(
    `INSERT INTO releases_appoint
       (user_id, oeuvre, cle_release, titre_release, source, tomes, tome_cible, ajoute_le)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, oeuvre, cle_release) DO UPDATE SET
       titre_release = excluded.titre_release,
       source = excluded.source,
       -- COALESCE, COMME LES AUTRES CHAMPS DE CE FICHIER. Sans lui, corriger la seule
       -- source d'un appoint effacait la liste des tomes qu'il sert, et la grille
       -- reperdait ses trous. Un appel qui ne fournit rien ne doit rien detruire.
       tomes = COALESCE(excluded.tomes, releases_appoint.tomes),
       tome_cible = COALESCE(excluded.tome_cible, releases_appoint.tome_cible)`,
  ).run(
    userId, oeuvre, a.cleRelease,
    a.titreRelease ?? null,
    a.source ?? null,
    a.tomes && a.tomes.length ? JSON.stringify(a.tomes) : null,
    a.tomeCible ?? null,
    Date.now(),
  );
  return true;
}

/**
 * Detache une release d'appoint.
 *
 * NE TOUCHE PAS A LA PROGRESSION : l'avancee appartient au tome, jamais a la release qui
 * l'a servi. Le tome redevient manquant, et l'on retrouve ou l'on en etait le jour ou une
 * autre release le portera.
 */
export function detacherAppoint(
  db: Database, userId: number, oeuvre: string, cleRelease: string,
): void {
  db.prepare('DELETE FROM releases_appoint WHERE user_id = ? AND oeuvre = ? AND cle_release = ?')
    .run(userId, oeuvre, cleRelease);
}

/**
 * Retient le dernier tome que le catalogue annonce.
 *
 * `null` ne SUPPRIME pas ce qu'on savait : une fiche peut repondre a vide un jour et
 * correctement le lendemain, et perdre le nombre a chaque hoquet ferait clignoter la
 * grille entre « 1 a 3 » et « 1 a 2 ».
 */
export function memoriserDernierTome(
  db: Database, userId: number, oeuvre: string, dernierTome: number | null,
): void {
  if (dernierTome === null) return;
  db.prepare('UPDATE favoris SET dernier_tome = ? WHERE user_id = ? AND oeuvre = ?')
    .run(dernierTome, userId, oeuvre);
}

export function oublier(db: Database, userId: number, oeuvre: string): void {
  // `progression` porte `user_id` directement, sans cle etrangere vers `favoris` : la
  // cascade du compte la couvre, pas la suppression d'une seule oeuvre. On efface donc
  // explicitement, sinon la progression survivrait a l'oubli et reviendrait au prochain
  // suivi.
  db.prepare('DELETE FROM progression WHERE user_id = ? AND oeuvre = ?').run(userId, oeuvre);
  db.prepare('DELETE FROM releases_appoint WHERE user_id = ? AND oeuvre = ?').run(userId, oeuvre);
  db.prepare('DELETE FROM favoris WHERE user_id = ? AND oeuvre = ?').run(userId, oeuvre);
}

/**
 * Retient les tomes que porte la release memorisee.
 *
 * On enregistre ce qu'on vient d'obtenir de toute facon en listant les fichiers : sans
 * cela, l'etagere ne pourrait montrer que les tomes DEJA ouverts, et finir le tome 1 d'un
 * pack de vingt-quatre laisserait sans moyen d'atteindre le suivant.
 */
export function memoriserTomes(db: Database, userId: number, oeuvre: string, tomes: string[]): void {
  if (!tomes.length) return;
  db.prepare('UPDATE favoris SET tomes = ? WHERE user_id = ? AND oeuvre = ?')
    .run(JSON.stringify(tomes), userId, oeuvre);
}

export function changerRaccourci(
  db: Database,
  userId: number,
  oeuvre: string,
  r: { cleRelease: string; titreRelease: string; source: string; tomes?: string[] },
): void {
  // LA LISTE DES TOMES SUIT SA RELEASE, et l'appelant en fournit une meilleure quand il
  // l'a. Le panneau des releases la deduit du titre — « One Piece [1 a 100] » annonce cent
  // tomes — ce qui evite que la bibliotheque ignore tout d'un pack tant qu'aucun tome n'y a
  // ete ouvert. Signale a l'usage : quarante-trois tomes affiches pour un pack de cent.
  //
  // Sans liste fournie, on retombe sur la regle d'avant : elle ne survit pas au
  // remplacement de la release, mais elle survit a une reconfirmation de la meme — un
  // inventaire reel obtenu du debrideur vaut mieux qu'une annonce de titre.
  //
  // SQLite evalue toute la clause SET sur les valeurs D'AVANT, donc le `cle_release` teste
  // ici est bien l'ancien, meme s'il est reaffecte deux lignes plus bas.
  const tomes = r.tomes && r.tomes.length ? JSON.stringify(r.tomes) : null;
  db.prepare(
    `UPDATE favoris
        SET tomes = CASE
              WHEN ? IS NOT NULL THEN ?
              WHEN cle_release IS NOT ? THEN NULL
              ELSE tomes END,
            cle_release = ?, titre_release = ?, source = ?
      WHERE user_id = ? AND oeuvre = ?`,
  ).run(tomes, tomes, r.cleRelease, r.cleRelease, r.titreRelease, r.source, userId, oeuvre);
}

export function enregistrerPosition(
  db: Database,
  userId: number,
  oeuvre: string,
  tome: string,
  planche: number,
  planches: number,
  /** Position DANS la planche, en pourcentage. Renseignee pour un livre, absente pour un
   *  CBZ — une planche est indivisible, lui inventer un pourcentage mentirait. */
  pourcent?: number,
): void {
  const dedans = typeof pourcent === 'number' && Number.isFinite(pourcent)
    ? Math.max(0, Math.min(100, Math.round(pourcent)))
    : null;
  db.prepare(
    `INSERT INTO progression (user_id, oeuvre, tome, planche, planches, pourcent, maj_le)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, oeuvre, tome) DO UPDATE SET
       planche = excluded.planche, planches = excluded.planches,
       pourcent = excluded.pourcent, maj_le = excluded.maj_le`,
  ).run(userId, oeuvre, tome, bornerPlanche(planche, planches), planches, dedans, Date.now());
}

export function lireBibliotheque(db: Database, userId: number): EntreeBibliotheque[] {
  // Deux requetes plates puis un regroupement en memoire, plutot qu'une jointure : le
  // volume est celui d'une bibliotheque personnelle, et le code reste lisible.
  const favoris = db
    .prepare(
      'SELECT oeuvre, titre, couverture, ajoute_le, cle_release, titre_release, source, tomes, famille,'
      + ' dernier_tome'
      + ' FROM favoris WHERE user_id = ?',
    )
    .all(userId) as Record<string, never>[];

  const positions = db
    .prepare('SELECT oeuvre, tome, planche, planches, pourcent, maj_le FROM progression WHERE user_id = ?')
    .all(userId) as Record<string, never>[];

  // Les appoints de TOUTE la bibliotheque en une requete, puis regroupes — meme forme que
  // les positions. `ORDER BY ajoute_le` porte la regle de depart : entre deux appoints qui
  // servent le meme tome, le premier ajoute gagne.
  const appoints = db
    .prepare(
      'SELECT oeuvre, cle_release, titre_release, source, tomes, tome_cible'
      + ' FROM releases_appoint WHERE user_id = ? ORDER BY ajoute_le',
    )
    .all(userId) as unknown as {
      oeuvre: string; cle_release: string; titre_release: string | null;
      source: string | null; tomes: string | null; tome_cible: string | null;
    }[];

  const appointsParOeuvre = new Map<string, Appoint[]>();
  for (const a of appoints) {
    const liste = appointsParOeuvre.get(a.oeuvre) || [];
    liste.push({
      cleRelease: a.cle_release,
      titreRelease: a.titre_release,
      source: a.source,
      tomes: lireTomes(a.tomes),
      tomeCible: a.tome_cible,
    });
    appointsParOeuvre.set(a.oeuvre, liste);
  }

  const parOeuvre = new Map<string, Position[]>();
  for (const p of positions as unknown as {
    oeuvre: string; tome: string; planche: number; planches: number;
    pourcent: number | null; maj_le: number;
  }[]) {
    const liste = parOeuvre.get(p.oeuvre) || [];
    liste.push({
      tome: p.tome, planche: p.planche, planches: p.planches,
      pourcent: p.pourcent ?? undefined, majLe: p.maj_le,
    });
    parOeuvre.set(p.oeuvre, liste);
  }

  return (
    favoris as unknown as {
      oeuvre: string; titre: string; couverture: string | null; ajoute_le: number;
      cle_release: string | null; titre_release: string | null; source: string | null;
      tomes: string | null; famille: string | null; dernier_tome: number | null;
    }[]
  )
    .map((f) => {
      const pos = (parOeuvre.get(f.oeuvre) || []).sort((a, b) => b.majLe - a.majLe);
      return {
        oeuvre: f.oeuvre,
        titre: f.titre,
        couverture: f.couverture,
        ajouteLe: f.ajoute_le,
        cleRelease: f.cle_release,
        titreRelease: f.titre_release,
        source: f.source,
        // Le RAYON, retenu au suivi. Vide sur les oeuvres suivies avant que la colonne
        // existe : l'interface le demande alors une fois, plutot que de le deviner.
        famille: f.famille,
        // Une colonne illisible ne doit pas faire tomber la bibliotheque entiere : au pire
        // l'etagere retombe sur les tomes deja ouverts.
        tomes: lireTomes(f.tomes),
        positions: pos,
        appoints: appointsParOeuvre.get(f.oeuvre) || [],
        dernierTome: f.dernier_tome ?? null,
        // Une oeuvre jamais ouverte se classe sur son ajout : sans ce repli elle
        // resterait definitivement en fin de liste, y compris le jour ou on vient de
        // l'ajouter.
        derniereLecture: Math.max(f.ajoute_le, ...pos.map((p) => p.majLe), 0),
      };
    })
    .sort((a, b) => b.derniereLecture - a.derniereLecture);
}

function lireTomes(brut: string | null): string[] {
  if (!brut) return [];
  try {
    const v = JSON.parse(brut);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
