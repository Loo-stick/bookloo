// zone-ebook : le plus simple des trois sites du kiosque.
//
// Joignable EN DIRECT — mesure du 2026-08-31 : 772 ms, aucun defi Cloudflare — et ses
// fiches exposent les hebergeurs SANS passer par un redirecteur. C'est la difference avec
// Wawacity, dont les liens passent par dl-protect.

import { cached } from '../core/cache';
import { getText, postForm } from '../core/http';
import { tracerAppel, hoteDe } from '../core/journal';
import { decodeEntities } from '../core/xml';
import type { LienDdl } from '../sources/ddl/wawacity';
import { separerTitreDate } from './titre-date';
import { rubriqueDuChemin } from './rubrique';
import type { Kiosque, Numero, Rubrique } from './types';
import { cookiePour, sessionRefusee } from './zone-ebook-session';

const BASE = 'https://zone-ebook.com';
const TTL_MS = 30 * 60 * 1000;
const TTL_VIDE_MS = 10 * 60 * 1000;
const MAX_OCTETS = 4 * 1024 * 1024;
const MAX_NUMEROS = 60;
/**
 * Combien de pages on remonte par rubrique.
 *
 * Une page rend dix numeros — c'est peu pour un kiosque, ou l'on veut voir la semaine et
 * pas la matinee. Trois pages coutent moins de deux secondes ici, le site repondant en
 * 400 ms.
 */
const PAGES = 3;

/** Hotes qui ne sont jamais un hebergeur de fichier : mesure et bon sens. */
const BRUIT = /histats|google|facebook|twitter|gstatic|jquery|cloudflare|addthis|disqus/i;

