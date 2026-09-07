// La source Z-Library.
//
// DEUXIEME SOURCE DU PROJET A NE DEPENDRE D'AUCUN DEBRIDEUR, apres Telegram. Un livre
// indexe EST disponible : il n'y a ni cache a verifier, ni magnet a deposer. Toute la
// mecanique `en-cache` / `absent` / `inconnu` est sans objet ici.
//
// ELLE N'A PAS DE `cleRequise`, ET CE N'EST PAS UN OUBLI. Le mecanisme existant fait
// DISPARAITRE une source dont la cle manque. Or la recherche Z-Library fonctionne en
// anonyme (mesure du 2026-08-24) : la faire disparaitre priverait d'une source utile
// quiconque n'a pas encore saisi ses identifiants. Seul le telechargement echoue, et
// c'est a lui de dire pourquoi.
//
// Elle cherche par TITRE, comme Wawacity et Telegram : elle n'entre donc pas dans
// SOURCES_A_CATEGORIE, et aucune categorie n'est a declarer par famille.

import { chercher, type LivreZl } from './api';
import { normaliserIsbn } from '../../catalogue/googlebooks';
import { getSettings } from '../../core/settings';
import { parseRelease } from '../torrent/release';
import type { Candidate, Format, Langue, PlageTomes, Query, SearchContext, Source } from '../types';

/** Formats que la visionneuse ou la bibliotheque savent traiter. */
const FORMATS: Record<string, Format> = {
  cbz: 'cbz', cbr: 'cbr', pdf: 'pdf', epub: 'epub',
};

export function formatDe(extension: string | undefined): Format {
  return FORMATS[String(extension ?? '').toLowerCase()] ?? 'inconnu';
}

/** La langue telle que Z-Library la nomme, ramenee au vocabulaire du projet. */
export function langueDe(langue: string | undefined): Langue {
  const l = String(langue ?? '').toLowerCase();
  if (l === 'french') return 'FR';
  if (l === 'english') return 'EN';
  if (l === 'japanese') return 'JA';
  return 'inconnue';
}

/**
 * Le tome, lu dans le champ `series`.
 *
 * Z-Library ecrit « Le Trone de Fer-01 » : la serie et le rang dans le meme champ. C'est
 * une information qu'aucun de nos catalogues ne donne, sauf Booknode.
 *
 * `undefined` des que le suffixe manque. Deviner un tome est PIRE que ne pas en annoncer :
 * un mauvais numero envoie le lecteur vers le mauvais volume, et rien ne le signale.
 */
