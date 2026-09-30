// Aller chercher un `.torrent` chez un tracker, SANS servir de relais vers l'interne.
//
// POURQUOI UN MODULE. La regle — verifier l'adresse, puis interdire les redirections —
// etait ecrite DEUX FOIS, dans `alldebrid.ts` et `torbox.ts`, avec le meme commentaire.
// Trois autres endroits allaient chercher la MEME URL sans elle : le seed anti-H&R, le
// sondage d'une release, et le calcul d'empreinte. Une regle recopiee derive ; une regle
// appelee ne derive pas. C'est la troisieme fois cette semaine que ce projet paie une
// decision tenue a plusieurs endroits.

import axios from 'axios';
import { verifierUrlSortante } from './adresse-interne';

/**
 * Le `.torrent` d'une release, ou une erreur.
 *
 * L'URL VIENT D'UN TRACKER, donc d'un tiers. Une adresse forgee pointant vers le reseau
 * interne ferait lire par le serveur ce que le client ne peut pas atteindre — puis, selon
 * l'appelant, le televerser chez un debrideur ou chez Rustatio, ou il devient lisible.
 *
 * `maxRedirects: 0` N'EST PAS OPTIONNEL et va avec la verification : sans lui, un hote
 * public redirigerait vers l'interne apres le controle.
 */
export async function recupererTorrent(
  url: string,
  opts: { timeoutMs?: number; maxOctets?: number; signal?: AbortSignal } = {},
): Promise<{ statut: number; octets: Buffer } | null> {
  await verifierUrlSortante(url);
  try {
    const res = await axios.get<ArrayBuffer>(url, {
      responseType: 'arraybuffer',
      timeout: opts.timeoutMs ?? 15000,
      maxRedirects: 0,
      maxContentLength: opts.maxOctets ?? 5_000_000,
      validateStatus: () => true,
      signal: opts.signal,
    });
    return { statut: res.status, octets: Buffer.from(res.data) };
  } catch {
    return null;
  }
}
