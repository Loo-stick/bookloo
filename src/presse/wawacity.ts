// Wawacity au kiosque.
//
// Rien a ecrire de neuf pour la lecture : la page d'une rubrique a EXACTEMENT le meme
// balisage qu'une page de recherche, deja parsee et deja testee par
// `parseRechercheWawacity`. Seule l'adresse change — `?p=ebooks&s=journaux` au lieu de
// `?p=ebooks&search=…`.

import { cached } from '../core/cache';
import { getText } from '../core/http';
import { tracerAppel, hoteDe } from '../core/journal';
import { baseWawacity, parseRechercheWawacity } from '../sources/ddl/wawacity';
import { separerTitreDate } from './titre-date';
import { rubriqueDuSuffixe } from './rubrique';
import type { Kiosque, Numero, Rubrique } from './types';

const TTL_MS = 30 * 60 * 1000;
const TTL_VIDE_MS = 10 * 60 * 1000;
const MAX_OCTETS = 4 * 1024 * 1024;
const MAX_NUMEROS = 60;
/** Une page rend dix fiches — trop peu pour un kiosque. Le site repond en 400 ms. */
const PAGES = 3;

/** MESURE DU 2026-09-01 : `&page=2` rend les dix suivants ; `&p=2` ne rend rien. */
export function urlRubriqueWawacity(rubrique: Rubrique, page = 1): string {
  const base = `${baseWawacity()}/?p=ebooks&s=${rubrique}`;
  return page <= 1 ? base : `${base}&page=${page}`;
}

export const wawacity: Kiosque = {
  id: 'wawacity',
  libelle: 'Wawacity',
  async dernieres(rubrique, signal) {
    const out: Numero[] = [];
    const vus = new Set<string>();
    for (let n = 1; n <= PAGES; n += 1) {
      const url = urlRubriqueWawacity(rubrique, n);
      const debut = Date.now();
      const html = await cached<string | null>(
        `presse:wawacity:${rubrique}:${n}`,
        TTL_MS,
        async () => {
          const h = await getText(url, { timeoutMs: 15000, signal, retries: 1, maxBytes: MAX_OCTETS });
          tracerAppel({
            source: 'wawacity',
            hote: hoteDe(url),
            statut: h === null ? null : 200,
            duree: Date.now() - debut,
            ok: h !== null,
          });
          return h;
        },
        {
          scope: 'presse:wawacity',
          echec: (v) => v === null,
          shouldCache: (v) => v !== null,
          negativeTtlMs: TTL_VIDE_MS,
        },
      );
      // Un echec sur la PREMIERE page est une panne ; sur les suivantes, mieux vaut rendre
      // ce qu'on a que rien.
      if (html === null) {
        if (n === 1) throw new Error('Wawacity n a pas repondu');
        break;
      }
      const lot = parseRechercheWawacity(html)
        .filter((f) => !vus.has(f.id))
        .map((f): Numero => {
          const { titre, date } = separerTitreDate(f.titre);
          return { site: 'wawacity', id: f.id, titre, rubrique, date, brut: f.titre };
        });
      // Une page qui ne rend rien de neuf veut dire qu'on a atteint le bout.
      if (lot.length === 0) break;
      for (const x of lot) { vus.add(x.id); out.push(x); }
      if (out.length >= MAX_NUMEROS) break;
    }
    return out.slice(0, MAX_NUMEROS);
  },
  chercheable: true,
  // `_ctx` IGNORE, ET NOMME : ce site repond a tout le monde. Le laisser sans nom
  // ferait croire a un oubli la ou c'est une propriete du site.
  async chercher(terme, _ctx, signal) {
    const url = `${baseWawacity()}/?p=ebooks&search=${encodeURIComponent(terme)}`;
    const debut = Date.now();
    const html = await cached<string | null>(
      `presse:wawacity:q:${terme.toLowerCase()}`,
      TTL_MS,
      async () => {
        const h = await getText(url, { timeoutMs: 15000, signal, retries: 1, maxBytes: MAX_OCTETS });
        tracerAppel({
          source: 'wawacity',
          hote: hoteDe(url),
          statut: h === null ? null : 200,
          duree: Date.now() - debut,
          ok: h !== null,
        });
        return h;
      },
      {
        scope: 'presse:wawacity',
        echec: (v) => v === null,
        shouldCache: (v) => v !== null,
        negativeTtlMs: TTL_VIDE_MS,
      },
    );
    if (html === null) throw new Error('Wawacity n a pas repondu');
    // UNE RECHERCHE WAWACITY REND AUSSI DES ROMANS, DES BD ET DES MANGAS. Le suffixe du
    // titre dit la rubrique, et tout ce qui n'en porte pas une de presse est ecarte :
    // sans ce filtre, chercher « Le Monde » ramenerait les romans qui le contiennent.
    const out: Numero[] = [];
    for (const f of parseRechercheWawacity(html)) {
      const rubrique = rubriqueDuSuffixe(f.titre);
      if (!rubrique) continue;
      const { titre, date } = separerTitreDate(f.titre);
      out.push({ site: 'wawacity', id: f.id, titre, rubrique, date, brut: f.titre });
      if (out.length >= MAX_NUMEROS) break;
    }
    return out;
  },
};
