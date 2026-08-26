// Client de la facade Telegram.
//
// La facade parle HTTP Range comme un serveur de fichiers ordinaire — c'est la decision
// qui permet a `plages.ts` et `zip.ts` de ne pas changer d'une ligne. Ce fichier ne fait
// donc que deux choses : chercher, et fabriquer l'URL d'un fichier.

import { getJson } from '../../core/http';
import { getSettings } from '../../core/settings';

export interface ResultatTelegram {
  id: string;
  nom: string;
  taille: number;
  serie: string | null;
  tome: number | null;
  chapitre: number | null;
  estPack: boolean;
  plage: string | null;
  canal: string | null;
}

/**
 * `tg:<canal>:<message>`, sur le modele exact de `ddl:<site>:<id>`.
 *
 * La FORME de l'identite est ce qui distingue un torrent d'autre chose dans tout le
 * pipeline. Une collision avec un hash de quarante hexadecimaux enverrait une release
 * Telegram chercher un debrideur qui n'a rien a voir avec elle.
 */
export function identiteTelegram(id: string): string {
  return `tg:${id}`;
}

export function estIdentiteTelegram(x: string): boolean {
  return /^tg:\d+:\d+$/.test(x);
}

export function enTetesFacade(): Record<string, string> {
  return { 'X-Facade-Secret': getSettings().telegram.secret };
}

function base(): string {
  return getSettings().telegram.url.replace(/\/+$/, '');
}

export function urlFichier(identite: string): string {
  return `${base()}/api/telegram/fichier/${identite.replace(/^tg:/, '')}`;
}

export async function chercherTelegram(
  q: string,
  signal?: AbortSignal,
): Promise<ResultatTelegram[]> {
  const url = `${base()}/api/telegram/recherche?q=${encodeURIComponent(q)}&limite=60`;
  const r = await getJson<{ resultats: ResultatTelegram[] }>(url, {
    timeoutMs: 8000,
    signal,
    headers: enTetesFacade(),
  });
  // `null` signale un ECHEC, jamais un resultat vide. La distinction remonte jusqu'a la
  // pastille de source, ou « vide » et « n'a pas repondu » ne disent pas la meme chose —
  // et les confondre ferait croire que Telegram ne connait pas une oeuvre qu'il a.
  if (r === null) throw new Error('la facade Telegram n a pas repondu');
  return r.resultats || [];
}
