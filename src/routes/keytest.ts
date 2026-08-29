// Test de validite des cles.
//
// Repris de Dramallyu (`src/routes/keytest.ts`), avec ses lecons — chacune payee par un
// faux verdict qui envoyait chercher le probleme du mauvais cote :
//
//   - `t=caps` N'AUTHENTIFIE PAS. C411 repond 200 avec un <caps> complet sur une cle
//     inventee. Le tester donnait « cle acceptee » a n'importe qui : la personne croyait
//     sa source active et ne comprenait jamais pourquoi elle ne remontait rien.
//   - UN 200 NE SUFFIT PAS sur UNIT3D. Un compte banni sur Gemini recoit `200 OK`
//     accompagne de `{"message":"Ce compte est banni !"}`.
//   - TORBOX REFUSE AVEC UN CORPS. Traiter tout non-2xx comme une panne dirait
//     « injoignable » a quelqu'un dont la cle est simplement fausse.
//   - JAMAIS LE MESSAGE D'EXCEPTION BRUT dans la reponse : il peut contenir l'URL
//     complete, donc la cle.
//
// ECART ASSUME PAR RAPPORT A DRAMALLYU : la-bas la cle voyage en parametre d'URL, faute
// d'etre stockee. Ici elle est deja en base, chiffree — le test la lit avec la DEK de la
// session, et aucune cle ne transite par le navigateur ni par un journal d'acces.

import { getJson, httpGet } from '../core/http';
import { getSettings } from '../core/settings';
import { tracer } from '../core/journal';
import type { NomCleStockee } from '../db/schema';
import { parseConfigRustatio } from '../rustatio/config';
import { ErreurZlibrary, connecter, domaine } from '../sources/zlibrary/api';
import { verdictRustatio } from '../rustatio/verdict';

export interface Verdict {
  ok: boolean;
  /** Message court, affiche tel quel. */
  message: string;
  /** Detail utile quand ca marche : pseudo, echeance de l'abonnement. */
  detail?: string;
}

const TIMEOUT = 12000;

/**
 * Analyse une reponse Torznab. Fonction pure, testee sur des corps captures.
 *
 * La description portee par `<error>` est RELAYEE telle quelle : « quota depasse » et
 * « cle expiree » demandent deux gestes differents, et un « cle refusee » uniforme les
 * confondrait.
 */
export function verdictTorznab(statut: number | null, corps: string): Verdict {
  if (statut === null) return { ok: false, message: 'Indexeur injoignable. Il est peut-etre hors ligne.' };

  const description = corps.match(/<error[^>]*description="([^"]*)"/i);
  if (description) return { ok: false, message: `Indexeur : ${description[1]}` };

  // YggReborn ne rend pas de XML d'erreur : il repond « invalid api key » en texte nu.
  if (/^\s*invalid api key/i.test(corps)) return { ok: false, message: 'Cle refusee par l indexeur.' };

  if (statut === 401 || statut === 403) return { ok: false, message: 'Cle refusee par l indexeur.' };
  if (statut === 429) return { ok: false, message: 'Trop de requetes. Reessayez dans une minute.' };
  if (statut < 200 || statut >= 300) return { ok: false, message: `L indexeur a repondu ${statut}.` };
  if (!corps.includes('<rss') && !corps.includes('<channel')) {
    return { ok: false, message: 'Reponse inattendue : ce n est pas un Torznab.' };
  }
  return { ok: true, message: 'Indexeur joignable et cle acceptee.' };
}

/** Analyse une reponse UNIT3D. Fonction pure. */
export function verdictUnit3d(statut: number | null, corps: unknown): Verdict {
  if (statut === null) return { ok: false, message: 'Tracker injoignable. Il est peut-etre hors ligne.' };
  if (statut === 401 || statut === 403) return { ok: false, message: 'Cle refusee par le tracker.' };
  if (statut === 429) return { ok: false, message: 'Trop de requetes. Reessayez dans une minute.' };
  if (statut < 200 || statut >= 300) return { ok: false, message: `Le tracker a repondu ${statut}.` };

  if (Array.isArray(corps)) return { ok: true, message: 'Cle acceptee.' };
  if (corps && typeof corps === 'object') {
    const o = corps as { data?: unknown; message?: string };
    // Le tracker explique lui-meme le refus : on le relaie. Un compte banni recoit
    // 200 OK, et se fier au seul statut donnerait « cle acceptee » a un compte ferme.
    if (typeof o.message === 'string' && !Array.isArray(o.data)) {
      return { ok: false, message: `Tracker : ${o.message}` };
    }
    if (Array.isArray(o.data)) return { ok: true, message: 'Cle acceptee.' };
  }
  return { ok: false, message: 'Reponse inattendue : la cle est probablement invalide.' };
}

