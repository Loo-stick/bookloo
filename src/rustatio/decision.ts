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
  // Seed UNIQUEMENT sur 'absent' = download frais confirme (H&R contracte). Sur 'en-cache'
  // (rien de frais) ET sur 'inconnu' (on ne SAIT pas), on NE seede PAS : sinon on irait
  // chercher le .torrent chez le tracker (avec la passkey) pour une release peut-etre deja
  // en cache -> fetch inutile + le torrent apparait sur le dashboard du tracker pour rien.
  return ctx.etatCache === 'absent';
}
