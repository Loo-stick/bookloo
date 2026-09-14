// worldivx — presse et livres en torrents, depuis un site public francophone.
//
// CE QU'ELLE APPORTE, mesure du 2026-09-14 : ≈ 2 328 numeros de presse en PDF et ≈ 279
// livres, surtout en epub. Elle sert Presse et Livres. Voir `worldivx-liste.ts`.
//
// ELLE PASSE PAR LE CIRCUIT DES TORRENTS, pas par celui des liens directs, et c'est ce qui
// la distingue de downmagaz et de 1001ebooks, qui servent la meme presse : chaque release
// arrive avec son empreinte, donc avec ses pastilles de cache AllDebrid et TorBox — une
// consultation, rien de depose — et avec un `.torrent` public dont l'arborescence se lit
// sans rien deposer non plus. Les trackers annonces sont publics : aucune passkey, aucun
// ratio a proteger.
//
// POURQUOI UN INDEX PLUTOT QUE SA RECHERCHE. Sa recherche n'a ni filtre de categorie ni
// pagination : une seule page de cinquante lignes au plus, toutes categories melees — « One
// Piece » n'y rend que des animes, « Le Monde » treize films parmi ses cinquante lignes —
// et elle pese ≈ 650 Ko par requete. Ses deux categories utiles tiennent, elles, en une
// cinquantaine de pages de liste : on les lit une fois, puis deux pages par
// rafraichissement, et la recherche se fait ici, complete, filtree par rayon, le plus
// recent en tete.

import { httpGet } from '../../core/http';
import { tracerAppel, hoteDe } from '../../core/journal';
import { parseRelease } from './release';
import { normaliserTitre } from './release';
import type { Candidate, Query, SearchContext, Source } from '../types';
import { creerIndexSitemap, type FicheIndexee } from '../ddl/index-sitemap';
import { parcourirPages } from '../ddl/parcours-pages';
import { motsDemandes } from '../ddl/1001ebooks-fiches';
import {
  BASE_WORLDIVX, CATEGORIES_WORLDIVX, famillesDeCategorie, lignesDeLaListe, urlPageCategorie,
  urlTorrentWorldivx, type LigneWorldivx,
} from './worldivx-liste';