export function tomeDeSerie(serie: string | undefined): PlageTomes | undefined {
  const m = /-(\d{1,3})\s*$/.exec(String(serie ?? '').trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  return n > 0 ? { debut: n, integrale: false } : undefined;
}

/**
 * L'edition en une ligne, ou `undefined`.
 *
 * On n'ecrit QUE ce que la fiche dit. Z-Library rend couramment `pages: 0` et
 * `publisher: ""` : afficher « 0 p. » ou un separateur orphelin ferait passer une donnee
 * absente pour une donnee nulle.
 */
export function ligneEdition(b: LivreZl): string | undefined {
  const morceaux: string[] = [];
  const editeur = String(b.publisher ?? '').trim();
  if (editeur) morceaux.push(editeur);
  const annee = Number(b.year);
  if (Number.isFinite(annee) && annee > 0) morceaux.push(String(annee));
  const pages = Number(b.pages);
  if (Number.isFinite(pages) && pages > 0) morceaux.push(`${pages} p.`);
  return morceaux.length > 0 ? morceaux.join(' · ') : undefined;
}

/**
 * Les ISBN annonces par Z-Library, normalises.
 *
 * Le champ `identifier` les rend separes par des virgules, ISBN-10 et ISBN-13 melanges :
 * « 9782226481474,9781668016138,2226481478,1668016133 ». Mesure : 25 livres sur 30 en
 * portent au moins un.
 */
export function isbnsDeLivre(b: LivreZl): string[] | undefined {
  const bruts = String(b.identifier ?? '').split(',');
  const out: string[] = [];
  for (const x of bruts) {
    const n = normaliserIsbn(x);
    if (n && !out.includes(n)) out.push(n);
  }
  return out.length > 0 ? out : undefined;
}

/** Convertit un livre en candidat du pipeline. PUR, donc testable sans reseau. */
export function versCandidat(b: LivreZl): Candidate | null {
  const id = String(b.id ?? '').trim();
  const titre = String(b.title ?? '').trim();
  // Sans identifiant NI hash, aucun telechargement n'est possible plus tard : afficher
  // le resultat serait promettre ce qu'on ne peut pas tenir.
  if (!id || !titre || !b.hash) return null;

  return {
    source: 'zlibrary',
    // Ni `hash` ni `torrentUrl` : il n'y a rien a deposer chez un debrideur. L'identite
    // ne peut entrer en collision ni avec un infohash de quarante hexadecimaux, ni avec
    // `ddl:`, `tg:` ou `libre:`.
    identite: `zl:${id}:${b.hash}`,
    // LE TITRE SEUL, SANS L'AUTEUR. Mesure : « Holly » se rapproche de la fiche a 0,900,
    // « Holly — Stephen King » a 0,450 — sous le seuil de 0,6. Les trente resultats
    // partaient donc tous dans le bloc replie « correspondances incertaines », et filtrer
    // sur la source ne montrait plus rien.
    //
    // Le suffixe venait de l'extension Cinder, ou il est indispensable parce que Cinder
    // REGROUPE ses resultats par titre et n'en affiche qu'un. Mangaloo ne regroupe pas :
    // ses cartes portent deja le format, la taille et la langue — ce sur quoi on choisit
    // reellement une edition. C'etait le remede d'un probleme que cette application n'a
    // pas, et il en a cree un vrai.
    titre,
    taille: typeof b.filesize === 'number' && b.filesize > 0 ? b.filesize : undefined,
    // LE CHAMP `series` D'ABORD, LE TITRE ENSUITE. Le premier vient de la fiche du livre :
    // c'est une donnee, pas une deduction. Mais il est presque toujours vide, et la plage
    // restait alors INCONNUE — or une plage inconnue n'est jamais ecartee, a juste titre.
    // Signale a l'usage le 2026-08-28 : en cherchant « Le Petit Spirou tome 20 », la liste
    // remontait les tomes 1 a 18.
    //
    // Meme repli que la source Telegram, qui fait « plageDeTomes(r) ?? analyse.tomes ».
    tomes: tomeDeSerie(b.series) ?? parseRelease(titre).tomes,
    langue: langueDe(b.language),
    format: formatDe(b.extension),
    lienExterne: typeof b.href === 'string' && b.href.startsWith('https://') ? b.href : undefined,
    edition: ligneEdition(b),
    isbns: isbnsDeLivre(b),
    // Un livre est un fichier unique. L'annoncer evite que l'interface propose un choix
    // de tomes qui n'existe pas.
    nbFichiers: 1,
  };
}

export function zlibrarySources(): Source[] {
  // Domaine vide : la source n'existe pas DU TOUT, plutot que d'exister en panne. Meme
  // regle que la facade Telegram.
  if (!getSettings().zlibrary.domaine.trim()) return [];

  return [{
    id: 'zlibrary',
    label: 'Z-Library',
    async search(q: Query, ctx: SearchContext): Promise<Candidate[]> {
      // LE TITRE, PAS L'ISBN. Comparaison du 2026-08-24 sur trois fiches Booknode :
      //   titre seul     -> le bon livre au rang 1, les trois fois
      //   titre + auteur -> 0 resultat sur « La Horde du Contrevent », 0 bon sur
      //                     « L'Outsider » : le moteur fait un ET strict sur les mots
      //   ISBN Booknode  -> 0, 1 puis 0 resultat
      // Booknode donne l'ISBN d'une edition poche que Z-Library n'indexe pas. L'ISBN
      // reste porte par l'oeuvre — il est exact quand il correspond — mais le chercher
      // d'abord coutait un aller-retour pour retomber sur le titre.
      const requete = q.titres[0];
      if (!requete) return [];
      // FRANCAIS UNIQUEMENT, et le filtre se fait CHEZ LA SOURCE, pas ici. Mesure du
      // 2026-08-24 : sans filtre, « Blacksad » rend 12 francais sur 30 — le reste est
      // espagnol, chinois, portugais. Filtrer cote serveur rend 12 resultats francais sur
      // 12 : on ne gaspille pas les trente places du budget en editions illisibles.
      //
      // `languages[0]` n'accepte que la minuscule anglaise. `French` et `fr` rendent tout,
      // SANS erreur et sans rien signaler — `normaliserLangue` est donc obligatoire, pas
      // decorative.
      const livres = await chercher(requete, 'french', undefined, ctx.signal);
      return livres.map(versCandidat).filter((c): c is Candidate => c !== null);
    },
  }];
}
