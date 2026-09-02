// Resolution d'un lien direct : protecteur, puis deblocage.
//
// LA REGLE DE SECURITE DE CE FICHIER, mesuree le 2026-08-20 et payee d'une rotation de
// cle : AllDebrid repond `301` sur `/link/redirector` et RECOPIE LA CLE API EN CLAIR
// dans son en-tete `Location`, en parametre d'URL — alors qu'elle n'avait ete envoyee
// que dans `Authorization`. Tout client qui suit cette redirection fait voyager la cle
// dans une URL, ou elle atterrit dans les journaux d'acces et les en-tetes `Referer`.
//
// ON N'A DONC JAMAIS LE DROIT DE SUIVRE CETTE REDIRECTION. On appelle directement le
// point d'arrivee, cle en en-tete uniquement.
//
// Seconde lecon, reprise de Dramallyu : `REDIRECTOR_ERROR` est TRANSITOIRE. Abandonner
// au premier echec fait conclure que dl-protect est infranchissable, alors qu'il ne
// cede que par intermittence — la meme requete rejouee aboutit.

import axios from 'axios';
import { estLienBookys, resoudreLienBookys } from '../sources/ddl/bookys';
import { tracer } from '../core/journal';
import { marquerRefus } from './refus-debrideur';
import type { NomService } from './index';

const AGENT = 'mangaloo';
const REDIRECTEURS = ['dl-protect', 'zoneurs', 'protect-link', 'dlprotect', 'rapidsafe'];

const TENTATIVES = 4;
const ATTENTE_MS = 3000;

/**
 * Erreurs qui meritent une nouvelle tentative.
 *
 * `LINK_DOWN` n'y figure pas, volontairement : le fichier n'est plus chez l'hebergeur,
 * et rejouer ne le ressuscitera pas.
 */
const TRANSITOIRES = new Set([
  'REDIRECTOR_ERROR',
  'LINK_HOST_UNAVAILABLE',
  'LINK_TEMPORARY_UNAVAILABLE',
  'LINK_TOO_MANY_DOWNLOADS',
  'LINK_HOST_FULL',
  'LINK_HOST_LIMIT_REACHED',
]);

/**
 * Cette adresse mene-t-elle a un redirecteur ?
 *
 * ON REGARDE L'HOTE, PAS L'URL ENTIERE. Un `includes` sur toute l'adresse prenait un lien
 * dont le CHEMIN contient « dl-protect » — « /guide/dl-protect-explique.html » — pour un
 * redirecteur, et laissait passer un vrai redirecteur cache dans un parametre. Signale par
 * une revue de code le 2026-08-29.
 *
 * Le nom compte comme etiquette de domaine, ou comme suffixe precede d'un point : « go »
 * puis « dlprotect.link » est le meme service, « dlprotect-parodie.example.com » ne l'est
 * pas.
 */