interface UtilisateurAd {
  status?: string;
  data?: { user?: { username?: string; isPremium?: boolean; premiumUntil?: number } };
  error?: { code?: string };
}

/** Analyse une reponse AllDebrid. Fonction pure. */
export function verdictAllDebrid(data: UtilisateurAd | null): Verdict {
  if (!data) return { ok: false, message: 'AllDebrid injoignable. Reessayez dans un instant.' };
  if (data.error || !data.data?.user) return { ok: false, message: 'Cle refusee par AllDebrid.' };

  const u = data.data.user;
  if (!u.isPremium) {
    // Techniquement valide, mais inutilisable. Mieux vaut le dire maintenant que le
    // laisser decouvrir au premier telechargement.
    return {
      ok: false,
      message: 'Cle valide, mais le compte n est pas premium.',
      detail: 'Le debridage exige un abonnement actif.',
    };
  }
  const fin = u.premiumUntil ? new Date(u.premiumUntil * 1000).toLocaleDateString('fr-FR') : null;
  return {
    ok: true,
    message: `Compte AllDebrid valide${u.username ? ` (${u.username})` : ''}.`,
    detail: fin ? `Premium jusqu au ${fin}.` : undefined,
  };
}

interface UtilisateurTb {
  success?: boolean;
  data?: { email?: string; plan?: number; premium_expires_at?: string };
}

/** Analyse une reponse TorBox. Fonction pure. */
export function verdictTorbox(statut: number | null, data: UtilisateurTb | null): Verdict {
  if (statut === null) return { ok: false, message: 'TorBox injoignable. Reessayez dans un instant.' };
  if (statut === 401 || statut === 403) return { ok: false, message: 'Cle refusee par TorBox.' };
  if (statut < 200 || statut >= 300) return { ok: false, message: `TorBox a repondu ${statut}.` };
  if (!data?.success || !data.data) return { ok: false, message: 'Cle refusee par TorBox.' };

  const plan = data.data.plan ?? 0;
  if (plan === 0) {
    return {
      ok: false,
      message: 'Cle valide, mais le compte est en offre gratuite.',
      detail: 'Le debridage de torrents exige un plan payant.',
    };
  }
  const fin = data.data.premium_expires_at
    ? new Date(data.data.premium_expires_at).toLocaleDateString('fr-FR')
    : null;
  return {
    ok: true,
    message: `Compte TorBox valide${data.data.email ? ` (${data.data.email})` : ''}.`,
    detail: fin ? `Abonnement jusqu au ${fin}.` : undefined,
  };
}

async function testerTorznab(indexeur: string, cle: string): Promise<Verdict> {
  const conf = getSettings().torznab[indexeur];
  if (!conf) return { ok: false, message: `Indexeur « ${indexeur} » inconnu.` };
  if (!conf.enabled) return { ok: false, message: `Indexeur « ${indexeur} » desactive par l operateur.` };

  // `t=search`, PAS `t=caps` : seul le premier authentifie.
  const url =
    `${conf.url.replace(/\/+$/, '')}?t=search&q=test&limit=1&apikey=${encodeURIComponent(cle)}`;
  const res = await httpGet<string>(url, { timeoutMs: TIMEOUT, retries: 0, responseType: 'text' });
  return verdictTorznab(res?.status ?? null, String(res?.data ?? ''));
}

async function testerUnit3d(id: string, cle: string): Promise<Verdict> {
  const conf = getSettings().unit3d[id];
  if (!conf) return { ok: false, message: `Tracker « ${id} » inconnu.` };
  if (!conf.enabled) return { ok: false, message: `Tracker « ${id} » desactive par l operateur.` };

  // Meme mecanisme d'authentification que la source elle-meme : le test doit prouver
  // ce qui se passera vraiment, pas ce qui pourrait marcher autrement.
  const url =
    `${conf.url.replace(/\/+$/, '')}/api/torrents/filter` +
    `?api_token=${encodeURIComponent(cle)}&perPage=1`;
  const res = await httpGet<unknown>(url, {
    timeoutMs: TIMEOUT,
    retries: 0,
    headers: { Accept: 'application/json' },
  });
  return verdictUnit3d(res?.status ?? null, res?.data);
}

