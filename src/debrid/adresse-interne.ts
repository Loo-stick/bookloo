import { lookup } from 'node:dns/promises';

/**
 * Cette adresse IP appartient-elle au reseau interne ?
 *
 * Sert a refuser qu'un tracker fasse aller chercher un fichier chez un service prive : le
 * serveur le lirait, puis le televerserait chez le debrideur, ou il deviendrait lisible.
 *
 * ON NE JUGE QUE DES ADRESSES, jamais des noms : la resolution appartient a l'appelant, qui
 * doit verifier TOUTES les adresses rendues — un nom peut en avoir plusieurs, et une seule
 * interne suffit a refuser.
 */
export function adresseInterne(adresse: string): boolean {
  const a = String(adresse || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!a) return false;

  // IPv6, y compris les formes qui encapsulent une IPv4.
  if (a.includes(':')) {
    if (a === '::' || a === '::1') return true;
    // Lien-local (fe80::/10) et adresses uniques locales (fc00::/7).
    if (/^fe[89ab][0-9a-f]:/.test(a) || /^f[cd][0-9a-f]{2}:/.test(a)) return true;
    const v4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(a);
    return v4 ? adresseInterne(v4[1]) : false;
  }

  const o = a.split('.');
  if (o.length !== 4) return false;
  const n = o.map(Number);
  if (n.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return false;

  if (n[0] === 127 || n[0] === 0 || n[0] === 10) return true;
  // La plage privee s'arrete a 172.31 : la borner trop large refuserait des hotes publics.
  if (n[0] === 172 && n[1] >= 16 && n[1] <= 31) return true;
  if (n[0] === 192 && n[1] === 168) return true;
  // Lien-local, dont 169.254.169.254 : l'adresse des metadonnees chez la plupart des
  // hebergeurs, cible classique d'une SSRF parce qu'elle porte des jetons d'identite.
  if (n[0] === 169 && n[1] === 254) return true;
  // Reseau partage des operateurs (100.64.0.0/10), interne du point de vue de l'hote.
  if (n[0] === 100 && n[1] >= 64 && n[1] <= 127) return true;
  return false;
}


/**
 * Refuse une URL sortante qui menerait vers l'interne, ou qui n'est pas du web.
 *
 * TOUTES les adresses du nom sont verifiees : un nom peut en porter plusieurs, et laisser
 * passer parce que la premiere est publique reviendrait a ne rien verifier.
 *
 * Ce controle NE REMPLACE PAS `maxRedirects: 0` : sans lui, un hote public pourrait
 * rediriger vers l'interne apres coup. Les deux vont ensemble.
 */
export async function verifierUrlSortante(url: string): Promise<void> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error('adresse de telechargement invalide');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error(`schema ${u.protocol} refuse pour un telechargement`);
  }

  // Une adresse litterale se juge sans resolution.
  if (adresseInterne(u.hostname)) {
    throw new Error('adresse de telechargement interne, refusee');
  }

  let adresses;
  try {
    adresses = await lookup(u.hostname, { all: true });
  } catch {
    // Un nom qui ne se resout pas ne sera de toute facon pas joignable : on laisse la
    // requete echouer d'elle-meme plutot que d'inventer un motif.
    return;
  }
  if (adresses.some((a) => adresseInterne(a.address))) {
    throw new Error('adresse de telechargement interne, refusee');
  }
}