const texteNu = (h: string) => decodeEntities(h.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

/**
 * Les numeros d'une page de rubrique.
 *
 * CHAQUE FICHE APPARAIT TROIS FOIS dans la page — le lien de titre, un « Telecharger », un
 * compteur — et toutes trois portent la meme adresse. Sans regroupement par identifiant, la
 * rubrique afficherait chaque journal en triple. On garde le texte le PLUS LONG : c'est le
 * titre, les deux autres etant un libelle de bouton et un nombre.
 */
export function parseListeZoneEbook(html: string, rubrique: Rubrique): Numero[] {
  const parId = new Map<string, string>();
  const motif = new RegExp(
    `<a[^>]+href="${BASE}/${rubrique}/(\\d+)-[^"]*"[^>]*>([\\s\\S]*?)</a>`,
    'g',
  );
  for (const m of html.matchAll(motif)) {
    const id = m[1];
    const texte = texteNu(m[2]);
    if (!texte) continue;
    const connu = parId.get(id);
    if (connu === undefined || texte.length > connu.length) parId.set(id, texte);
  }

  const out: Numero[] = [];
  for (const [id, brut] of parId) {
    const { titre, date } = separerTitreDate(brut);
    out.push({ site: 'zone-ebook', id, titre, rubrique, date, brut });
    if (out.length >= MAX_NUMEROS) break;
  }
  return out;
}

/**
 * Les liens d'une fiche.
 *
 * ON NE CHERCHE PAS A RECONNAITRE UN HEBERGEUR, et c'est deliberé : la liste de ce qui est
 * exploitable appartient au debrideur, pas a nous. `hotesSupportes` la donne, et
 * `hoteExploitable` s'en sert — un site partenaire qui traine dans la page sera simplement
 * ecarte la, sans qu'on ait a tenir une liste de plus qui vieillirait.
 */
export function parseFicheZoneEbook(html: string): LienDdl[] {
  const vus = new Set<string>();
  const out: LienDdl[] = [];
  for (const m of html.matchAll(/href="(https?:\/\/([^/"]+)[^"]*)"/gi)) {
    const url = decodeEntities(m[1]);
    const hote = m[2].toLowerCase().replace(/^www\./, '');
    if (hote.includes('zone-ebook') || BRUIT.test(hote)) continue;
    // UN HEBERGEUR POINTE UN FICHIER, UN PARTENAIRE POINTE SA RACINE.
    //
    // La fiche cite trois sortes de liens : les hebergeurs — qui portent tous le nom du
    // fichier dans leur chemin — le bloc « Partenaires » en pied de page, et une phrase
    // promotionnelle dans le corps meme. Les deux dernieres pointent une racine nue :
    // `https://livomag.com/`, `http://www.ebook-planete.org/`. Elles remontaient comme
    // des hebergeurs, et l'ecran annoncait « non pris en charge par alldebrid » sur des
    // sites qui n'hebergent rien. Signale a l'usage.
    //
    // LA REGLE EST STRUCTURELLE, PAS UNE LISTE DE NOMS : une liste de sites amis vieillit
    // au premier partenaire ajoute, un chemin vide reste un chemin vide.
    const chemin = url.replace(/^https?:\/\/[^/]*/i, '').replace(/^\/+/, '');
    if (!chemin) continue;
    // NI LA PAGE DE CELUI QUI A DEPOSE. Chaque hebergeur cite aussi le profil de
    // l'uploadeur — `dailyuploads.net/users/Mimino162` — sous le meme hote qu'un vrai
    // fichier : le nom d'hote ne suffit donc pas a les distinguer, le chemin si.
    if (/^(?:users?|profile|membres?)\//i.test(chemin)) continue;
    if (vus.has(url)) continue;
    vus.add(url);
    out.push({ hebergeur: hote, url });
  }
  return out;
}

/**
 * L'adresse d'une page de rubrique.
 *
 * MESURE DU 2026-09-01 : `/journaux/` rend dix numeros, `/journaux/page/2/` les dix
 * suivants. `/journaux/2/` ne rend RIEN — la forme du chemin compte, et une page vide
 * passerait pour une rubrique epuisee.
 */
/**
 * Les numeros d'une page de RECHERCHE, ou les deux rubriques se melangent.
 *
 * La rubrique se lit dans le chemin de chaque lien, et un resultat qui n'en porte aucune
 * — le site range aussi des romans — est ecarte.
 */
export function parseRechercheZoneEbook(html: string): Numero[] {
  const parId = new Map<string, { brut: string; rubrique: Rubrique }>();
  const motif = /<a[^>]+href="(https:\/\/zone-ebook\.com\/[a-z-]+\/(\d+)-[^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
  for (const m of html.matchAll(motif)) {
    const rubrique = rubriqueDuChemin(m[1]);
    if (!rubrique) continue;
    const texte = texteNu(m[3]);
    if (!texte) continue;
    const connu = parId.get(m[2]);
    if (connu === undefined || texte.length > connu.brut.length) parId.set(m[2], { brut: texte, rubrique });
  }
  const out: Numero[] = [];
  for (const [id, { brut, rubrique }] of parId) {
    const { titre, date } = separerTitreDate(brut);
    out.push({ site: 'zone-ebook', id, titre, rubrique, date, brut });
    if (out.length >= MAX_NUMEROS) break;
  }
  return out;
}

export function urlRubrique(rubrique: Rubrique, page = 1): string {
  return page <= 1 ? `${BASE}/${rubrique}/` : `${BASE}/${rubrique}/page/${page}/`;
}

async function page(url: string, cle: string, signal?: AbortSignal): Promise<string | null> {
  const debut = Date.now();
  return cached<string | null>(
    cle,
    TTL_MS,
    async () => {
      const h = await getText(url, { timeoutMs: 15000, signal, retries: 1, maxBytes: MAX_OCTETS });
      tracerAppel({
        source: 'zone-ebook',
        hote: hoteDe(url),
        statut: h === null ? null : 200,
        duree: Date.now() - debut,
        ok: h !== null,
      });
      return h;
    },
    {
      scope: 'presse:zone-ebook',
      echec: (v) => v === null,
      shouldCache: (v) => v !== null,
      negativeTtlMs: TTL_VIDE_MS,
    },
  );
}

export const zoneEbook: Kiosque = {
  id: 'zone-ebook',
  libelle: 'zone-ebook',
  async dernieres(rubrique, signal) {
    const out: Numero[] = [];
    const vus = new Set<string>();
    for (let n = 1; n <= PAGES; n += 1) {
      const html = await page(urlRubrique(rubrique, n), `presse:zone:${rubrique}:${n}`, signal);
      // `null` signale un ECHEC, jamais une rubrique vide : la distinction remonte jusqu'a
      // la pastille du site, ou « n'a pas repondu » et « rien de paru » ne disent pas la
      // meme chose. Meme regle que pour les catalogues.
      //
      // Sur les pages SUIVANTES en revanche, un echec n'annule pas ce qu'on a deja : mieux
      // vaut trente numeros que rien.
      if (html === null) {
        if (n === 1) throw new Error('zone-ebook n a pas repondu');
        break;
      }
      const lot = parseListeZoneEbook(html, rubrique).filter((x) => !vus.has(x.id));
      // Une page qui ne rend RIEN DE NEUF veut dire qu'on a atteint le bout : continuer
      // couterait des allers-retours pour rien.
      if (lot.length === 0) break;
      for (const x of lot) { vus.add(x.id); out.push(x); }
    }
    return out;
  },
  /**
   * ZONE-EBOOK NE CHERCHE QUE POUR SES MEMBRES.
   *
   * MESURE DU 2026-09-01, EN ANONYME, et elle etait exacte pour ce qu'elle mesurait. `?s=`
   * rend bien une page — 58 Ko, une quinzaine de fiches — ce qui m'avait suffi a la croire
   * bonne. Elle ne repondait pas : « Cahiers du Cinema » et « Le Parisien » rendaient
   * EXACTEMENT les memes quinze titres. Les formes DataLife Engine, en GET comme en POST,
   * rendaient deux fiches — l'encadre lateral, pas un resultat.
   *
   * MESURE DU 2026-09-02, CONNECTE, et elle renverse la conclusion sans annuler la mesure :
   * trois requetes rendent trois jeux DIFFERENTS et pertinents — dix Cahiers du Cinema
   * dates de septembre a avril, dix journaux pour « le parisien », dix Spirou. Ce que
   * j'avais lu « ce site ne sait pas chercher » etait « ce site ne cherche pas pour les
   * visiteurs ». La piste venait de Loo, pas de moi.
   *
   * MESURER QU'UNE REPONSE ARRIVE N'EST PAS MESURER QU'ELLE REPOND, et le critere n'a pas
   * change d'un jour a l'autre : deux questions differentes doivent rendre des reponses
   * differentes. C'est ce que `zone-ebook-session.test.ts` verifie, et rien d'autre.
   *
   * `chercheable` RESTE VRAI MEME SANS COMPTE RENSEIGNE : le site SAIT chercher. Le dire
   * faux afficherait « ne sait pas chercher » a qui n'a qu'un mot de passe a saisir.
   */
  chercheable: true,
  async chercher(terme, ctx, signal) {
    // SANS CONTEXTE NI COMPTE, UNE LISTE VIDE. Elle se lit « rien ne correspond » ; rendre
    // les derniers parus se lirait « voici tes resultats », ce qui serait pire.
    if (!ctx) return [];
    const cookie = await cookiePour(ctx.userId, ctx.cles, signal);
    if (!cookie) return [];

    const corps = await postForm(
      `${BASE}/index.php?do=search`,
      {
        do: 'search',
        subaction: 'search',
        search_start: '0',
        full_search: '0',
        result_from: '1',
        story: terme,
      },
      {
        timeoutMs: 20000,
        signal,
        maxBytes: MAX_OCTETS,
        headers: { Cookie: cookie, Referer: `${BASE}/` },
      },
    );
    if (corps === null) return [];

    const numeros = parseRechercheZoneEbook(corps);
    // AUCUNE FICHE = SESSION TOMBEE, jusqu'a preuve du contraire. Une page de visiteur n'en
    // porte aucune ; la prendre pour « aucun resultat » laisserait la session morte en
    // memoire, et toutes les recherches suivantes rendraient vide sans jamais reessayer.
    if (numeros.length === 0) sessionRefusee(ctx.userId);
    return numeros;
  },
};

/** La fiche d'un numero, pour le parcours debrideur. */
export async function ouvrirFicheZoneEbook(
  id: string,
  signal?: AbortSignal,
): Promise<LienDdl[] | null> {
  if (!/^\d+$/.test(id)) return null;
  // Le slug ne compte pas : le site sert la fiche sur le seul identifiant.
  const html = await page(`${BASE}/journaux/${id}-x.html`, `presse:zone:fiche:${id}`, signal);
  return html === null ? null : parseFicheZoneEbook(html);
}
