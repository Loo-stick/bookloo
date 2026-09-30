// downmagaz — presse et BD en PDF, lisibles en ligne par TorBox.
//
// CE QU'ELLE APPORTE, mesure du 2026-09-11 : 110 926 fiches, dont 102 360 de presse —
// Investir, Air Cosmos… — et 8 566 albums de BD. Construction : trois sitemaps, 5 s.
//
// ELLE PASSE PAR LE CIRCUIT DES LIENS DIRECTS, comme wawacity et bookys : sa fiche rend
// des hebergeurs, qu'un debrideur deverrouille. Et c'est la qu'il faut etre precis, parce
// que c'est tout ce qui fait sa valeur. Sur douze fiches mesurees, des plus recentes aux
// plus anciennes, TOUTES portent un lien `turbobita.net` — que TorBox declare parmi les
// domaines de Turbobit. Le second lien change avec l'age de la fiche (dwp.la, downup.me,
// uploadmall.com) et aucun des deux debrideurs ne le prend en charge. Chez AllDebrid,
// turbobit est desactive le 2026-09-11 et `turbobita.net` ne figure pas parmi ses
// domaines. Autrement dit : cette source se lit AVEC TORBOX, et seulement avec lui
// aujourd'hui. Le circuit le sait deja — il sonde les hebergeurs et nomme celui qui
// refuse — et il n'y a rien a lui apprendre ici.
//
// SA RECHERCHE EST FERMEE AUX AUTOMATES : on cherche dans l'index bati sur son sitemap.
// Voir `downmagaz-fiches.ts`.

import { httpGet } from '../../core/http';
import { tracerAppel, hoteDe } from '../../core/journal';
import { parseRelease } from '../torrent/release';
import type { Candidate, Query, SearchContext, Source } from '../types';
import { identiteDdl, type LienDdl } from './wawacity';
import { motsDemandes } from './1001ebooks-fiches';
import { creerIndexSitemap } from './index-sitemap';
import {
  BASE_DOWNMAGAZ, RAYONS_DOWNMAGAZ, famillesDeRubrique, fichesDeLaListe,
  fichesDuSitemapDownmagaz, idDuSlug, liensDeLaFiche, lireDescription, motsDuSlugDownmagaz,
  parcourirListes, rangDuSlug, titreDuSlugDownmagaz, urlFicheDownmagaz, urlPageListe,
  type FicheDownmagaz,
} from './downmagaz-fiches';

const MAX_RESULTATS = 40;

/**
 * Jusqu'ou lire les pages de liste en une construction.
 *
 * Le trou a combler, mesure le 2026-09-11, tient en ~395 pages : la 395e rejoint le
 * dernier numero du sitemap. 500 laisse de la marge sans ouvrir la porte a une lecture
 * des 3 759 pages du site si un jour l'index etait perdu — le sitemap couvre le reste.
 */
const MAX_PAGES = 500;

/** Deux pages de suite sans rien de nouveau, et on s'arrete. Voir `parcourirListes`. */
const PAGES_CONNUES_AVANT_ARRET = 2;

