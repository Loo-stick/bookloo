// La BnF comme catalogue de PRESSE.
//
// POURQUOI ELLE, ET POURQUOI SEULEMENT POUR LA PRESSE. Aucun des quatre autres catalogues
// ne repertorie un periodique : MangaDex, ComicVine, Booknode et Open Library decrivent
// des oeuvres avec des tomes, or un numero de journal est un titre et une date. La famille
// Presse etait donc la seule en `catalogues: []`, c'est-a-dire en recherche libre, sans
// identite stable pour « Le Monde » autre que la chaine de caracteres du site qui l'a
// publie — avec ses graphies incoherentes.
//
// CE QUE LA BnF DONNE, ET CE QU'ELLE NE DONNE PAS. Elle decrit le PERIODIQUE, jamais sa
// parution : la notice des Cahiers du cinema porte « 20.. » pour toute la serie, et il
// n'existe pas de notice « septembre 2026 ». Elle apporte donc une IDENTITE et un titre
// canonique ; les numeros continuent de venir des sources.
//
// MESURES DU 2026-09-01, sur l'API SRU du catalogue general :
//
//   bib.anywhere all "Cahiers du cinema"                        1551 notices
//   bib.serialtitle all "Cahiers du cinema"                       36 notices
//   bib.serialtitle all "Le Monde"                              4326 notices, surtout des livres
//   bib.serialtitle all "Le Monde"    and bib.doctype any "s"    364 notices, des periodiques
//   bib.serialtitle all "Cahiers..."  and bib.doctype any "s"      1 notice, en 518 ms
//
// LE FILTRE `doctype any "s"` EST CE QUI REND CE CATALOGUE UTILISABLE. Sans lui, un titre
// commun noie la presse sous les livres qui contiennent les memes mots. `bib.recordtype`
// a ete essaye aussi : il rend zero.
//
// Ni `adj` ni `=` ne font une correspondance de phrase — 3093 et 4326 notices sur « Le
// Monde » — l'index cherche les mots separement quel que soit l'operateur. C'est le
// rapprochement, en aval, qui classe.

import { cached } from '../core/cache';
import { getText } from '../core/http';
import { tracerAppel, hoteDe } from '../core/journal';
import { decodeEntities } from '../core/xml';
import type { ModeRecherche, Oeuvre } from './types';

const BASE = 'http://catalogue.bnf.fr/api/SRU';
/**
 * UNE HEURE, ET C'EST DELIBERE. L'API limite le debit : trois appels rapproches ont ete
 * refuses le 2026-09-01. Un catalogue de periodiques ne bouge de toute facon pas d'une
 * heure a l'autre.
 */
const TTL_MS = 60 * 60 * 1000;
const MAX_OCTETS = 2 * 1024 * 1024;
const MAX_RESULTATS = 30;

/**
 * LE NIVEAU BIBLIOGRAPHIQUE, en position 7 du label UNIMARC. `s` = periodique, `m` =
 * monographie. C'est le code que la notice porte elle-meme, et il ne se devine pas.
 *
 * ON FILTRE ICI ET NON DANS LA REQUETE, et c'est une correction. J'avais cru que
 * `bib.doctype any "s"` isolait les periodiques : il rend en realite les RESSOURCES
 * ELECTRONIQUES. La preuve etait sous les yeux — les resultats s'appelaient « Le Monde
 * (En ligne) », « Cahiers du cinema (Site web) » — et j'ai lu ces qualificatifs comme du
 * bruit a nettoyer au lieu d'y voir ce que je venais de selectionner. Sur « Spirou », le
 * meme filtre rendait des jeux SNES, et « Le Journal de Spirou » restait introuvable
 * alors qu'il est parfaitement catalogue : label « cas », donc niveau `s`.
 *
 * Le vocabulaire des index BnF ne se devine pas ; le code UNIMARC, lui, est normalise.
 */
const NIVEAU_PERIODIQUE = 's';

function url(q: string): string {
  // UNIMARC ET NON DUBLIN CORE : lui seul porte le label, donc le niveau bibliographique.
  // Il range aussi la mention de responsabilite dans un sous-champ a part — `200$f` — la
  // ou le Dublin Core la colle au titre derriere un « / ».
  return `${BASE}?version=1.2&operation=searchRetrieve&recordSchema=unimarcxchange`
    + `&maximumRecords=${MAX_RESULTATS}&query=${encodeURIComponent(q)}`;
}

/**
 * Le titre sans son qualificatif de catalogue.
 *
 * La BnF distingue les supports d'un meme periodique par une parenthese : « Le Monde
 * (En ligne) », « Cahiers du cinema (Site web) », « Le Monde (Paris. 1944) ». Envoyer cette
 * forme a un tracker ne rendrait rien — c'est une precision de bibliothecaire, pas un titre
 * de release.
 *
 * Le titre COMPLET reste affiche : c'est lui qui distingue deux notices homonymes.
 */
