// L'inventaire de 1001ebooks, tenu sur disque.
//
// La mecanique — base a cote, verrou, fraicheur, recherche par mots entiers — vit dans
// `index-sitemap.ts`, partagee avec downmagaz. Ne reste ici que ce qui est propre a CE
// site : ou sont ses sitemaps de fiches, et a quel rythme les lire.
//
// Construction mesuree le 2026-09-08 : 28 requetes, 7,3 Mo, 22 secondes.

import { httpGet } from '../../core/http';
import { tracerAppel, hoteDe } from '../../core/journal';
import {
  BASE_1001, familleDeCategorie, fichesDuSitemap, motsDuSlug,
} from './1001ebooks-fiches';
import { creerIndexSitemap, type FicheIndexee } from './index-sitemap';

export type { FicheIndexee };

/** Les adresses des sitemaps de FICHES, telles que le site les annonce lui-meme. */
export async function sitemapsDeFiches(signal?: AbortSignal): Promise<string[]> {
  const r = await httpGet<string>(`${BASE_1001}/sitemap.xml`, { timeoutMs: 20000, signal });
  if (!r || r.status < 200 || r.status >= 300) return [];
  const t = String(r.data || '');
  const out: string[] = [];
  let i = t.indexOf('<loc>');
  while (i >= 0) {
    const j = t.indexOf('</loc>', i);
    if (j < 0) break;
    const u = t.slice(i + 5, j).trim();
    // Le site publie aussi des sitemaps d'auteurs, d'editeurs et d'annees : ils ne
    // portent aucune oeuvre, et les lire couterait quatre requetes pour rien.
    if (u.includes('sitemap-books-')) out.push(u);
    i = t.indexOf('<loc>', j);
  }
  return out;
}

const index = creerIndexSitemap({
  nom: '1001ebooks',
  fichier: 'index-1001.db',
  variable: 'INDEX_1001_DB_PATH',
  // Vingt-quatre heures : le site publie chaque jour, pas chaque minute.
  fraicheurMs: 24 * 60 * 60 * 1000,
  async lire(ecrire, signal) {
    const debut = Date.now();
    for (const u of await sitemapsDeFiches(signal)) {
      const r = await httpGet<string>(u, { timeoutMs: 25000, signal });
      tracerAppel({
        source: '1001ebooks',
        hote: hoteDe(BASE_1001),
        statut: r ? r.status : null,
        duree: Date.now() - debut,
        ok: Boolean(r && r.status >= 200 && r.status < 300),
      });
      if (!r || r.status < 200 || r.status >= 300) continue;
      ecrire(fichesDuSitemap(String(r.data || '')).map((f) => {
        const famille = familleDeCategorie(f.categorie);
        return { ...f, familles: famille ? [famille] : [], mots: motsDuSlug(f.slug) };
      }));
      // Le site n'a rien demande : on ne le martele pas.
      await new Promise((z) => { setTimeout(z, 250); });
    }
  },
});

export const tailleIndex = (): number => index.taille();
export const indexPerime = (): boolean => index.perime();
export const chercherIndex = (famille: string, mots: readonly string[], limite = 60): FicheIndexee[] =>
  index.chercher(famille, mots, limite);
export const construireIndex = (signal?: AbortSignal): Promise<number> => index.construire(signal);
export const assurerIndex = (): boolean => index.assurer();
