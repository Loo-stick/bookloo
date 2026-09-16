// Le FICHIER d'une edition Comics Tracker, et le detour par Google Drive.
//
// MESURE DU 2026-09-16, avec le compte de Loo, sur « Batman: Ego » :
//   1. `GET /api/editions/<id>/download-link` avec `Authorization: Bearer <jeton>` rend
//      `{ "downloadLink": "https://drive.google.com/uc?id=<33 caracteres>" }` ;
//   2. cette adresse ne rend PAS le fichier mais une page HTML de 2,4 Ko : au-dela d'une
//      certaine taille, Drive demande une confirmation. Elle porte un formulaire vers
//      `drive.usercontent.google.com/download` avec quatre champs — `id`, `export`,
//      `confirm`, `uuid` — et le nom du fichier, « Batman_Ego.cbz » ;
//   3. l'adresse ainsi reconstruite rend les octets : HEAD 200, 209 801 569 octets,
//      `accept-ranges: bytes` ; une plage de 2 Mo prise au MILIEU du fichier rend 206 avec
//      le bon `content-range`, a 1 270 Ko/s.
//
// D'OU LA LECTURE A DISTANCE, sans prechargement : a ce debit, une planche arrive en une a
// deux secondes. C'est LibGen qui imposait de rapatrier — 14 a 400 Ko/s — pas Drive.
//
// LE `uuid` EST PROPRE A CHAQUE DEMANDE : on refait le parcours a chaque ouverture, et
// `ouvrirDistant` en redemande un neuf si le lien meurt en cours de lecture. Deux
// requetes : c'est moins cher que de garder une adresse qui peut ne plus valoir.

import axios from 'axios';
import { tracerAppel, hoteDe } from '../../core/journal';
import { verifierUrlSortante } from '../../debrid/adresse-interne';
import { BASE_CT } from './recherche';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128.0 Safari/537.36';
const HOTES_DRIVE = new Set(['drive.google.com', 'drive.usercontent.google.com', 'docs.google.com']);

/**
 * Le site n'a pas rendu de lien : jeton refuse, edition absente, ou panne de son cote.
 *
 * Ce motif est compare AILLEURS — `ouverture.ts` rejoue alors la demande avec un jeton
 * neuf — d'ou une constante plutot qu'une phrase recopiee.
 */
export const MOTIF_SANS_LIEN = 'Comics Tracker n a pas rendu de lien pour cette edition';

/** Ce que Drive dit quand un fichier a trop servi : ce n'est pas une panne de chez nous. */
export const MOTIF_QUOTA_DRIVE = 'Google Drive refuse ce fichier pour le moment : trop de '
  + 'telechargements. Reessayez plus tard, ou prenez une autre edition.';

/** L'identifiant Drive d'un lien `uc?id=…`, ou `null`. */
export function idDriveDuLien(lien: string): string | null {
  let u: URL;
  try { u = new URL(String(lien || '')); } catch { return null; }
  // L'HOTE EST VERIFIE : la reponse du site dirige la requete suivante, et rien
  // n'obligerait cette reponse a rester chez Google.
  if (u.protocol !== 'https:' || !HOTES_DRIVE.has(u.hostname)) return null;
  const id = u.searchParams.get('id') || (/\/file\/d\/([-\w]{10,})/.exec(u.pathname) || [])[1] || '';
  return /^[-\w]{10,128}$/.test(id) ? id : null;
}

/**
 * L'adresse finale que decrit la page de confirmation, RECONSTRUITE.
 *
 * On ne reprend de la page que les valeurs de ses champs, et on refabrique l'adresse sur
 * l'hote de telechargement de Drive avec l'identifiant DEMANDE : une page qui citerait un
 * autre fichier, ou un autre hote, ne peut pas detourner la requete.
 *
 * `null` quand la page ne porte pas de formulaire — c'est le cas du quota depasse, que
 * l'appelant distingue par `pageDeQuota`.
 */
export function lienFinalDepuisConfirmation(html: string, id: string): string | null {
  const page = String(html || '');
  const action = (/<form[^>]+action="([^"]+)"/i.exec(page) || [])[1];
  if (!action) return null;
  let cible: URL;
  try { cible = new URL(action.replace(/&amp;/g, '&')); } catch { return null; }
  if (cible.protocol !== 'https:' || !HOTES_DRIVE.has(cible.hostname)) return null;

  const u = new URL(`https://drive.usercontent.google.com${cible.pathname}`);
  for (const [, nom, valeur] of page.matchAll(/name="([A-Za-z0-9_-]{1,32})"\s+value="([^"]{0,128})"/g)) {
    if (nom === 'id') continue;
    if (/^[\w.:=-]*$/.test(valeur)) u.searchParams.set(nom, valeur);
  }
  u.searchParams.set('id', id);
  if (!u.searchParams.get('export')) u.searchParams.set('export', 'download');
  if (!u.searchParams.get('confirm')) u.searchParams.set('confirm', 't');
  return u.href;
}

/** Drive a-t-il refuse pour cause de quota ? Sa page le dit en clair. */
export function pageDeQuota(html: string): boolean {
  const p = String(html || '');
  return /too many users have (?:viewed|downloaded)|quota (?:exceeded|for this file)/i.test(p);
}