const MAX_RESULTATS = 40;
const RAYONS: readonly string[] = ['presse', 'livres'];
const UA = { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36' };

/**
 * Jusqu'ou lire une categorie en une construction.
 *
 * `ebooks` tient en 47 pages le 2026-09-14, `livres` en 6. Cent pages laissent le double de
 * marge sans ouvrir la porte a une lecture sans fin si la regle d'arret ne se declenchait
 * jamais.
 */
const MAX_PAGES = 100;

/** Deux pages de suite sans rien de nouveau, et on s'arrete. Voir `parcours-pages.ts`. */
const PAGES_CONNUES_AVANT_ARRET = 2;

function versIndex(categorieAdresse: string) {
  return (l: LigneWorldivx) => ({
    categorie: categorieAdresse,
    slug: String(l.id),
    // LA LIGNE DIT SA CATEGORIE ; l'adresse lue ne sert que de repli.
    familles: famillesDeCategorie(l.categorie || categorieAdresse),
    mots: normaliserTitre(l.nom).split(' ').filter(Boolean),
    // Le numero de fiche est chronologique : le dernier paru arrive en tete.
    rang: l.id,
    // LES SEEDERS SONT CEUX DU JOUR OU LA LIGNE A ETE LUE. Le rafraichissement ne relit que
    // la tete des listes : une release ancienne garde le chiffre de sa premiere lecture.
    donnees: { nom: l.nom, hash: l.hash, taille: l.taille, seeders: l.seeders, sousCategorie: l.sousCategorie },
  });
}

const index = creerIndexSitemap({
  nom: 'worldivx',
  fichier: 'index-worldivx.db',
  variable: 'INDEX_WORLDIVX_DB_PATH',
  // Douze heures : la presse du jour arrive chaque matin.
  fraicheurMs: 12 * 60 * 60 * 1000,
  async lire(ecrire, signal, connait) {
    const debut = Date.now();
    for (const categorie of CATEGORIES_WORLDIVX) {
      const { pages, nouvelles } = await parcourirPages<LigneWorldivx>({
        maxPages: MAX_PAGES,
        arretApres: PAGES_CONNUES_AVANT_ARRET,
        connait,
        extraire: lignesDeLaListe,
        cle: (l) => [categorie, String(l.id)],
        ecrire: (lignes) => ecrire(lignes.map(versIndex(categorie))),
        // Le site n'a rien demande : une page toutes les 700 ms, pas davantage. aiosources
        // en a lu trente a 500 ms d'intervalle, toutes en HTTP 200.
        pause: () => new Promise((z) => { setTimeout(z, 700); }),
        async lirePage(n) {
          const r = await httpGet<string>(urlPageCategorie(categorie, n), {
            timeoutMs: 25000, signal, headers: UA, responseType: 'text',
          });
          tracerAppel({
            source: 'worldivx',
            hote: hoteDe(BASE_WORLDIVX),
            statut: r ? r.status : null,
            duree: Date.now() - debut,
            ok: Boolean(r && r.status >= 200 && r.status < 300),
          });
          return r && r.status >= 200 && r.status < 300 ? String(r.data || '') : null;
        },
      });
      console.log(`[worldivx] ${categorie} : ${pages} page(s) lue(s), ${nouvelles} release(s) nouvelle(s)`);
    }
  },
});

export const tailleIndexWorldivx = (): number => index.taille();
/** La reconstruction, attendable : pour l'exploitation, et pour la mesurer. */
export const construireIndexWorldivx = (signal?: AbortSignal): Promise<number> => index.construire(signal);

/**
 * Le candidat d'une fiche de l'index, ou `null` si elle ne porte pas de quoi en faire un.
 *
 * Une empreinte mal formee n'est pas reparee : sans elle, ni pastille de cache ni `.torrent`.
 */
export function candidatDepuisFiche(f: FicheIndexee): Candidate | null {
  const d = f.donnees as { nom?: unknown; hash?: unknown; taille?: unknown; seeders?: unknown; sousCategorie?: unknown } | undefined;
  if (!d) return null;
  const nom = typeof d.nom === 'string' ? d.nom : '';
  const hash = typeof d.hash === 'string' ? d.hash.toLowerCase() : '';
  if (!nom || !/^[a-f0-9]{40}$/.test(hash)) return null;
  const { tomes, langue, format, provenance } = parseRelease(nom);
  return {
    source: 'worldivx',
    titre: nom,
    hash,
    torrentUrl: urlTorrentWorldivx(hash),
    taille: typeof d.taille === 'number' ? d.taille : undefined,
    seeders: typeof d.seeders === 'number' ? d.seeders : undefined,
    categorie: typeof d.sousCategorie === 'string' ? d.sousCategorie : undefined,
    tomes,
    // LE SITE EST FRANCOPHONE. La plupart des noms le disent (« FR »), pas tous : « Tests de
    // logique et psychotechniques - 2026-2027 » ne dit rien.
    langue: langue === 'inconnue' ? 'FR' : langue,
    format,
    provenance,
  };
}

export function worldivxSource(): Source {
  return {
    id: 'worldivx',
    label: 'worldivx',
    // Pas de `cleRequise` : site public.

    async search(q: Query, ctx: SearchContext): Promise<Candidate[]> {
      const famille = ctx.famille?.id;
      // Deux rayons, pas six : les autres repondent vide sans toucher a l'index.
      if (!famille || !RAYONS.includes(famille)) return [];
      const mots = motsDemandes(q.titres[0] || '');
      if (!mots.length) return [];

      // Echec, pas resultat vide : un index qui n'existe pas encore ne veut pas dire « ce
      // site ne connait pas cette oeuvre ». Meme regle que dans torznab.ts.
      if (!index.assurer()) {
        throw new Error('worldivx : inventaire en cours de construction, reessayez dans une minute');
      }
      return index.chercher(famille, mots, MAX_RESULTATS)
        .map(candidatDepuisFiche)
        .filter((c): c is Candidate => c !== null);
    },
  };
}
