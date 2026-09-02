// Wawacity — source en LIEN DIRECT.
//
// Elle apporte ce qu'aucun tracker ne couvre bien : la BD franco-belge, dans une
// rubrique dediee (`?p=ebooks&s=bd`), et des mangas.
//
// DEUX PIEGES DU BALISAGE, releves le 2026-08-20 et non devines :
//
//   - Les lignes publicitaires de la table de liens sont A L'INTERIEUR DE COMMENTAIRES
//     HTML (`<!--<tr class="link-row">`). Un parseur naif les ramasse et propose a
//     l'utilisateur des « hebergeurs » nommes « Anonyme » qui n'en sont pas. On retire
//     donc les commentaires AVANT de decouper — plus robuste que de filtrer sur un nom.
//   - Le parametre `fn=` n'a pas le meme sens selon la ligne : sur un vrai lien il porte
//     le NOM DE FICHIER en base64 (« Berserk - T42 [Mangas] »), sur un encart il porte un
//     identifiant interne (« ebooks|62774|1 »).
//
// LE COUT EST MAITRISE PAR LA STRUCTURE. Le site a deux niveaux — une liste, puis une
// fiche par release. Ouvrir vingt fiches par recherche serait insupportable ; or le
// TITRE DE LA LISTE suffit deja (« Berserk - T42 »). La recherche ne coute donc qu'une
// requete, et la fiche n'est ouverte que lorsque l'utilisateur ouvre la release.

import { getText } from '../../core/http';
import { cached } from '../../core/cache';
import { makeEndpointConfig } from '../../core/endpoint-config';
import { decodeEntities } from '../../core/xml';
import { parseRelease } from '../torrent/release';
import { rubriqueDuSuffixe } from '../../presse/rubrique';
import type { Candidate, Query, SearchContext, Source } from '../types';

const TTL_MS = 30 * 60 * 1000;
const TTL_VIDE_MS = 10 * 60 * 1000;
const MAX_OCTETS = 4 * 1024 * 1024;
const MAX_FICHES = 40;

// Le domaine de ce site tourne PLUSIEURS FOIS PAR AN, et l'ancien devient un domaine
// parque. Il doit etre corrigible a chaud, sans rebuild ni redemarrage.
const endpoints = makeEndpointConfig('wawacity-endpoints.json', 'WAWACITY_ENDPOINTS_CONFIG', {
  base: 'https://www.wawacity.estate',
});
export const rechargerWawacity = endpoints.reload;

export interface LienDdl {
  hebergeur: string;
  taille?: number;
  /** Le lien `dl-protect`, tel qu'il est publie. */
  url: string;
  nomFichier?: string;
}

/** Retire les commentaires HTML : c'est la ou vivent les encarts publicitaires. */
function sansCommentaires(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, '');
}

function texteNu(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    // Le decoupage laisse un chevron residuel quand la balise ouvrante a ete coupee :
    // les titres sortaient en « > Lanfeust Odyssey T10 ».
    .replace(/^[>\s]+/, '')
    .trim();
}

const UNITES: Record<string, number> = {
  o: 1, ko: 1024, mo: 1024 ** 2, go: 1024 ** 3, to: 1024 ** 4,
};

/** « 196 Mo » -> octets. Le site n'expose la taille que sous cette forme. */
export function parseTailleFr(texte: string): number | undefined {
  const m = texte.trim().match(/^([\d.,]+)\s*(o|ko|mo|go|to)$/i);
  if (!m) return undefined;
  const valeur = Number(m[1].replace(',', '.'));
  if (!Number.isFinite(valeur)) return undefined;
  const facteur = UNITES[m[2].toLowerCase()];
  return facteur ? Math.round(valeur * facteur) : undefined;
}

/** La valeur brute de `fn=`, decodee. `undefined` si le parametre manque ou est illisible. */
function valeurFn(url: string): string | undefined {
  const m = url.match(/[?&]fn=([^&]+)/);
  if (!m) return undefined;
  try {
    const brut = decodeURIComponent(m[1]);
    const complet = brut + '='.repeat((4 - (brut.length % 4)) % 4);
    return Buffer.from(complet, 'base64').toString('utf-8').trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Nom de fichier porte par le lien protege, en base64.
 *
 * Rend `undefined` si la valeur n'est pas un nom : les encarts y mettent un identifiant
 * interne separe par des barres verticales.
 */
export function decoderNomFichier(url: string): string | undefined {
  const v = valeurFn(url);
  return v === undefined || v.includes('|') ? undefined : v;
}

/**
 * Cette ligne est-elle un ENCART, et non un lien ?
 *
 * LE SECOND GARDE-FOU, ET IL FAIT DESORMAIS TOMBER LA LIGNE. `sansCommentaires` reste le
 * premier : le site emballe ses encarts dans des commentaires HTML, et les retirer avant
 * de decouper les elimine tous. Mais ce balisage a DEJA change une fois, et le jour ou
 * les encarts sortiront des commentaires, ils arriveraient ici avec un hebergeur
 * plausible et un nom de fichier vide — donc affiches.
 *
 * `decoderNomFichier` reconnaissait pourtant leur forme depuis le premier jour : il se
 * contentait de rendre `undefined`, ce qui vidait le nom sans ecarter la ligne. Le signal
 * existait et n'etait pas utilise. Signale par une revue de code le 2026-08-29.
 *
 * ON N'ECARTE QUE SUR UNE PREUVE POSITIVE : un `fn=` qui decode vers la forme
 * « ebooks|90549|1 ». Un `fn=` absent ou illisible NE FAIT PAS tomber la ligne — ce
 * serait perdre un vrai lien sur une simple evolution du site.
 *
 * MESURE DU 2026-08-31, sur huit fiches reelles (Tuniques Bleues, XIII, Thorgal, Alix,
 * The Dangers in my Heart T06, Baignade surveillee...) : 48 vrais liens, TOUS porteurs
 * d'un `fn=` decodable en nom de fichier ; 24 encarts, TOUS en « ebooks|<id>|1 ».
 */
export function estEncartWawacity(url: string): boolean {
  const v = valeurFn(url);
  return v !== undefined && v.includes('|');
}

/** Fiches listees par une page de recherche. Fonction pure : testee sans reseau. */
export function parseRechercheWawacity(html: string): { id: string; titre: string }[] {
  const propre = sansCommentaires(html);
  const out: { id: string; titre: string }[] = [];
  const vus = new Set<string>();

  const re = /<a\s+href="\?p=ebook&(?:amp;)?id=(\d+)-[^"]*"([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(propre)) !== null && out.length < MAX_FICHES) {
    const id = m[1];
    if (vus.has(id)) continue;
    const titre = texteNu(m[2]);
    if (!titre) continue;
    vus.add(id);
    out.push({ id, titre });
  }
  return out;
}

