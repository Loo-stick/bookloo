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

export interface EntreeBibliotheque {
  oeuvre: string;
  titre: string;
  couverture: string | null;
  ajouteLe: number;
  cleRelease: string | null;
  titreRelease: string | null;
  source: string | null;
  /** Tomes connus de la release memorisee, dans l'ordre. Vide tant qu'on n'a rien liste. */
  tomes: string[];
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
  db.prepare(
    `INSERT INTO favoris (user_id, oeuvre, titre, couverture, ajoute_le, cle_release, titre_release, source, famille)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, oeuvre) DO UPDATE SET
       titre = excluded.titre,
       couverture = COALESCE(excluded.couverture, favoris.couverture),
       cle_release = COALESCE(excluded.cle_release, favoris.cle_release),
       titre_release = COALESCE(excluded.titre_release, favoris.titre_release),
       source = COALESCE(excluded.source, favoris.source),
       famille = COALESCE(excluded.famille, favoris.famille)`,
  ).run(
    userId,
    f.oeuvre,
    f.titre,
    f.couverture ?? null,
    Date.now(),
    f.cleRelease ?? null,
    f.titreRelease ?? null,
    f.source ?? null,
    f.famille ?? null,
  );
}

export function oublier(db: Database, userId: number, oeuvre: string): void {
  // `progression` porte `user_id` directement, sans cle etrangere vers `favoris` : la
  // cascade du compte la couvre, pas la suppression d'une seule oeuvre. On efface donc
  // explicitement, sinon la progression survivrait a l'oubli et reviendrait au prochain
  // suivi.
  db.prepare('DELETE FROM progression WHERE user_id = ? AND oeuvre = ?').run(userId, oeuvre);
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
  r: { cleRelease: string; titreRelease: string; source: string },
): void {
  db.prepare(
    'UPDATE favoris SET cle_release = ?, titre_release = ?, source = ? WHERE user_id = ? AND oeuvre = ?',
  ).run(r.cleRelease, r.titreRelease, r.source, userId, oeuvre);
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
      'SELECT oeuvre, titre, couverture, ajoute_le, cle_release, titre_release, source, tomes, famille'
      + ' FROM favoris WHERE user_id = ?',
    )
    .all(userId) as Record<string, never>[];

  const positions = db
    .prepare('SELECT oeuvre, tome, planche, planches, pourcent, maj_le FROM progression WHERE user_id = ?')
    .all(userId) as Record<string, never>[];

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
      tomes: string | null; famille: string | null;
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
