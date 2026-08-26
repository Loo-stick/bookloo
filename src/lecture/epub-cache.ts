// Le magasin d'EPUB rapatries.
//
// POURQUOI UN CACHE, ET PAS UN TELECHARGEMENT A CHAQUE FOIS. Deux raisons, dont une
// suffirait.
//
// D'abord le CDN de Z-Library n'honore que les plages SUFFIXES — mesure du 2026-08-24,
// `bytes=-2048` rend 206 et `bytes=0-99` rend 416. Le lecteur ZIP lit chaque entree a un
// offset arbitraire : impossible de travailler a distance, il faut le fichier entier.
//
// Ensuite et surtout, obtenir le lien de telechargement consomme une unite du QUOTA
// QUOTIDIEN de l'utilisateur. Rouvrir un livre au chapitre suivant ne doit pas lui couter
// un telechargement. Le cache n'est donc pas une optimisation, c'est une necessite.
//
// L'EPUB median pese 1,4 Mo (mesure sur 73 fichiers) : le plafond ci-dessous est genereux
// pour un livre et etroit pour ce qui n'en est pas un.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { cheminEtat } from '../core/sqlite';

/** Au-dela, ce n'est plus un livre. Le maximum observe (244 Mo) est une anomalie. */
export const MAX_LIVRE_OCTETS = 60 * 1024 * 1024;
/** Budget total du dossier. Les acces les plus anciens sont evinces en premier. */
export const MAX_DOSSIER_OCTETS = 500 * 1024 * 1024;

function dossier(): string {
  const d = cheminEtat('epub');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/**
 * Le nom de fichier d'une identite.
 *
 * Une empreinte, et non l'identite elle-meme : elle contient des deux-points, que tous
 * les systemes de fichiers n'acceptent pas, et rien n'en garantit la longueur.
 */
export function nomDeCache(identite: string): string {
  return `${createHash('sha256').update(identite).digest('hex').slice(0, 32)}.epub`;
}

/** Le chemin d'un livre en cache, ou `null` s'il n'y est pas. */
export function enCache(identite: string): string | null {
  const p = path.join(dossier(), nomDeCache(identite));
  if (!fs.existsSync(p)) return null;
  // La date d'acces sert a l'eviction : la poser ici fait qu'un livre relu ne sort pas.
  try { fs.utimesSync(p, new Date(), fs.statSync(p).mtime); } catch { /* sans importance */ }
  return p;
}

/**
 * Fait de la place pour `attendu` octets de plus.
 *
 * Evince par date d'ACCES croissante, pas de creation : un livre rapatrie il y a un mois
 * mais relu hier est celui qu'on veut garder.
 */
export function evincer(attendu: number): void {
  const d = dossier();
  const fichiers = fs.readdirSync(d)
    .filter((n) => n.endsWith('.epub'))
    .map((n) => {
      const p = path.join(d, n);
      const st = fs.statSync(p);
      return { p, taille: st.size, vu: st.atimeMs };
    })
    .sort((a, b) => a.vu - b.vu);

  let total = fichiers.reduce((s, f) => s + f.taille, 0);
  for (const f of fichiers) {
    if (total + attendu <= MAX_DOSSIER_OCTETS) return;
    try { fs.unlinkSync(f.p); total -= f.taille; } catch { /* deja parti */ }
  }
}

/** Range un livre. Rend son chemin. */
export function deposer(identite: string, octets: Buffer): string {
  evincer(octets.length);
  const p = path.join(dossier(), nomDeCache(identite));
  // Ecriture puis renommage : un telechargement interrompu ne doit pas laisser un
  // fichier tronque que la lecture suivante prendrait pour un livre valide.
  const temporaire = `${p}.partiel`;
  fs.writeFileSync(temporaire, octets);
  fs.renameSync(temporaire, p);
  return p;
}