/** Liens d'une fiche. Fonction pure : testee sans reseau. */
export function parseFicheWawacity(html: string): LienDdl[] {
  const propre = sansCommentaires(html);
  const out: LienDdl[] = [];

  for (const bloc of propre.split(/<tr[^>]*class="link-row"[^>]*>/i).slice(1)) {
    const lien = bloc.match(/href="(https?:\/\/dl-protect[^"]+)"/i);
    if (!lien) continue;
    const url = decodeEntities(lien[1]);

    // Un encart reconnu a son `fn=` ne descend pas plus bas, meme s'il a echappe au
    // retrait des commentaires.
    if (estEncartWawacity(url)) continue;

    const cellules = bloc.split(/<\/td>/i).map(texteNu).filter(Boolean);
    // Forme relevee : libelle, hebergeur, taille. L'hebergeur est la 2e cellule.
    const hebergeur = cellules[1] ?? '';
    const taille = parseTailleFr(cellules[2] ?? '');
    if (!hebergeur || /^anonyme$/i.test(hebergeur)) continue;

    out.push({ hebergeur, taille, url, nomFichier: decoderNomFichier(url) });
  }
  return out;
}

/** Identite synthetique : jamais confondable avec un infohash de 40 hexadecimaux. */
export function identiteDdl(site: string, id: string): string {
  return `ddl:${site}:${id}`;
}

/** L'adresse de base, corrigeable a chaud. Le kiosque de presse en a besoin aussi. */
export function baseWawacity(): string {
  return endpoints.get().base.replace(/\/+$/, '');
}

export function urlFiche(id: string): string {
  return `${endpoints.get().base.replace(/\/+$/, '')}/?p=ebook&id=${encodeURIComponent(id)}`;
}

export async function ouvrirFicheWawacity(
  id: string,
  signal?: AbortSignal,
): Promise<LienDdl[] | null> {
  const html = await cached<string | null>(
    `wawacity:fiche:${id}`,
    TTL_MS,
    () => getText(urlFiche(id), { timeoutMs: 15000, signal, retries: 1, maxBytes: MAX_OCTETS }),
    { scope: 'wawacity', echec: (v) => v === null, shouldCache: (v) => v !== null },
  );
  return html === null ? null : parseFicheWawacity(html);
}

export function wawacitySource(): Source {
  return {
    id: 'wawacity',
    label: 'Wawacity',
    // Pas de cleRequise : le site est public. Ce sont les DEBRIDEURS qui demandent une
    // cle, et cela se joue plus tard, a l'ouverture.

    async search(q: Query, ctx: SearchContext): Promise<Candidate[]> {
      const terme = (q.titres[0] || '').trim();
      if (!terme) return [];

      const base = endpoints.get().base.replace(/\/+$/, '');
      const url = `${base}/?p=ebooks&search=${encodeURIComponent(terme)}`;

      const html = await cached<string | null>(
        `wawacity:recherche:${terme.toLowerCase()}`,
        TTL_MS,
        () => getText(url, { timeoutMs: 15000, signal: ctx.signal, retries: 1, maxBytes: MAX_OCTETS }),
        {
          scope: 'wawacity',
          echec: (v) => v === null,
          shouldCache: (v) => v !== null,
          negativeTtlMs: TTL_VIDE_MS,
        },
      );

      // Echec, pas resultat vide : voir la note dans torznab.ts.
      if (html === null) throw new Error("Wawacity n'a rendu aucune reponse exploitable");

      return parseRechercheWawacity(html).map(({ id, titre }) => {
        const { tomes, langue, format, provenance } = parseRelease(titre);
        return {
          source: 'wawacity',
          titre,
          // Pas de hash : c'est du lien direct. L'identite est synthetique.
          identite: identiteDdl('wawacity', id),
          tomes,
          langue,
          format,
          provenance,
        } as Candidate;
      });
    },
  };
}
