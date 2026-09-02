import type { EtatCache } from '../debrid/types';
import { compteAuRatio } from '../sources/ratio';
import { configHnrPour } from './config-hnr';

/**
 * Faut-il declencher un seed Rustatio apres ce download ? (fonction pure, decision seule.)
 *
 * On gate sur `compteAuRatio(source)` — la source PRIMAIRE reellement telechargee (celle
 * dont le .torrent/passkey a servi) — et NON sur `sansRatio` (qui regarde `aussiSur`).
 * Le H&R est cree par le download qu'on a FAIT : si on a pris le torrent C411, on doit du
 * H&R a C411, meme si la meme oeuvre existe gratuitement sur Nyaa. La dispo ailleurs
 * n'efface pas l'obligation deja contractee.
 */
export function doitSeeder(ctx: {
  source: string;
  aussiSur?: string[];
  aConfigRustatio: boolean;
  torrentUrl?: string;
  etatCache: EtatCache;
}): boolean {
  if (!ctx.aConfigRustatio) return false;
  if (!ctx.torrentUrl) return false; // magnet-only : rien a pousser
  if (!compteAuRatio(ctx.source)) return false; // la source telechargee ne coute pas de ratio
  if (!configHnrPour(ctx.source)) return false; // source non couverte (Ygg...)
  // ON NE SEEDE PAS SUR 'en-cache' : rien de frais n'a ete telecharge, donc aucun H&R
  // n'a ete contracte.
  //
  // ON SEEDE SUR 'inconnu', et c'est un CHANGEMENT du 2026-08-29. La regle precedente
  // exigeait un 'absent' confirme, en s'appuyant sur cet argument : « sinon on irait
  // chercher le .torrent chez le tracker (avec la passkey) pour une release peut-etre
  // deja en cache -> fetch inutile ». L'argument ne tient pas sur le seul chemin qui
  // appelle cette fonction. `doitSeeder` exige `torrentUrl`, et la route `/deposer` a
  // deja passe cette meme URL a `svc.deposer()`, qui a deja telecharge le .torrent chez
  // le tracker. LE FETCH EST DEJA PAYE quand on arrive ici.
  //
  // Restait donc a comparer deux erreurs :
  //   - seeder pour rien : un torrent de plus sur le Rustatio de l'utilisateur ;
  //   - ne pas seeder alors qu'il fallait : un Hit & Run sur un tracker prive, c'est-a-dire
  //     exactement ce que ce module existe pour eviter, et cela peut couter le compte.
  //
  // 'inconnu' veut dire que la VERIFICATION a echoue — panne TorBox ou AllDebrid — et le
  // depot, lui, a eu lieu quand meme. Le module anti-H&R ratait donc precisement le cas ou
  // il est le plus utile. Signale par une revue de code le 2026-08-29.
  return ctx.etatCache !== 'en-cache';
}
