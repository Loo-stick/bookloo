// Client HTTP unique du projet. Toute source passe par ici pour trois raisons :
// un budget de temps respecte (le fan-out impose une deadline dure), une politique
// de retry unique, et des en-tetes de navigateur credibles.
//
// La politique de retry est reprise de wastream (debrid/base.py) : on ne rejoue que
// les codes qui traduisent une indisponibilite passagere. Rejouer un 403 ou un 404
// ne fait que doubler la charge sur une source qui a deja repondu clairement.

import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';

export const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

export const BROWSER_HEADERS: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
};

export interface HttpOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Deadline du fan-out : coupe la requete des que le budget global est epuise. */
  signal?: AbortSignal;
  retries?: number;
  params?: Record<string, string | number | undefined>;
  responseType?: 'json' | 'text' | 'buffer';
  maxRedirects?: number;
  /** Taille maximale acceptee. Garde-fou RAM : un gros corps inattendu est refuse. */
  maxBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}

/**
 * GET avec retry. Renvoie la reponse meme en cas de statut d'erreur (validateStatus
 * est neutralise) : c'est a l'appelant de decider ce qu'un 403 signifie pour lui —
 * pour KissKH, par exemple, un 403 declenche la re-extraction du kkey.
 */
export async function httpGet<T = unknown>(
  url: string,
  opts: HttpOptions = {},
): Promise<AxiosResponse<T> | null> {
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const cfg: AxiosRequestConfig = {
    headers: { ...BROWSER_HEADERS, ...opts.headers },
    timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    validateStatus: () => true,
    maxRedirects: opts.maxRedirects ?? 4,
    maxContentLength: opts.maxBytes ?? DEFAULT_MAX_BYTES,
    maxBodyLength: opts.maxBytes ?? DEFAULT_MAX_BYTES,
    decompress: true,
    params: opts.params,
    signal: opts.signal,
  };
  if (opts.responseType === 'text') {
    cfg.responseType = 'text';
    // transformResponse neutralise : axios essaie sinon de parser du JSON dans du
    // HTML et renvoie un objet inattendu.
    cfg.transformResponse = [(v) => v];
  } else if (opts.responseType === 'buffer') {
    // Indispensable pour les fichiers BINAIRES servis tels quels — un .srt.gz
    // d'OpenSubtitles decode en texte est irrecuperable (les octets non-UTF8 sont
    // remplaces avant meme qu'on puisse decompresser).
    cfg.responseType = 'arraybuffer';
    cfg.transformResponse = [(v) => v];
  }

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (opts.signal?.aborted) return null;
    try {
      const res = await axios.get<T>(url, cfg);
      if (RETRY_STATUS.has(res.status) && attempt < retries) {
        await sleep(400 * (attempt + 1), opts.signal);
        continue;
      }
      return res;
    } catch (e) {
      // Abort = budget epuise : on ne rejoue pas, ce serait travailler pour rien.
      if (opts.signal?.aborted) return null;
      if (attempt >= retries) {
        console.log(`[HTTP] ${shortUrl(url)} — ${(e as Error).message.slice(0, 100)}`);
        return null;
      }
      await sleep(400 * (attempt + 1), opts.signal);
    }
  }
  return null;
}

/** GET JSON : renvoie null sur toute reponse non-2xx ou non exploitable. */
export async function getJson<T = unknown>(url: string, opts: HttpOptions = {}): Promise<T | null> {
  const res = await httpGet<T>(url, opts);
  if (!res || res.status < 200 || res.status >= 300) return null;
  return res.data ?? null;
}

/** GET texte/HTML : renvoie null sur toute reponse non-2xx. */
export async function getText(url: string, opts: HttpOptions = {}): Promise<string | null> {
  const res = await httpGet<string>(url, { ...opts, responseType: 'text' });
  if (!res || res.status < 200 || res.status >= 400) return null;
  return typeof res.data === 'string' ? res.data : null;
}

/**
 * Le corps d'un formulaire, un champ pouvant etre REPETE.
 *
 * `new URLSearchParams(objet)` ecrase les doublons : une cle ne peut porter qu'une valeur.
 * Or un `<select multiple>` HTML envoie la MEME cle plusieurs fois — `catlist[]=1` puis
 * `catlist[]=4` pour chercher dans deux categories a la fois. Aplatir en une seule valeur
 * ferait chercher dans une seule, en silence.
 */
