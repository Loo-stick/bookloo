// Resolution des catalogues et des identites d'oeuvre.

import { chercherOeuvres, ficheOeuvre } from './mangadex';
import { chercherComicvine, ficheComicvine } from './comicvine';
import { chercherOpenlibrary, ficheOpenlibrary } from './openlibrary';
import { chercherBooknode, ficheBooknode } from './booknode';
import { PREFIXES, type Catalogue } from './types';

const MANGADEX: Catalogue = {
  id: 'mangadex',
  // MangaDex n'a pas de recherche par auteur : ses fiches portent l'auteur mais son
  // API ne l'indexe pas. Le mode est donc ignore, et c'est explicite.
  chercher: (q, _mode, signal) => chercherOeuvres(q, signal),
  fiche: (id, signal) => ficheOeuvre(id, signal),
};

const COMICVINE: Catalogue = {
  id: 'comicvine',
  chercher: (q, _mode, signal) => chercherComicvine(q, signal),
  fiche: (id, signal) => ficheComicvine(id, signal),
};

const OPENLIBRARY: Catalogue = {
  id: 'openlibrary',
  chercher: (q, mode, signal) => chercherOpenlibrary(q, mode, signal),
  fiche: (id, signal) => ficheOpenlibrary(id, signal),
};

const BOOKNODE: Catalogue = {
  id: 'booknode',
  chercher: (q, mode, signal) => chercherBooknode(q, mode, signal),
  fiche: (id, signal) => ficheBooknode(id, signal),
};

const PAR_ID: Record<string, Catalogue> = {
  mangadex: MANGADEX, comicvine: COMICVINE, openlibrary: OPENLIBRARY, booknode: BOOKNODE,
};

/** `null` est le cas NORMAL : livres et audio n'ont pas de catalogue. */
export function catalogueParId(id: string | null): Catalogue | null {
  if (!id) return null;
  return PAR_ID[id] ?? null;
}

// La liste des prefixes se lit DANS `PREFIXES`. Ecrite a la main, elle avait deja
// oublie un catalogue : une identite `ol:` serait tombee en « identite invalide » sans
// que rien ne signale pourquoi.
const MOTIF_IDENTITE = new RegExp(`^(${Object.values(PREFIXES).join('|')}):(.+)$`);

export function prefixerIdentite(catalogue: string, id: string): string {
  const p = PREFIXES[catalogue];
  return p ? `${p}:${id}` : id;
}

/**
 * Relit une identite d'oeuvre.
 *
 * Rend `null` sur tout ce qui n'est pas une identite de CATALOGUE — un hash de torrent,
 * une identite `ddl:` ou `tg:`, une identite `libre:`. Ces formes traversent le meme
 * pipeline, et les confondre enverrait une release chercher une fiche qui n'existe pas.
 */
export function lireIdentite(identite: string): { catalogue: string; id: string } | null {
  const m = MOTIF_IDENTITE.exec(identite || '');
  if (!m) return null;
  const catalogue = Object.keys(PREFIXES).find((k) => PREFIXES[k] === m[1]);
  return catalogue ? { catalogue, id: m[2] } : null;
}
