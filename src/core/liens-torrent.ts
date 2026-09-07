// Memoire courte des liens .torrent, cote serveur uniquement.
//
// POURQUOI CE FICHIER EXISTE. L'URL du .torrent d'un tracker prive PORTE LA PASSKEY de
// l'utilisateur. La renvoyer au navigateur avec les resultats la ferait atterrir dans
// l'historique, dans les outils de developpement et dans tout ce qui journalise une
// URL. On la retient donc ici, et le navigateur ne manipule qu'un hash.
//
// EN MEMOIRE, PAS SUR DISQUE — pour la meme raison que la DEK des sessions : le projet
// tient l'invariant « aucune passkey ne s'ecrit sur disque », et le cache SQLite en est
// un. Perdre cette table au redemarrage ne coute qu'une nouvelle recherche.

import type { EtatCache } from '../debrid/types';

type NomService = 'alldebrid' | 'torbox';

const TTL_MS = 2 * 60 * 60 * 1000;
/** Plafond global : la table ne doit pas devenir une fuite de memoire lente. */
const MAX_ENTREES = 20_000;

interface Entree {
  /** Absent quand la source ne publie pas de .torrent — Knaben, presque toujours. */
  url?: string;
  /** Source d'origine (c411, tr4ker, g3mini, nyaa...) : sert au seed anti-H&R. */
  source?: string;
  /** Autres sources ou la meme release existe (dedup par infohash). */
  aussiSur?: string[];
  expire: number;
}

const table = new Map<string, Entree>();

/**
 * Verdicts de cache connus, par utilisateur, hash et service.
 *
 * Ils servent de LAISSEZ-PASSER pour la lecture en ligne : on ne lit que ce qui est
 * deja en cache, et le serveur doit pouvoir le verifier sans rien deposer.
 *
 * Le detour est necessaire, pas cosmetique. Demander a AllDebrid « est-ce en cache ? »
 * AURAIT ete un depot — c'est sa seule facon de repondre. En s'appuyant sur un verdict
 * deja obtenu par un geste explicite de l'utilisateur, la question ne se repose pas.
 */
const etats = new Map<string, { etat: EtatCache; expire: number }>();

function cleEtat(userId: number, hash: string, service: NomService): string {
  return `${userId}:${hash.toLowerCase()}:${service}`;
}

export function poserEtatCache(
  userId: number,
  hash: string,
  service: NomService,
  etat: EtatCache,
): void {
  if (!hash) return;
  const maintenant = Date.now();
  for (const [k, v] of etats) if (v.expire < maintenant) etats.delete(k);
  etats.set(cleEtat(userId, hash, service), { etat, expire: maintenant + TTL_MS });
}

/**
 * Efface ce qu'on croyait savoir de cette release, chez TOUS les services.
 *
 * Appelee apres un depot, parce que deposer CHANGE la reponse. Sans cela, un « absent »
 * memorise survivait au telechargement qu'il venait de declencher : l'utilisateur voyait
 * sa release annoncee absente alors qu'elle etait en train d'arriver sur son compte, et
 * il fallait attendre l'expiration du verdict pour que la verite revienne.
 *
 * On efface plutot que de poser « en-cache » : un depot n'est pas une mise en cache. Le
 * torrent peut etre a 0 %. « Je ne sais plus » est exact, « c'est pret » serait faux.
 */
export function oublierEtatCache(userId: number, hash: string): void {
  if (!hash) return;
  for (const service of ['alldebrid', 'torbox'] as NomService[]) {
    etats.delete(cleEtat(userId, hash, service));
  }
}

/** Etat connu, ou « inconnu ». Jamais « absent » par defaut : ne pas savoir n'est pas savoir que non. */
export function etatCacheMemorise(
  userId: number,
  hash: string,
  service: NomService,
): EtatCache {
  const e = etats.get(cleEtat(userId, hash, service));
  if (!e || e.expire < Date.now()) return 'inconnu';
  return e.etat;
}

function cle(userId: number, hash: string): string {
  return `${userId}:${hash.toLowerCase()}`;
}

function purger(): void {
  const maintenant = Date.now();
  for (const [k, v] of table) if (v.expire < maintenant) table.delete(k);
  if (table.size <= MAX_ENTREES) return;
  // Toujours au-dessus du plafond apres purge : on retire les plus anciennes.
  const parAnciennete = [...table.entries()].sort((a, b) => a[1].expire - b[1].expire);
  for (const [k] of parAnciennete.slice(0, table.size - MAX_ENTREES)) table.delete(k);
}

/**
 * Retient un hash vu par cet utilisateur, avec son .torrent quand il en existe un.
 *
 * On memorise MEME SANS URL, et c'est le point : sans cela, une release Knaben — qui ne
 * publie qu'un magnet — serait indistinguable d'un hash inconnu. L'utilisateur recevrait
 * « relancez la recherche » au lieu de « cette source ne fournit pas de .torrent », et
 * chercherait le probleme du mauvais cote.
 */
export function memoriserLien(
  userId: number,
  hash: string,
  url?: string,
  source?: string,
  aussiSur?: string[],
): void {
  if (!hash) return;
  purger();
  table.set(cle(userId, hash), { url, source, aussiSur, expire: Date.now() + TTL_MS });
}

/** Source d'origine (+ aussiSur) memorisee pour ce hash, ou objet vide si inconnu/expire. */
export function sourceMemorisee(userId: number, hash: string): { source?: string; aussiSur?: string[] } {
  const e = table.get(cle(userId, hash));
  if (!e || e.expire < Date.now()) return {};
  return { source: e.source, aussiSur: e.aussiSur };
}

/** Ce hash a-t-il ete vu dans une recherche recente de cet utilisateur ? */
export function hashConnu(userId: number, hash: string): boolean {
  const e = table.get(cle(userId, hash));
  return Boolean(e && e.expire >= Date.now());
}

export function lienMemorise(userId: number, hash: string): string | undefined {
  const e = table.get(cle(userId, hash));
  if (!e) return undefined;
  if (e.expire < Date.now()) {
    table.delete(cle(userId, hash));
    return undefined;
  }
  return e.url;
}

/** Exportee pour les tests. */
export function viderLiens(): void {
  table.clear();
  etats.clear();
}