/** Le nom du fichier, quand la page de confirmation l'annonce : « Batman_Ego.cbz ». */
export function nomDuFichier(html: string): string | null {
  const m = /<a [^>]*href="\/open\?id=[^"]*"[^>]*>([^<]{1,160})<\/a>/i.exec(String(html || ''))
    || /uc-name-size"><a[^>]*>([^<]{1,160})</i.exec(String(html || ''));
  const nom = (m || [])[1];
  return nom ? nom.replace(/\s+/g, ' ').trim() : null;
}

/**
 * Ce que rend `uc?export=download` : une page de confirmation, ou le FICHIER lui-meme.
 *
 * ON NE TELECHARGE PAS POUR SAVOIR. Cette reponse etait lue en entier sous un plafond d'un
 * megaoctet, et une edition que Drive sert sans confirmation — les petites — le faisait
 * sauter : « maxContentLength size of 1048576 exceeded » sur un comic parfaitement
 * disponible. Signale a l'usage le 2026-09-16.
 *
 * On lit donc le FLUX : le type suffit a trancher, et seule une page HTML est retenue, au
 * plus `maxOctets` (la page mesuree pese 2,4 Ko). Le reste est jete sans etre recu.
 *
 * Rend `null` quand l'adresse sert deja des octets.
 */
export async function lirePageConfirmation(
  url: string,
  signal?: AbortSignal,
  maxOctets = 64 * 1024,
): Promise<string | null> {
  const r = await axios.get(url, {
    timeout: 25000, signal, responseType: 'stream', validateStatus: () => true, maxRedirects: 5,
    headers: { 'User-Agent': UA, Accept: 'text/html,application/octet-stream' },
  });
  const flux = r.data as NodeJS.ReadableStream & { destroy: () => void };
  if (!String(r.headers['content-type'] || '').includes('text/html')) {
    flux.destroy();
    return null;
  }
  const morceaux: Buffer[] = [];
  let recus = 0;
  try {
    for await (const morceau of flux as AsyncIterable<Buffer>) {
      morceaux.push(morceau);
      recus += morceau.length;
      if (recus >= maxOctets) break;
    }
  } finally {
    flux.destroy();
  }
  // TRANCHE A LA BORNE : un flux arrive par blocs de 64 Ko, et s'arreter « des qu'on
  // depasse » rendait donc jusqu'a un bloc de trop. La borne demandee est la borne rendue.
  return Buffer.concat(morceaux).subarray(0, maxOctets).toString('utf-8');
}

/** Le lien Drive d'une edition, demande au site avec le jeton du membre. */
export async function lienDriveDeLEdition(
  editionId: string,
  jeton: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const url = `${BASE_CT}/api/editions/${encodeURIComponent(editionId)}/download-link`;
  const debut = Date.now();
  const r = await axios.get<{ downloadLink?: unknown }>(url, {
    timeout: 20000, signal, validateStatus: () => true, maxRedirects: 0,
    maxContentLength: 64 * 1024,
    headers: { 'User-Agent': UA, Accept: 'application/json', Authorization: `Bearer ${jeton}` },
  });
  tracerAppel({
    source: 'comics-tracker', hote: hoteDe(url), statut: r.status,
    duree: Date.now() - debut, ok: r.status === 200,
  });
  if (r.status !== 200) return null;
  const lien = typeof r.data?.downloadLink === 'string' ? r.data.downloadLink : '';
  return lien || null;
}

/**
 * L'adresse des octets, prete pour `ouvrirDistant`.
 *
 * Leve avec un motif lisible quand Drive refuse : l'utilisateur doit savoir si c'est son
 * compte, le fichier, ou un quota — les trois demandent trois gestes differents.
 */
export async function resoudreFichierCt(
  editionId: string,
  jeton: string,
  signal?: AbortSignal,
): Promise<string> {
  const lien = await lienDriveDeLEdition(editionId, jeton, signal);
  if (!lien) throw new Error(MOTIF_SANS_LIEN);
  const id = idDriveDuLien(lien);
  if (!id) throw new Error('le lien rendu par Comics Tracker ne mene pas a Google Drive');

  const debut = Date.now();
  const html = await lirePageConfirmation(`https://drive.google.com/uc?export=download&id=${id}`, signal);
  tracerAppel({
    source: 'comics-tracker', hote: 'drive.google.com', statut: html === null ? 206 : 200,
    duree: Date.now() - debut, ok: true,
  });

  // AUCUNE CONFIRMATION DEMANDEE : Drive sert deja les octets — c'est le cas des petites
  // editions. L'adresse de telechargement se construit alors directement.
  if (html === null) {
    const directe = `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`;
    await verifierUrlSortante(directe);
    return directe;
  }
  if (pageDeQuota(html)) throw new Error(MOTIF_QUOTA_DRIVE);

  const finale = lienFinalDepuisConfirmation(html, id);
  if (!finale) throw new Error('Google Drive n a pas rendu de lien de telechargement pour ce fichier');
  await verifierUrlSortante(finale);
  return finale;
}