export function corpsDeFormulaire(fields: Record<string, string | string[]>): string {
  const p = new URLSearchParams();
  for (const [cle, valeur] of Object.entries(fields)) {
    if (Array.isArray(valeur)) for (const v of valeur) p.append(cle, v);
    else p.append(cle, valeur);
  }
  return p.toString();
}

/**
 * POST de formulaire, reponse en texte.
 *
 * Indispensable pour les sites DataLife Engine (Zone-Telechargement et consorts) :
 * leur recherche N'EXISTE PAS en GET — le formulaire en GET renvoie la page d'accueil
 * sans le moindre resultat, ce qui donne l'illusion d'un site sans correspondance.
 */
export async function postForm(
  url: string,
  fields: Record<string, string | string[]>,
  opts: HttpOptions = {},
): Promise<string | null> {
  try {
    const res = await axios.post<string>(url, corpsDeFormulaire(fields), {
      headers: {
        ...BROWSER_HEADERS,
        'Content-Type': 'application/x-www-form-urlencoded',
        ...opts.headers,
      },
      timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      validateStatus: () => true,
      maxRedirects: opts.maxRedirects ?? 4,
      maxContentLength: opts.maxBytes ?? DEFAULT_MAX_BYTES,
      responseType: 'text',
      transformResponse: [(v) => v],
      decompress: true,
      signal: opts.signal,
    });
    if (res.status < 200 || res.status >= 400) return null;
    return typeof res.data === 'string' ? res.data : null;
  } catch (e) {
    console.log(`[HTTP POST] ${shortUrl(url)} — ${(e as Error).message.slice(0, 100)}`);
    return null;
  }
}

/**
 * POST de formulaire qui rend AUSSI les cookies poses.
 *
 * `postForm` ne rend que le corps, et pour une CONNEXION c'est le corps qui ment : une
 * connexion DataLife Engine reussie repond une page ordinaire, sans lien de deconnexion,
 * strictement impossible a distinguer d'un echec. Ce sont les cookies qui disent la
 * verite — mesure du 2026-09-02 : `dle_user_id` et `dle_password` apparaissent, ou rien
 * ne vient a part `PHPSESSID`.
 *
 * On ne suit AUCUNE redirection ici : un 302 apres connexion reposerait les cookies sur la
 * page suivante, et l'on perdrait ceux du premier saut.
 */
export async function postFormAvecCookies(
  url: string,
  fields: Record<string, string>,
  opts: HttpOptions = {},
): Promise<{ statut: number; corps: string; cookies: Record<string, string> } | null> {
  try {
    const res = await axios.post<string>(url, new URLSearchParams(fields).toString(), {
      headers: {
        ...BROWSER_HEADERS,
        'Content-Type': 'application/x-www-form-urlencoded',
        ...opts.headers,
      },
      timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      validateStatus: () => true,
      maxRedirects: 0,
      maxContentLength: opts.maxBytes ?? DEFAULT_MAX_BYTES,
      responseType: 'text',
      transformResponse: [(v) => v],
      decompress: true,
      signal: opts.signal,
    });
    const brut = res.headers['set-cookie'];
    return {
      statut: res.status,
      corps: typeof res.data === 'string' ? res.data : '',
      cookies: cookiesDeposes(Array.isArray(brut) ? brut : []),
    };
  } catch (e) {
    console.log(`[HTTP POST] ${shortUrl(url)} — ${(e as Error).message.slice(0, 100)}`);
    return null;
  }
}

/**
 * Les cookies REELLEMENT poses par un `Set-Cookie`.
 *
 * UN COOKIE EFFACE N'EST PAS UN COOKIE POSE : a chaque visite anonyme, zone-ebook renvoie
 * `dle_user_id=deleted; expires=Thu, 01-Jan-1970`. Le garder ferait lire « session
 * ouverte » sur une page de visiteur — c'est-a-dire exactement l'inverse.
 */
