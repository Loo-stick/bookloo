// Les vraies sources, comme kiosque : ce que TU peux lire, pas ce qui existe.
//
// POURQUOI CETTE SOURCE-CI EXISTE. « MangaDex c'est pas une de nos sources » — et c'etait
// exact. Un catalogue nomme les oeuvres ; une source livre des fichiers. « Vient de
// sortir » doit venir de celles qui livrent, sans quoi l'ecran montre ce qu'on ne peut
// pas ouvrir.
//
// ELLE REUTILISE LE FAN-OUT, elle ne le refait pas : les memes sources, les memes cles,
// les memes budgets, le meme ecart de source par famille.

import { toutesLesSources } from '../routes/releases';
import { clesDeRecherche } from '../auth/cles-utilisateur';
import { formatEcarte, sourceEcartee, type Famille } from '../familles/table';
import type { Candidate } from '../sources/types';
import type { ClesEnClair } from '../auth/cles-utilisateur';
import type { Entree, SourceKiosque } from './types';

const MAX = 30;
/** Chaque source a le sien : bookys passe par flaresolverr et met quinze secondes. */
const BUDGET_PAR_SOURCE_MS = 20_000;

/** Ce qu'une release devient dans le kiosque. Le titre brut : c'est lui qu'on reconnait. */
export function entreeDeCandidat(c: Candidate, famille: Famille): Entree {
  return {
    id: c.identite || c.hash || c.titre,
    titre: c.titre,
    source: c.source,
    // UNE RELEASE N'A PAS D'INSTANT FIABLE. Les trackers rendent une date de publication,
    // mais pas les sites DDL : afficher l'une et pas l'autre ferait croire a un ordre
    // chronologique qui n'existe qu'a moitie. L'ordre est celui des sources.
    quand: null,
    // « inconnue · inconnu » n'apprend rien et occupe la place de ce qui compte : on ne
    // dit que ce qu'on sait. Le format vaut « inconnu » quand le nom se tait, et la langue
    // « inconnue » — les deux se taisent alors aussi.
    detail: [c.langue, c.format]
      .filter((x) => x && x !== 'inconnu' && x !== 'inconnue')
      .join(' · ') || undefined,
    // PAS D'OEUVRE : `ddl:wawacity:123` et un hash de torrent designent des DEPOTS, pas
    // des titres de catalogue. Les poser ici faisait ouvrir `/oeuvre.html?id=ddl:…`, ou
    // aucun catalogue ne repond — « oeuvre introuvable ». Le clic cherche le titre.
    famille: famille.id,
  };
}

function avecBudget<T>(travail: Promise<T>, quoi: string): Promise<T> {
  return Promise.race([
    travail,
    new Promise<T>((_, rejeter) =>
      setTimeout(() => rejeter(new Error(`${quoi} n a pas repondu a temps`)),
        BUDGET_PAR_SOURCE_MS).unref(),
    ),
  ]);
}

/**
 * Le kiosque des sources, pour un utilisateur donne.
 *
 * FABRIQUE PAR APPEL, ET C'EST VOULU : les cles sont celles de la personne connectee, et
 * une source sans cle n'est pas interrogee. Une instance partagee aurait fige les cles du
 * premier venu.
 */
export function sourcesKiosque(cles: ClesEnClair, userId: number): SourceKiosque {
  return {
    id: 'sources',
    libelle: 'vos sources',
    // TOUTES LES FAMILLES : c'est `sourceEcartee` et les categories par famille qui
    // decident, source par source, comme sur la recherche.
    familles: ['mangas', 'comics', 'bd', 'livres', 'audio', 'presse'],

    async nouveautes(famille: Famille, signal?: AbortSignal): Promise<Entree[]> {
      const parcourables = toutesLesSources()
        .filter((s) => typeof s.dernieres === 'function')
        .filter((s) => !sourceEcartee(famille, s.id));
      if (parcourables.length === 0) return [];

      const ctx = { cles: clesDeRecherche(cles), famille, userId, signal };
      const lots = await Promise.all(parcourables.map(async (s) => {
        try {
          const lot = await avecBudget(s.dernieres!(ctx), s.label);
          // LE MEME FILTRE DE FORMAT QUE LA RECHERCHE, et il existait deja : un livre
          // audio n'a rien a faire dans le rayon Mangas. Ne pas l'appliquer ici a fait
          // remonter « Christian Jacq — Ramses, MP3 » sous les mangas. Signale a l'usage.
          return lot.filter((c) => !formatEcarte(famille, c.format));
        } catch {
          // UNE SOURCE QUI TOMBE N'EMPORTE PAS LES AUTRES. Son echec est trace par le
          // fan-out ; ici on garde ce que les autres ont rendu.
          return [] as Candidate[];
        }
      }));

      const parId = new Map<string, Entree>();
      // EN ALTERNANCE, PAS SOURCE PAR SOURCE. Concatener aurait donne trente entrees du
      // premier tracker et rien des autres : le rayon aurait montre un seul site.
      const files = lots.map((l) => l.map((c) => entreeDeCandidat(c, famille)));
      for (let rang = 0; parId.size < MAX; rang += 1) {
        let quelqueChose = false;
        for (const file of files) {
          const e = file[rang];
          if (!e) continue;
          quelqueChose = true;
          if (!parId.has(e.id)) parId.set(e.id, e);
          if (parId.size >= MAX) break;
        }
        if (!quelqueChose) break;
      }
      return [...parId.values()];
    },
  };
}