export function titrePourRecherche(brut: string): string {
  return String(brut || '')
    // LA MENTION DE RESPONSABILITE N'EST PAS LE TITRE. La norme de catalogage la separe
    // par « / », puis « ; » entre les roles : directeur de publication, redacteur en chef.
    // Elle peut faire trois fois la longueur du titre — mesure du 2026-09-01 sur « Le
    // Monde.fr », dont la notice porte deux noms et deux fonctions. Envoyee a un tracker,
    // elle ne rend jamais rien.
    .split(/\s+[/;]\s+/)[0]
    // Le qualificatif de support, entre parentheses en fin de titre.
    .replace(/\s*\([^)]*\)\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** L'annee de debut, quand la notice en donne une lisible. « 20.. » n'en est pas une. */
function anneeDe(date: string | undefined): number | undefined {
  const m = /\b(1[5-9]\d\d|20\d\d)\b/.exec(String(date || ''));
  return m ? Number(m[1]) : undefined;
}

/**
 * Les periodiques d'une reponse SRU.
 *
 * L'identite est le dernier segment de l'ARK — « cb47527271g » — qui est stable et court.
 * Une notice sans ARK est ecartee : sans identite, elle ne pourrait pas etre rouverte.
 */
export function parseBnf(xml: string): Oeuvre[] {
  const out: Oeuvre[] = [];
  const vus = new Set<string>();
  for (const bloc of String(xml || '').split('<mxc:record').slice(1)) {
    const label = /<mxc:leader>([^<]*)</.exec(bloc)?.[1] ?? '';
    // UN NIVEAU AUTRE QUE `s` N'EST PAS UN PERIODIQUE : « Album Spirou » est une
    // monographie (`m`), « Le Journal de Spirou » un periodique (`s`).
    if (label[7] !== NIVEAU_PERIODIQUE) continue;

    const ark = /ark:\/\d+\/(\w+)/.exec(bloc)?.[1];
    if (!ark || vus.has(ark)) continue;
    const titre = sousChamp(bloc, '200', 'a');
    if (!titre) continue;
    vus.add(ark);

    const pourRecherche = titrePourRecherche(titre);
    out.push({
      id: ark,
      titre,
      titres: [...new Set([titre, pourRecherche])],
      formes: [pourRecherche],
      // `214` a remplace `210` dans les notices recentes : les deux cohabitent.
      auteur: sousChamp(bloc, '210', 'c') ?? sousChamp(bloc, '214', 'c'),
      annee: anneeDe(sousChamp(bloc, '210', 'd') ?? sousChamp(bloc, '214', 'd')),
    });
  }
  return out;
}

/** Un sous-champ UNIMARC, ou `undefined`. */
function sousChamp(bloc: string, tag: string, code: string): string | undefined {
  const champ = new RegExp(
    `<mxc:datafield[^>]*tag="${tag}"[^>]*>([\\s\\S]*?)</mxc:datafield>`,
  ).exec(bloc);
  if (!champ) return undefined;
  const valeur = new RegExp(`<mxc:subfield[^>]*code="${code}"[^>]*>([^<]*)<`).exec(champ[1]);
  const t = valeur ? decodeEntities(valeur[1]).trim() : '';
  return t || undefined;
}

async function interroger(q: string, signal?: AbortSignal): Promise<string> {
  const debut = Date.now();
  const xml = await cached<string | null>(
    `bnf:${q}`,
    TTL_MS,
    async () => {
      const h = await getText(url(q), { timeoutMs: 15000, signal, retries: 1, maxBytes: MAX_OCTETS });
      tracerAppel({
        source: 'bnf',
        hote: hoteDe(BASE),
        statut: h === null ? null : 200,
        duree: Date.now() - debut,
        ok: h !== null,
      });
      return h;
    },
    { scope: 'bnf', echec: (v) => v === null, shouldCache: (v) => v !== null },
  );
  // `null` signale un ECHEC, jamais un resultat vide : c'est le contrat commun aux
  // catalogues, et il remonte jusqu'a la pastille de l'interface.
  if (xml === null) throw new Error('la BnF n a pas repondu');
  // L'API repond 200 avec un diagnostic quand la requete lui deplait — une limitation de
  // debit, par exemple. Le prendre pour une reponse vide ferait dire « aucun periodique de
  // ce nom » alors qu'on vient d'etre econduit.
  if (/<diag:/.test(xml)) throw new Error('la BnF a refuse la requete');
  return xml;
}

export async function chercherBnf(
  q: string,
  mode: ModeRecherche = 'titre',
  signal?: AbortSignal,
): Promise<Oeuvre[]> {
  const terme = q.trim().replace(/"/g, '');
  if (!terme) return [];
  const index = mode === 'auteur' ? 'bib.author' : 'bib.serialtitle';
  const requete = `${index} all "${terme}"`;
  return parseBnf(await interroger(requete, signal));
}

/**
 * L'autorite de nommage des ARK de la BnF. Constante, et c'est ce qui permet de ne garder
 * que le segment final comme identite — court, sans deux-points ni barres obliques, donc
 * transportable dans une identite `bnf:<id>` et dans une URL.
 */
const ARK_BNF = 'ark:/12148/';

/**
 * La notice d'un periodique.
 *
 * ON INTERROGE `persistentid`, PAS `recordid`. Les deux index existent, et ils n'attendent
 * pas le meme identifiant — mesure du 2026-09-01 :
 *
 *     bib.recordid any "cb47527271g"                 0 notice
 *     bib.persistentid any "ark:/12148/cb47527271g"  1 notice, la bonne
 *
 * `recordid` veut le numero interne du catalogue, pas l'ARK. La confusion rendait
 * « oeuvre introuvable » sur une fiche pourtant trouvee une seconde plus tot par la
 * recherche — signale a l'usage, et invisible autrement : les deux requetes repondent 200.
 */
export async function ficheBnf(id: string, signal?: AbortSignal): Promise<Oeuvre | null> {
  if (!/^\w+$/.test(id)) return null;
  const xml = await interroger(`bib.persistentid any "${ARK_BNF}${id}"`, signal);
  return parseBnf(xml)[0] ?? null;
}
