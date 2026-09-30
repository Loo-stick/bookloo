// Client de la facade Telegram.
//
// La facade parle HTTP Range comme un serveur de fichiers ordinaire — c'est la decision
// qui permet a `plages.ts` et `zip.ts` de ne pas changer d'une ligne. Ce fichier ne fait
// donc que deux choses : chercher, et fabriquer l'URL d'un fichier.

import { getJson } from '../../core/http';
import { getSettings } from '../../core/settings';
import { tracerAppel, hoteDe } from '../../core/journal';

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
  const url = getSettings().telegram.url.replace(/\/+$/, '');
  // SANS FACADE, ON REFUSE PLUTOT QUE DE CONSTRUIRE. Une adresse vide donnait un chemin
  // RELATIF : une release `tg:` deja memorisee restait ouvrable et echouait sur un message
  // incomprehensible, au lieu de dire ce qui manque.
  if (!url) throw new Error('Telegram n est pas configure sur cette instance');
  return url;
}

/**
 * Le chemin d'un fichier, sans la base.
 *
 * Separe pour rester verifiable SANS reglages charges : la forme du chemin est une regle du
 * protocole, l'adresse de la facade est une configuration.
 *
 * ON VALIDE AVANT DE CONSTRUIRE. `estIdentiteTelegram` vivait juste au-dessus sans etre
 * appelee ici : n'importe quelle chaine entrait donc dans l'URL. Signale par une revue de
 * code le 2026-08-29.
 *
 * PAS D'ENCODAGE : la validation contraint deja la forme a « tg:<canal>:<message> », et
 * encoder les deux-points changerait ce que la facade recoit sur un chemin qui fonctionne.
 */
export function cheminFichier(identite: string): string {
  if (!estIdentiteTelegram(identite)) {
    throw new Error('identite Telegram invalide');
  }
  return `/api/telegram/fichier/${identite.replace(/^tg:/, '')}`;
}

export function urlFichier(identite: string): string {
  return `${base()}${cheminFichier(identite)}`;
}

/**
 * Combien de resultats demander a la facade.
 *
 * MESURE DU 2026-08-28, sur « Le Petit Spirou » : a 60, la facade rend 60 lignes et le tome
 * 20 n'en fait pas partie — il existe pourtant dans l'index. A 200, elle rend ses 152
 * resultats reels, T20 compris. Le plafond de 60 coupait donc des series entieres, en
 * silence : rien ne distingue « la facade n'a que ca » de « la facade a ete tronquee ».
 *
 * Le plafond global du serveur est borne a 500 : cent cinquante lignes y tiennent
 * largement, et le tri par rapprochement se charge du reste.
 */
const LIMITE = 200;

export async function chercherTelegram(
  q: string,
  signal?: AbortSignal,
): Promise<ResultatTelegram[]> {
  const url = `${base()}/api/telegram/recherche?q=${encodeURIComponent(q)}&limite=${LIMITE}`;
  const debut = Date.now();
  const r = await getJson<{ resultats: ResultatTelegram[] }>(url, {
    timeoutMs: 8000,
    signal,
    headers: enTetesFacade(),
  });
  // L'HOTE SEUL : l'URL porte le terme cherche, et le secret de facade voyage en en-tete.
  tracerAppel({
    source: 'telegram',
    hote: hoteDe(base()),
    statut: r === null ? null : 200,
    duree: Date.now() - debut,
    resultats: r?.resultats?.length,
    ok: r !== null,
  });
  // `null` signale un ECHEC, jamais un resultat vide. La distinction remonte jusqu'a la
  // pastille de source, ou « vide » et « n'a pas repondu » ne disent pas la meme chose —
  // et les confondre ferait croire que Telegram ne connait pas une oeuvre qu'il a.
  if (r === null) throw new Error('la facade Telegram n a pas repondu');
  return r.resultats || [];
}
