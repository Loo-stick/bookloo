// Corriger l'adresse d'une source, sans rebuild et sans redemarrage.
//
// POURQUOI CETTE ROUTE EXISTE. Les domaines de ces sites tournent — wawacity, zone-ebook,
// bookys, Z-Library en changent seuls, et Z-Library a deja son commentaire mesure :
// « z-library.ec, z-lib.gd et z-lib.gl repondent ; z-lib.fm, z-lib.sk et z-library.sk
// sont injoignables ». Jusqu'ici trois d'entre eux etaient ecrits EN DUR : les corriger
// demandait de reconstruire l'image.
//
// LES CLES NE PASSENT PAS PAR ICI. Une adresse est une donnee d'exploitation, partagee par
// tout le monde ; une passkey appartient a UNE personne et vit chiffree par sa DEK. Les
// melanger dans le meme ecran ferait ecrire un secret dans un fichier lisible.

import * as fs from 'fs';
import { Router } from 'express';
import { exigerConnexion, exigerAdmin, exigerCsrf } from '../auth/garde';
import { getSettings, rechargerSettings, cheminSettings } from '../core/settings';
import { adresseInterne } from '../debrid/adresse-interne';
import { tracer } from '../core/journal';

/**
 * Les adresses modifiables, et ou elles vivent dans les reglages.
 *
 * UNE TABLE, ET PAS UN CHEMIN LIBRE. Accepter n'importe quel chemin JSON laisserait un
 * admin ecrire `sources.c411 = "oui"` ou corrompre une categorie ; ici on ne peut toucher
 * qu'a ce qui est declare, et rien d'autre.
 */
export const ADRESSES: {
  id: string; libelle: string; chemin: string[]; interneAutorise?: boolean;
}[] = [
  { id: 'yggreborn', libelle: 'YggReborn', chemin: ['torznab', 'yggreborn', 'url'] },
  { id: 'c411', libelle: 'C411', chemin: ['torznab', 'c411', 'url'] },
  { id: 'tr4ker', libelle: 'Tr4ker', chemin: ['torznab', 'tr4ker', 'url'] },
  { id: 'v3x', libelle: 'V3X', chemin: ['torznab', 'v3x', 'url'] },
  { id: 'g3mini', libelle: 'Gemini', chemin: ['unit3d', 'g3mini', 'url'] },
  { id: 'nyaa', libelle: 'Nyaa', chemin: ['nyaa', 'url'] },
  { id: 'knaben', libelle: 'Knaben', chemin: ['knaben', 'url'] },
  { id: 'wawacity', libelle: 'Wawacity', chemin: ['ddl', 'wawacity', 'base'] },
  { id: 'zone-ebook', libelle: 'Zone-ebook', chemin: ['ddl', 'zoneEbook', 'base'] },
  { id: 'bookys', libelle: 'Bookys', chemin: ['ddl', 'bookys', 'base'] },
  { id: 'telegram', libelle: 'Facade Telegram', chemin: ['telegram', 'url'], interneAutorise: true },
  // FLARESOLVERR EST INTERNE PAR NATURE : il tourne a cote du serveur, souvent sur
  // `http://flaresolverr:8191`. Lui appliquer la garde anti-SSRF le rendrait
  // inconfigurable — c'est la seule exception, et elle est nommee.
  { id: 'flaresolverr', libelle: 'FlareSolverr', chemin: ['flaresolverr', 'url'], interneAutorise: true },
];

/** Z-Library ne porte qu'un DOMAINE, pas une URL : son champ se valide autrement. */
export const DOMAINE_ZLIB = { id: 'zlibrary', libelle: 'Z-Library', chemin: ['zlibrary', 'domaine'] };

function lire(objet: unknown, chemin: string[]): string {
  let n: unknown = objet;
  for (const c of chemin) n = (n as Record<string, unknown> | undefined)?.[c];
  return typeof n === 'string' ? n : '';
}

function poser(objet: Record<string, unknown>, chemin: string[], valeur: string): void {
  let n = objet;
  for (const c of chemin.slice(0, -1)) {
    if (typeof n[c] !== 'object' || n[c] === null) n[c] = {};
    n = n[c] as Record<string, unknown>;
  }
  n[chemin[chemin.length - 1]!] = valeur;
}

