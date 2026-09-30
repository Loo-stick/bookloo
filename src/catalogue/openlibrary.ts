// Catalogue Open Library, pour la famille Livres.
//
// POURQUOI PAS GOOGLE BOOKS. Sonde du 2026-08-24 : sans cle d'API, chaque appel depuis ce
// serveur rend « HTTP 429 — Quota exceeded », trois tirs sur trois. Les appelants non
// enregistres partagent un quota par IP deja epuise. Google Books coutait donc une cle de
// plus a creer et a faire tourner. Open Library n'en demande aucune.
//
// LE PIEGE, ET SA PARADE. L'API rend le titre CANONIQUE de l'oeuvre, presque toujours
// anglais : « It » pour « Ça », « A Game of Thrones » pour « Le Trone de fer ». Envoye tel
// quel a C411, ce titre ne rend rien. La parade tient dans deux parametres de la meme
// requete : `language=fre` filtre, et `editions.title` rend le titre de l'edition
// francaise. Une seule requete, et la bonne forme sort.
//
// LA SERIE N'EXISTE PAS ICI. Le champ `series` est vide sur tous les titres sondes, y
// compris Harry Potter et Le Trone de fer. Le catalogue ne saura donc jamais qu'un livre
// appartient a un cycle : les packs [INTEGRALE] des trackers restent du ressort de la
// recherche libre, dont le bouton ne bouge pas.

import { getJson } from '../core/http';
import { cached } from '../core/cache';
import { NON_LATIN, nettoyerForme, type Oeuvre } from './mangadex';
import type { ModeRecherche } from './types';

const BASE = 'https://openlibrary.org';
const TTL_RECHERCHE_MS = 6 * 60 * 60 * 1000;
const TTL_FICHE_MS = 24 * 60 * 60 * 1000;
// Deux plafonds, parce que ce sont deux choses differentes. Une recherche par titre est
// classee par pertinence : au-dela de vingt, on lit du bruit. Une bibliographie d'auteur
// est une LISTE — la tronquer, c'est perdre des livres. Stephen King en compte 127 chez
// Open Library.
const MAX_TITRE = 20;
const MAX_AUTEUR = 100;

// Open Library demande un agent identifiable, et le documente.
// L'ADRESSE DU PROJET, PAS CELLE D'UNE INSTALLATION. Open Library demande un
// User-Agent joignable ; le precedent annoncait le domaine de l'auteur, ce qui aurait
// fait se reclamer de lui chaque personne qui s'auto-heberge — et ce domaine n'existe
// plus depuis le renommage.
const ENTETES = { 'User-Agent': 'Bookloo/1.0 (+https://github.com/Loo-stick/bookloo)' };

// Les editions sont demandees explicitement : sans elles, seul le titre anglais remonte.
const CHAMPS = [
  'key', 'title', 'author_name', 'first_publish_year', 'cover_i',
  'editions', 'editions.title', 'editions.cover_i',
].join(',');

interface DocOl {
  key?: string;
  title?: string;
  author_name?: string[];
  first_publish_year?: number;
  cover_i?: number;
  editions?: { docs?: { title?: string; cover_i?: number }[] };
}

function couverture(id: number | undefined): string | undefined {
  return typeof id === 'number' && id > 0
    ? `https://covers.openlibrary.org/b/id/${id}-M.jpg`
    : undefined;
}

/**
 * Convertit un doc de recherche en `Oeuvre`. PUR, donc testable sans reseau.
 *
 * Rend `null` plutot que de jeter : un doc abime dans une liste de vingt ne doit pas
 * faire echouer toute la recherche.
 */