/** La forme que l'index attend. */
function versIndex(f: FicheDownmagaz) {
  return {
    categorie: f.rubrique,
    slug: f.slug,
    familles: famillesDeRubrique(f.rubrique),
    mots: motsDuSlugDownmagaz(f.slug),
    rang: rangDuSlug(f.slug),
  };
}
const UA = { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36' };

/** Les sitemaps de FICHES que le site annonce — `news_pages.xml`, et la suite s'il y en a. */
export function sitemapsDeFichesDownmagaz(index: string): string[] {
  const t = String(index || '');
  const out: string[] = [];
  let i = t.indexOf('<loc>');
  while (i >= 0) {
    const j = t.indexOf('</loc>', i);
    if (j < 0) break;
    const u = t.slice(i + 5, j).trim();
    // Les sitemaps de rubriques, d'etiquettes et de pages statiques ne portent aucune
    // fiche : 6 873 adresses d'etiquettes pour zero numero, mesure du 2026-09-11.
    if (u.startsWith(`${BASE_DOWNMAGAZ}/news_pages`) && u.endsWith('.xml')) out.push(u);
    i = t.indexOf('<loc>', j);
  }
  return out;
}

const index = creerIndexSitemap({
  nom: 'downmagaz',
  fichier: 'index-downmagaz.db',
  variable: 'INDEX_DOWNMAGAZ_DB_PATH',
  // Douze heures : le site publie plusieurs dizaines de numeros par jour.
  fraicheurMs: 12 * 60 * 60 * 1000,
  async lire(ecrire, signal, connait) {
    const debut = Date.now();
    const racine = await httpGet<string>(`${BASE_DOWNMAGAZ}/sitemap.xml`, {
      timeoutMs: 20000, signal, headers: UA, responseType: 'text',
    });
    if (!racine || racine.status < 200 || racine.status >= 300) return;
    for (const u of sitemapsDeFichesDownmagaz(String(racine.data || ''))) {
      // 8,4 MO MESURES pour le premier, au-dela du plafond par defaut de 8 Mo — c'est ce
      // plafond qui avait fait echouer la premiere sonde, et cache les deux autres
      // fichiers. Il protege le conteneur d'une reponse demesuree ; il est releve pour
      // ces seuls documents, avec de la marge, et reste borne.
      const r = await httpGet<string>(u, {
        timeoutMs: 60000, signal, headers: UA, responseType: 'text', maxBytes: 32 * 1024 * 1024,
      });
      tracerAppel({
        source: 'downmagaz',
        hote: hoteDe(BASE_DOWNMAGAZ),
        statut: r ? r.status : null,
        duree: Date.now() - debut,
        ok: Boolean(r && r.status >= 200 && r.status < 300),
      });
      if (!r || r.status < 200 || r.status >= 300) continue;
      const fiches = fichesDuSitemapDownmagaz(String(r.data || ''));
      // PAR LOTS : une transaction par lot garde l'ecriture rapide sans tenir quarante
      // mille insertions dans une seule.
      for (let k = 0; k < fiches.length; k += 2000) ecrire(fiches.slice(k, k + 2000).map(versIndex));
      await new Promise((z) => { setTimeout(z, 250); });
    }

    // PUIS LES PAGES DE LISTE, parce que le sitemap est fige depuis mi-novembre 2025 : sans
    // elles, les treize mille fiches suivantes — dont tous les numeros de presse recents —
    // n'existeraient pas pour la recherche. Voir `fichesDeLaListe`.
    //
    // La premiere construction en lit ~395 ; les suivantes s'arretent des qu'elles
    // retombent sur du connu, soit deux a quatre pages pour une demi-journee de parutions.
    const { pages, nouvelles } = await parcourirListes({
      maxPages: MAX_PAGES,
      arretApres: PAGES_CONNUES_AVANT_ARRET,
      connait,
      ecrire: (fiches) => ecrire(fiches.map(versIndex)),
      // Le site n'a rien demande : une page toutes les demi-secondes, pas davantage.
      pause: () => new Promise((z) => { setTimeout(z, 500); }),
      async lirePage(n) {
        const r = await httpGet<string>(urlPageListe(n), {
          timeoutMs: 20000, signal, headers: UA, responseType: 'text',
        });
        tracerAppel({
          source: 'downmagaz',
          hote: hoteDe(BASE_DOWNMAGAZ),
          statut: r ? r.status : null,
          duree: Date.now() - debut,
          ok: Boolean(r && r.status >= 200 && r.status < 300),
        });
        return r && r.status >= 200 && r.status < 300 ? String(r.data || '') : null;
      },
    });
    console.log(`[downmagaz] pages de liste : ${pages} lues, ${nouvelles} fiches absentes du sitemap`);
  },
});

export const tailleIndexDownmagaz = (): number => index.taille();
/** La reconstruction, attendable : pour l'exploitation, et pour la mesurer. */
export const construireIndexDownmagaz = (signal?: AbortSignal): Promise<number> => index.construire(signal);

/**
 * Ouvre une fiche par son numero, et rend ses hebergeurs.
 *
 * L'ADRESSE EST FABRIQUEE ICI, jamais recue : l'identite ne porte qu'un numero, verifie,
 * et l'hote est toujours celui du site. Rien de ce qu'un client envoie ne peut donc
 * diriger cette requete ailleurs.
 */
export async function ouvrirFicheDownmagaz(id: string, signal?: AbortSignal): Promise<LienDdl[] | null> {
  if (!/^\d{1,9}$/.test(String(id || ''))) return null;
  const debut = Date.now();
  const r = await httpGet<string>(urlFicheDownmagaz(id), {
    timeoutMs: 20000, signal, headers: UA, responseType: 'text',
  });
  tracerAppel({
    source: 'downmagaz',
    hote: hoteDe(BASE_DOWNMAGAZ),
    statut: r ? r.status : null,
    duree: Date.now() - debut,
    ok: Boolean(r && r.status >= 200 && r.status < 300),
  });
  if (!r || r.status < 200 || r.status >= 300) return null;
  const html = String(r.data || '');
  const d = lireDescription(html);
  // LE NOM DU FICHIER VIENT DE LA FICHE, avec l'extension qu'elle ANNONCE. C'est lui qui
  // devient l'identite du numero en bibliotheque — « Investir - 12 Septembre 2026 (No.
  // 2749).pdf » — et c'est ce qui permet a l'etagere d'en lire la date de parution.
  // Une barre oblique y couperait l'identite en deux : elle est remplacee.
  const nom = d.titre && d.format ? `${d.titre.replace(/[/\\]+/g, '-')}.${d.format}` : undefined;
  return liensDeLaFiche(html, nom, d.taille ?? undefined);
}

export function downmagazSource(): Source {
  return {
    id: 'downmagaz',
    label: 'downmagaz',

    async search(q: Query, ctx: SearchContext): Promise<Candidate[]> {
      const famille = ctx.famille?.id;
      if (!famille || !RAYONS_DOWNMAGAZ.includes(famille)) return [];
      const mots = motsDemandes(q.titres[0] || '');
      if (!mots.length) return [];

      // Echec, pas resultat vide : un index qui n'existe pas encore ne veut pas dire
      // « ce site ne connait pas cette oeuvre ». Meme regle que dans torznab.ts.
      if (!index.assurer()) {
        throw new Error('downmagaz : inventaire en cours de construction, reessayez dans une minute');
      }

      const out: Candidate[] = [];
      for (const f of index.chercher(famille, mots, MAX_RESULTATS)) {
        const id = idDuSlug(f.slug);
        if (!id) continue;
        const titre = titreDuSlugDownmagaz(f.slug);
        const { tomes, langue, provenance } = parseRelease(titre);
        out.push({
          source: 'downmagaz',
          titre,
          identite: identiteDdl('downmagaz', id),
          tomes,
          // LE SITE EST L'EDITION FRANCAISE — « French Magazines Community », et « Français »
          // dans la description des douze fiches mesurees. Le nom ne le dit presque jamais.
          langue: langue === 'inconnue' ? 'FR' : langue,
          // LE FORMAT EST CELUI QUE LE SITE DECLARE pour tout son catalogue — « Download PDF
          // magazines » — et que chacune des douze fiches mesurees confirme. La sonde relit
          // de toute facon les premiers octets avant de proposer « Lire ».
          format: 'pdf',
          provenance,
        });
      }
      return out;
    },
  };
}