/**
 * Cette adresse est-elle acceptable ?
 *
 * `http(s)` SEULEMENT : un `file://` ferait lire le disque du serveur, un `gopher://`
 * parlerait a n'importe quel port. Et pas d'adresse interne, sauf pour les deux services
 * qui SONT internes — la meme garde que pour Rustatio, avec ses exceptions nommees.
 */
export function adresseValide(brut: string, interneAutorise = false): string | null {
  const valeur = String(brut ?? '').trim();
  if (!valeur) return 'adresse vide';
  let u: URL;
  try {
    u = new URL(valeur);
  } catch {
    return 'adresse illisible';
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'seuls http et https sont acceptes';
  if (!interneAutorise && adresseInterne(u.hostname)) return 'adresse interne refusee';
  return null;
}

/** Un domaine nu : « z-library.ec ». Ni schema, ni chemin, ni port. */
export function domaineValide(brut: string): string | null {
  const valeur = String(brut ?? '').trim();
  if (!valeur) return 'domaine vide';
  if (/[/\s:]/.test(valeur)) return 'un domaine seul est attendu, sans schema ni chemin';
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(valeur)) return 'domaine illisible';
  return null;
}

export function routesReglagesSources(): Router {
  const r = Router();

  r.get('/api/admin/adresses', exigerConnexion, exigerAdmin, (_req, res) => {
    const s = getSettings() as unknown as Record<string, unknown>;
    res.json({
      adresses: ADRESSES.map((a) => ({
        id: a.id, libelle: a.libelle, valeur: lire(s, a.chemin),
        actif: (getSettings().sources as Record<string, boolean>)[a.id] !== false,
        interneAutorise: Boolean(a.interneAutorise),
      })),
      zlibrary: { ...DOMAINE_ZLIB, valeur: getSettings().zlibrary.domaine },
      fichier: cheminSettings,
    });
  });

  r.put('/api/admin/adresses', exigerConnexion, exigerAdmin, exigerCsrf, (req, res) => {
    const corps = (req.body ?? {}) as Record<string, unknown>;
    const brut: Record<string, unknown> = fs.existsSync(cheminSettings)
      ? JSON.parse(fs.readFileSync(cheminSettings, 'utf-8') || '{}')
      : {};

    const refus: string[] = [];
    const ecrites: string[] = [];

    for (const a of ADRESSES) {
      if (!(a.id in corps)) continue;
      const valeur = String(corps[a.id] ?? '').trim();
      // UNE ADRESSE VIDE EFFACE LA CORRECTION plutot que d'ecrire du vide : le defaut du
      // code reprend la main, ce qui est la sortie de secours quand on s'est trompe.
      if (!valeur) {
        poser(brut, a.chemin, '');
        ecrites.push(a.id);
        continue;
      }
      const motif = adresseValide(valeur, a.interneAutorise);
      if (motif) { refus.push(`${a.libelle} : ${motif}`); continue; }
      poser(brut, a.chemin, valeur);
      ecrites.push(a.id);
    }

    if ('zlibrary' in corps) {
      const valeur = String(corps.zlibrary ?? '').trim();
      const motif = valeur ? domaineValide(valeur) : null;
      if (motif) refus.push(`Z-Library : ${motif}`);
      else { poser(brut, DOMAINE_ZLIB.chemin, valeur); ecrites.push('zlibrary'); }
    }

    if (refus.length) {
      // RIEN N'EST ECRIT SI QUELQUE CHOSE EST REFUSE. Un enregistrement a moitie fait
      // laisserait l'operateur devant un ecran dont il ne sait plus ce qu'il porte.
      res.status(400).json({ erreur: refus.join(' ; ') });
      return;
    }

    fs.writeFileSync(cheminSettings, `${JSON.stringify(brut, null, 2)}\n`, { mode: 0o600 });
    rechargerSettings();
    // L'HOTE SEULEMENT DANS LA TRACE : une URL de tracker porte la passkey.
    tracer('Reglages', `adresses mises a jour : ${ecrites.join(', ')}`);
    res.json({ ok: true, ecrites });
  });

  return r;
}