export function cookiesDeposes(entetes: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const ligne of entetes) {
    const paire = String(ligne).split(';')[0] ?? '';
    const i = paire.indexOf('=');
    if (i <= 0) continue;
    const nom = paire.slice(0, i).trim();
    const valeur = paire.slice(i + 1).trim();
    if (!nom || !valeur || valeur === 'deleted') continue;
    if (/max-age=0|expires=thu, 01-jan-1970/i.test(ligne)) continue;
    out[nom] = valeur;
  }
  return out;
}

/** Un en-tete `Cookie` a partir des cookies retenus. */
export function enteteCookie(cookies: Record<string, string>): string {
  return Object.entries(cookies).map(([n, v]) => `${n}=${v}`).join('; ');
}

export async function postJson<T = unknown>(
  url: string,
  body: unknown,
  opts: HttpOptions = {},
): Promise<T | null> {
  try {
    const res = await axios.post<T>(url, body, {
      headers: { 'Content-Type': 'application/json', ...BROWSER_HEADERS, ...opts.headers },
      timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      validateStatus: () => true,
      signal: opts.signal,
    });
    if (res.status < 200 || res.status >= 300) return null;
    return res.data ?? null;
  } catch {
    return null;
  }
}

/**
 * POST multipart/form-data. axios pose lui-meme le Content-Type + boundary depuis FormData.
 * Renvoie `{status, data}` (data = corps parse, meme sur non-2xx pour pouvoir lire un
 * message d'erreur), ou `null` sur exception reseau.
 */
export async function postMultipart<T = unknown>(
  url: string,
  form: FormData,
  opts: HttpOptions = {},
): Promise<{ status: number; data: T | null } | null> {
  try {
    const res = await axios.post<T>(url, form, {
      headers: { ...opts.headers },
      timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      validateStatus: () => true,
      signal: opts.signal,
    });
    return { status: res.status, data: res.data ?? null };
  } catch {
    return null;
  }
}

/** DELETE. Renvoie true sur 2xx, false sinon (ou sur exception). */
export async function del(url: string, opts: HttpOptions = {}): Promise<boolean> {
  try {
    const res = await axios.delete(url, {
      headers: { ...opts.headers },
      timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      validateStatus: () => true,
      signal: opts.signal,
    });
    return res.status >= 200 && res.status < 300;
  } catch {
    return false;
  }
}

/** PATCH JSON. Renvoie true sur 2xx, false sinon (ou sur exception). */
export async function patchJson(url: string, body: unknown, opts: HttpOptions = {}): Promise<boolean> {
  try {
    const res = await axios.patch(url, body, {
      headers: { 'Content-Type': 'application/json', ...opts.headers },
      timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      validateStatus: () => true,
      signal: opts.signal,
    });
    return res.status >= 200 && res.status < 300;
  } catch {
    return false;
  }
}

function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname + u.pathname.slice(0, 40);
  } catch {
    return url.slice(0, 60);
  }
}

/**
 * Deadline partagee par tout un fan-out. `AbortSignal.timeout` seul ne suffit pas :
 * on veut aussi pouvoir constater le temps restant pour decider d'engager, ou non,
 * une source connue pour etre lente.
 */
export class Deadline {
  private readonly endsAt: number;
  private readonly controleur = new AbortController();
  readonly signal: AbortSignal;

  constructor(budgetMs: number) {
    this.endsAt = Date.now() + budgetMs;
    // Deux facons d'expirer : l'echeance, et une interruption explicite. La seconde
    // sert au rechauffement en arriere-plan — on doit pouvoir couper court a un
    // travail devenu inutile sans attendre son echeance.
    this.signal = AbortSignal.any([this.controleur.signal, AbortSignal.timeout(budgetMs)]);
  }

  /** Coupe court immediatement, avant l'echeance. */
  arreter(): void {
    this.controleur.abort();
  }

  remainingMs(): number {
    // Une interruption vaut echeance atteinte : sans ça, une source continuerait a
    // engager des requetes vouees a echouer parce qu'elle croit avoir du temps.
    if (this.controleur.signal.aborted) return 0;
    return Math.max(0, this.endsAt - Date.now());
  }

  expired(): boolean {
    return this.remainingMs() <= 0;
  }
}