export function normaliserDoc(brut: unknown): Oeuvre | null {
  const d = brut as DocOl | null;
  if (!d || typeof d !== 'object') return null;

  // `key` vaut « /works/OL81613W ». Prefixee telle quelle, l'identite porterait deux
  // barres obliques a travers une URL et une colonne de base.
  const id = typeof d.key === 'string' ? d.key.replace(/^\/works\//, '').trim() : '';
  const titreOeuvre = typeof d.title === 'string' ? d.title.trim() : '';
  if (!id || !titreOeuvre) return null;

  const editions = Array.isArray(d.editions?.docs) ? d.editions!.docs! : [];
  const titresEdition: string[] = [];
  for (const e of editions) {
    const t = typeof e?.title === 'string' ? e.title.trim() : '';
    if (t && !titresEdition.includes(t)) titresEdition.push(t);
  }

  // L'edition francaise d'abord : c'est le titre sous lequel le livre circule ici, et
  // celui que portent les noms de release.
  const titre = titresEdition[0] || titreOeuvre;
  const titres = [...new Set([...titresEdition, titreOeuvre])];

  const formes: string[] = [];
  const vues = new Set<string>();
  for (const t of titres) {
    // Aucun tracker francais n'indexe « 三体 ». La forme reste affichable, elle n'est
    // simplement pas envoyee.
    if (NON_LATIN.test(t)) continue;
    const forme = nettoyerForme(t);
    if (!forme) continue;
    const cle = forme.toLowerCase();
    if (vues.has(cle)) continue;
    vues.add(cle);
    formes.push(forme);
  }

  const annee = Number(d.first_publish_year);

  return {
    id,
    titre,
    titres,
    formes,
    auteur: d.author_name?.[0]?.trim() || undefined,
    annee: Number.isFinite(annee) && annee > 0 ? annee : undefined,
    // La jaquette de l'edition francaise, pas celle de l'edition americaine.
    couverture: couverture(editions.find((e) => e?.cover_i)?.cover_i) ?? couverture(d.cover_i),
  };
}

function urlRecherche(params: Record<string, string>): string {
  const qs = new URLSearchParams({ ...params, language: 'fre', fields: CHAMPS });
  return `${BASE}/search.json?${qs.toString()}`;
}

export async function chercherOpenlibrary(
  q: string, mode: ModeRecherche = 'titre', signal?: AbortSignal,
): Promise<Oeuvre[]> {
  const requete = q.trim();
  if (!requete) return [];
  // `author=` est un champ a part, et pas seulement plus juste : 631 ms contre 1521 ms
  // pour la meme requete passee en texte libre.
  const auteur = mode === 'auteur';
  const params: Record<string, string> = { limit: String(auteur ? MAX_AUTEUR : MAX_TITRE) };
  params[auteur ? 'author' : 'q'] = requete;
  const corps = await cached<unknown>(
    `openlibrary:${mode}:${requete.toLowerCase()}`,
    TTL_RECHERCHE_MS,
    () =>
      getJson<unknown>(urlRecherche(params), {
        timeoutMs: 10000, signal, retries: 1, headers: ENTETES,
      }),
    { scope: 'openlibrary', echec: (v) => v === null, shouldCache: (v) => v !== null },
  );
  // `null` signale un ECHEC, jamais un resultat vide : la distinction remonte jusqu'a
  // l'interface, ou « vide » et « n'a pas repondu » ne disent pas la meme chose.
  if (corps === null) throw new Error('Open Library n a pas repondu');
  const docs = (corps as { docs?: unknown })?.docs;
  if (!Array.isArray(docs)) return [];
  return docs.map(normaliserDoc).filter((o): o is Oeuvre => o !== null);
}

/** Le synopsis, quand il existe. En ANGLAIS : Open Library ne le tient qu'au niveau de
 *  l'oeuvre, jamais par edition. Un synopsis anglais vaut mieux qu'une fiche nue. */
function lireSynopsis(brut: unknown): string | undefined {
  const d = (brut as { description?: unknown })?.description;
  const texte = typeof d === 'string' ? d : (d as { value?: unknown })?.value;
  if (typeof texte !== 'string') return undefined;
  return texte.replace(/\r/g, '').replace(/\n{2,}/g, '\n').trim() || undefined;
}

export async function ficheOpenlibrary(id: string, signal?: AbortSignal): Promise<Oeuvre | null> {
  // Une cle d'oeuvre s'ecrit « OL81613W ». Tout le reste est refuse avant d'atteindre le
  // reseau : l'identite voyage dans un chemin d'URL.
  if (!/^OL\d+W$/i.test(id)) return null;

  // DEUX APPELS, ET PAS TROIS. La liste des editions d'une oeuvre se pagine par cent :
  // Harry Potter tome 1 en compte 399, dont une seule francaise — absente des cent
  // premieres neuf fois sur dix. La recherche ciblee sur la cle laisse Open Library
  // faire ce tri lui-meme, en une requete.
  const [corps, oeuvre] = await Promise.all([
    cached<unknown>(
      `openlibrary:fiche:${id}`,
      TTL_FICHE_MS,
      () => getJson<unknown>(urlRecherche({ q: `key:/works/${id}`, limit: '1' }), {
        timeoutMs: 10000, signal, retries: 1, headers: ENTETES,
      }),
      { scope: 'openlibrary', echec: (v) => v === null, shouldCache: (v) => v !== null },
    ),
    cached<unknown>(
      `openlibrary:synopsis:${id}`,
      TTL_FICHE_MS,
      () => getJson<unknown>(`${BASE}/works/${id}.json`, {
        timeoutMs: 10000, signal, retries: 1, headers: ENTETES,
      }),
      { scope: 'openlibrary', echec: (v) => v === null, shouldCache: (v) => v !== null },
    ),
  ]);

  const docs = (corps as { docs?: unknown })?.docs;
  const o = Array.isArray(docs) ? normaliserDoc(docs[0]) : null;
  if (!o) return null;
  // Le synopsis manquant n'empeche pas la fiche : il est absent d'une oeuvre sur deux.
  return { ...o, synopsis: lireSynopsis(oeuvre) };
}