export function estRedirecteur(url: string): boolean {
  let hote: string;
  try {
    hote = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  // Deux tests, et deux seulement. Le nom est une ETIQUETTE entiere — « dl-protect » dans
  // « dl-protect.link » — ou un SUFFIXE precede d'un point, pour le jour ou la liste
  // porterait un domaine complet. Il y en avait deux autres : `hote === r`, que le premier
  // couvre deja puisqu'un hote sans point est une etiquette unique, et une comparaison
  // `e.startsWith(`${r}.`)` qui ne pouvait JAMAIS etre vraie — une etiquette ne contient
  // pas de point, c'est ce qui la definit. Un test mort donne l'illusion d'un cas couvert.
  const etiquettes = hote.split('.');
  return REDIRECTEURS.some((r) => etiquettes.includes(r) || hote.endsWith(`.${r}`));
}

export function estTransitoire(code: string | undefined): boolean {
  return code !== undefined && TRANSITOIRES.has(code);
}

/**
 * Point d'arrivee du protecteur, appele DIRECTEMENT.
 *
 * Aucun parametre dans l'URL : ni la cle, ni le lien. Tout passe en en-tete et en corps.
 */
export function urlRedirector(): string {
  return `https://apislow.alldebrid.com/v4/link/redirector?agent=${AGENT}`;
}

interface ReponseAd<T> {
  status?: string;
  data?: T;
  error?: { code?: string };
}

async function poste<T>(
  url: string,
  cle: string,
  lien: string,
  signal?: AbortSignal,
): Promise<{ data: T | null; code?: string }> {
  try {
    const corps = new URLSearchParams({ link: lien });
    const res = await axios.post<ReponseAd<T>>(url, corps.toString(), {
      headers: {
        Authorization: `Bearer ${cle}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      timeout: 30000,
      // JAMAIS de redirection suivie : voir l'en-tete de ce fichier.
      maxRedirects: 0,
      validateStatus: () => true,
      signal,
    });
    const body = res.data;
    if (!body || body.status === 'error') return { data: null, code: body?.error?.code };
    return { data: (body.data ?? null) as T | null };
  } catch (e) {
    tracer('DDL', (e as Error).message);
    return { data: null, code: 'RESEAU' };
  }
}

function attendre(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Rend un lien telechargeable, ou `null`.
 *
 * Un `LINK_DOWN` est memorise : le site continuera d'afficher ce lien pendant des
 * semaines, et rien ne sert de repayer l'aller-retour a chaque ouverture.
 */
export async function resoudreDdl(
  url: string,
  service: NomService,
  cle: string,
  signal?: AbortSignal,
): Promise<string | null> {
  // UNE CLE NE PART QU'AU SERVICE QUI L'A EMISE.
  //
  // Cette fonction n'appelle QUE l'API AllDebrid — le redirecteur comme le deblocage —
  // et `poste` y met la cle en `Authorization: Bearer`. Appelee avec `'torbox'`, elle
  // envoyait donc la cle TorBox de l'utilisateur a AllDebrid. Un secret confie a un tiers
  // qui n'a rien demande, et que rien ne pouvait rattraper ensuite.
  //
  // Le chemin DDL de TorBox n'a jamais ete ecrit : la garde le DIT en refusant, au lieu
  // de le simuler avec la mauvaise cle. Un refus se voit et se corrige ; une fuite, non.
  if (service !== 'alldebrid') return null;

  // TorBox ne franchit pas dl-protect : le dire tout de suite vaut mieux qu'un echec
  // obscur apres trente secondes. Conserve pour memoire — la garde ci-dessus le couvre.
  if (estRedirecteur(url) && service !== 'alldebrid') return null;

  let cible = url;

  // BOOKYS PASSE PAR SON PROPRE REDIRECTEUR. Ses fiches ne donnent pas l'adresse de
  // l'hebergeur mais une adresse a lui — « <fiche>/dl/<id> » — dont la page porte la
  // vraie. Un debrideur ne saurait rien faire de la premiere.
  //
  // Ce saut coute un passage par flaresolverr, et il n'est paye QU'ICI : au moment ou
  // l'utilisateur demande reellement ce fichier, jamais a l'affichage d'une liste.
  if (estLienBookys(cible)) {
    const vraie = await resoudreLienBookys(cible, signal);
    if (!vraie) return null;
    cible = vraie;
  }

  if (estRedirecteur(url)) {
    let obtenu: string | null = null;
    for (let essai = 0; essai < TENTATIVES; essai++) {
      if (signal?.aborted) return null;
      const r = await poste<{ links?: string[] }>(urlRedirector(), cle, url, signal);
      const premier = r.data?.links?.find((l) => typeof l === 'string' && /^https?:\/\//.test(l));
      if (premier) { obtenu = premier; break; }
      if (!estTransitoire(r.code)) break;
      await attendre(ATTENTE_MS);
    }
    if (!obtenu) return null;
    cible = obtenu;
  }

  const deblocage = await poste<{ link?: string }>(
    `https://api.alldebrid.com/v4/link/unlock?agent=${AGENT}`,
    cle,
    cible,
    signal,
  );
  if (deblocage.data?.link) return deblocage.data.link;

  if (deblocage.code === 'LINK_DOWN') {
    // CE QU'ALLDEBRID DIT, ET RIEN DE PLUS : il n'a pas su ouvrir ce lien. Il peut etre
    // mort, mais il peut aussi etre vivant et hors de sa portee — mesure du 2026-09-02
    // sur un fichier dailyuploads qui s'ouvrait au navigateur. On memorise donc SON
    // refus, pour six heures, et pas la mort du fichier pour une semaine.
    tracer('DDL', `${service} n a pas su ouvrir ce lien, refus memorise`);
    marquerRefus(service, url);
  }
  return null;
}
