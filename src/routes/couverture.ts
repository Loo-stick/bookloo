// Relais des couvertures Booknode.
//
// POURQUOI CE RELAIS EXISTE. Le CDN de Booknode applique une protection contre le
// hotlinking, mesuree le 2026-08-24 : la MEME adresse rend 403 sans en-tete `Referer` et
// 200 avec `Referer: https://booknode.com/`. Le navigateur d'un utilisateur de Mangaloo
// enverra toujours l'adresse de Mangaloo — la couverture ne peut donc PAS etre pointee
// directement, quel que soit le reglage de la CSP. Ni `referrerpolicy="no-referrer"` :
// sans referent du tout, la reponse est 403 elle aussi.
//
// POURQUOI curl ET PAS LE CLIENT HTTP DU PROJET. Mesure du 2026-08-24 : axios, le
// `fetch` d'undici et `node:https` recoivent tous 403, avec exactement les memes
// en-tetes qui rendent 200 sous curl, en HTTP/1.1 comme en HTTP/2. Ce n'est donc ni le
// protocole ni les en-tetes : c'est l'empreinte TLS de Node, que Cloudflare reconnait.
// Aucun reglage d'en-tete ne contourne ca.
//
// CE N'EST PAS UN PROXY GENERAL, et il ne doit jamais le devenir. Un relais qui accepte
// une adresse quelconque laisse n'importe quel utilisateur connecte faire emettre des
// requetes par le serveur — vers un service interne, vers une adresse privee. L'adresse
// est donc validee contre UN hote et UN prefixe de chemin, les redirections sont
// refusees, et la taille est plafonnee.

import { Router } from 'express';
import { execFile } from 'node:child_process';
import {exigerConnexion, limiteurCouverture } from '../auth/garde';
import { typeReel } from './lecture';

const HOTE = 'cdn1.booknode.com';
const PREFIXE_CHEMIN = '/book_cover/';
const MAX_OCTETS = 4 * 1024 * 1024;
/** Une couverture ne change pas. Un jour de cache evite de relayer deux fois la meme. */
const CACHE_S = 24 * 60 * 60;

/**
 * L'adresse est-elle une couverture Booknode ? PURE, donc testable.
 *
 * Refuse tout le reste — c'est la seule chose qui separe ce relais d'un proxy ouvert.
 */
export function couvertureAutorisee(brut: string): URL | null {
  let u: URL;
  try { u = new URL(brut); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  if (u.hostname !== HOTE) return null;
  if (!u.pathname.startsWith(PREFIXE_CHEMIN)) return null;
  return u;
}

/** Adresse a poser dans une `Oeuvre` pour qu'elle passe par le relais. */
export function urlRelayee(couverture: string): string {
  return `/api/couverture?u=${encodeURIComponent(couverture)}`;
}

/**
 * Telecharge une couverture avec curl.
 *
 * `execFile` et NON `exec` : les arguments sont passes en tableau, sans shell. L'adresse
 * a deja ete validee, mais la faire traverser un shell rouvrirait la porte pour rien.
 *
 * On ne demande PAS son type a curl. `--write-out` melangerait le texte aux octets de
 * l'image, et il faudrait le redecouper a l'aveugle. Les octets disent le format mieux
 * qu'un en-tete — c'est deja la regle de la visionneuse, ou des planches nommees .png
 * contiennent du JPEG.
 */
function telecharger(url: string): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const args = [
      '--silent', '--show-error',
      // `--fail` : un 403 devient un code de sortie, pas une page HTML rendue comme
      // si c'etait une image.
      '--fail',
      '--max-redirs', '0',
      '--max-time', '10',
      '--max-filesize', String(MAX_OCTETS),
      // L'en-tete qui fait toute la difference : sans lui, 403.
      '--header', 'Referer: https://booknode.com/',
      '--header', 'User-Agent: Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      '--header', 'Accept: image/avif,image/webp,image/*,*/*;q=0.8',
      '--output', '-',
      url,
    ];
    execFile('curl', args, { encoding: 'buffer', maxBuffer: MAX_OCTETS, timeout: 12000 },
      (err, stdout) => resolve(err ? null : (stdout as unknown as Buffer)));
  });
}

export function routesCouverture(): Router {
  const r = Router();

  // LIMITE EN DEBIT. Chaque requete lance un process externe qui peut vivre douze
  // secondes : une page qui boucle sur des couvertures absentes en lance des centaines, et
  // cette machine a deja gele deux fois par la memoire.
  r.get('/api/couverture', exigerConnexion, limiteurCouverture, async (req, res) => {
    const u = couvertureAutorisee(String(req.query.u ?? ''));
    if (!u) { res.status(400).json({ erreur: 'adresse de couverture refusee' }); return; }

    const octets = await telecharger(u.toString());
    // Le type vient des OCTETS. Le CDN rend une page HTML quand il refuse : la relayer
    // la ferait passer pour une couverture cassee au lieu d'un echec.
    const type = octets ? typeReel(octets, u.pathname) : '';
    if (!octets || !type.startsWith('image/')) {
      res.status(502).json({ erreur: 'couverture indisponible' });
      return;
    }

    res.setHeader('Content-Type', type);
    res.setHeader('Cache-Control', `private, max-age=${CACHE_S}`);
    res.send(octets);
  });

  return r;
}