async function testerAllDebrid(cle: string): Promise<Verdict> {
  // `/user` est une CONSULTATION : contrairement a la verification de cache, tester la
  // cle ne depose rien sur le compte.
  const data = await getJson<UtilisateurAd>('https://api.alldebrid.com/v4.1/user?agent=mangaloo', {
    headers: { Authorization: `Bearer ${cle}` },
    timeoutMs: TIMEOUT,
    retries: 0,
  });
  return verdictAllDebrid(data);
}

async function testerTorbox(cle: string): Promise<Verdict> {
  // httpGet et non getJson : TorBox refuse avec un corps explicite. Traiter tout
  // non-2xx comme une panne dirait « injoignable » a quelqu'un dont la cle est fausse.
  const res = await httpGet<UtilisateurTb>('https://api.torbox.app/v1/api/user/me?settings=false', {
    headers: { Authorization: `Bearer ${cle}` },
    timeoutMs: TIMEOUT,
    retries: 0,
  });
  return verdictTorbox(res?.status ?? null, res?.data ?? null);
}

async function testerRustatio(cle: string): Promise<Verdict> {
  const cfg = parseConfigRustatio(cle);
  if (!cfg) return { ok: false, message: 'Configuration Rustatio invalide (URL manquante ou incorrecte).' };
  const res = await httpGet<{ data?: unknown }>(`${cfg.url}/api/instances`, {
    headers: cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {},
    timeoutMs: TIMEOUT,
    retries: 0,
  });
  return verdictRustatio(res?.status ?? null, res?.data ?? null);
}

/**
 * Z-Library : le seul service qui se teste avec un COUPLE.
 *
 * Le test est une vraie connexion — c'est la seule facon de savoir. Un `/eapi/book/search`
 * repondrait 200 en anonyme et ne dirait donc rien des identifiants, exactement comme
 * `t=caps` sur C411.
 */
async function testerZlibrary(email: string, motdepasse: string): Promise<Verdict> {
  try {
    const s = await connecter(email, motdepasse);
    return { ok: true, message: 'Identifiants acceptes.', detail: `compte ${s.id} sur ${domaine()}` };
  } catch (e) {
    // Ce message-la est deja formule pour l'utilisateur, et ne porte ni adresse ni mot
    // de passe : c'est le seul cas ou on relaie le texte d'une exception.
    if (e instanceof ErreurZlibrary) return { ok: false, message: e.message };
    throw e;
  }
}

export async function tester(
  service: NomCleStockee, cle: string, secondaire?: string,
): Promise<Verdict> {
  // Z-Library d'abord : l'adresse seule n'est pas une cle, et la tester isolement n'a
  // pas de sens.
  if (service === 'zlib_email' || service === 'zlib_mdp') {
    const email = service === 'zlib_email' ? cle : secondaire ?? '';
    const mdp = service === 'zlib_mdp' ? cle : secondaire ?? '';
    if (!email || !mdp) {
      return { ok: false, message: 'Adresse et mot de passe sont requis tous les deux.' };
    }
    return testerZlibrary(email, mdp);
  }

  if (!cle) return { ok: false, message: 'Aucune cle enregistree.' };
  try {
    switch (service) {
      case 'ad': return await testerAllDebrid(cle);
      case 'tb': return await testerTorbox(cle);
      case 'ygg': return await testerTorznab('yggreborn', cle);
      case 'c411': return await testerTorznab('c411', cle);
      case 'tr4ker': return await testerTorznab('tr4ker', cle);
      case 'v3x': return await testerTorznab('v3x', cle);
      case 'g3mini': return await testerUnit3d('g3mini', cle);
      case 'rustatio': return await testerRustatio(cle);
      default: return { ok: false, message: `Service « ${service} » inconnu.` };
    }
  } catch (e) {
    // Le message d'exception peut porter l'URL complete, donc la cle. On ne le rend
    // jamais, et on ne journalise que le type.
    tracer('TestCle', `${service} : echec (${(e as Error).name})`);
    return { ok: false, message: 'Le test a echoue. Reessayez dans un instant.' };
  }
}
