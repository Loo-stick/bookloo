// Comics Tracker comme source du rayon Comics.
//
// CE QUE LE SITE EST, mesure du 2026-09-16 : un catalogue de comics americains en EDITIONS
// FRANCAISES — albums DC et Marvel, collections type DC Black Label. Sa recherche est
// publique et sait filtrer le francais (`scope=vf`) ; ses fichiers, eux, ne sont servis
// qu'a ses membres. « Asterix » y rend zero resultat : ce n'est pas de la bande dessinee
// franco-belge, et ce rayon-la n'a donc rien a y gagner.
//
// UN COMPTE EST EXIGE MEME POUR CHERCHER — `cleRequise` — alors que l'API repondrait sans.
// Afficher des resultats qu'on ne pourra pas ouvrir n'aide personne : le fan-out ecarte la
// source tant que le mot de passe n'est pas enregistre.
//
// UNE EDITION EST UN FICHIER UNIQUE, qui contient plusieurs numeros — 5 pour « Batman:
// Ego », et sa fiche donne meme la page ou chacun commence. Un candidat vaut donc une
// edition, pas un numero.

import { getJson } from '../../core/http';
import { tracerAppel, hoteDe } from '../../core/journal';
import { cached } from '../../core/cache';
import type { Candidate, Query, SearchContext, Source } from '../types';
import { editionsDeLaRecherche, identiteCt, urlRechercheCt, type EditionCt } from './recherche';

const TTL_MS = 30 * 60 * 1000;
const TTL_VIDE_MS = 10 * 60 * 1000;
const MAX_RESULTATS = 60;

/** Le seul rayon que ce site sert. Voir la note en tete. */
const FAMILLES = new Set(['comics']);

/**
 * Le candidat d'une edition.
 *
 * LE FORMAT N'EST PAS CONNU ICI, et l'annoncer serait faux : le site melange les formes.
 * Mesure du 2026-09-16 — « Batman: Ego » est un CBZ de 200 Mo, « Batman Rebirth n°23 » un
 * RAR de 228 Mo. La recherche n'en dit rien ; c'est la sonde, qui lit les premiers octets
 * avant de proposer « Lire », qui tranche.
 *
 * LA TAILLE N'EST PAS ANNONCEE par la recherche. Elle apparait a l'ouverture, quand Drive
 * la dit. L'inventer serait pire que se taire.
 */
export function candidatCt(e: EditionCt): Candidate {
  const auteurs = e.auteurs.slice(0, 3).join(', ');
  return {
    source: 'comics-tracker',
    titre: e.titre,
    identite: identiteCt(e.id),
    langue: 'FR',
    format: 'inconnu',
    // L'EDITION A COTE DU TITRE, jamais dedans : voir `Candidate.edition`.
    edition: [e.periode, auteurs, e.genre === 'run' ? 'periode de serie' : '']
      .filter(Boolean).join(' · ') || undefined,
  };
}

export function comicsTrackerSource(): Source {
  return {
    id: 'comics-tracker',
    label: 'Comics Tracker',
    // Le mot de passe suffit a dire qu'un compte est configure : l'adresse seule n'ouvre rien.
    cleRequise: 'ct_mdp',

    async search(q: Query, ctx: SearchContext): Promise<Candidate[]> {
      if (!ctx.famille || !FAMILLES.has(ctx.famille.id)) return [];
      const terme = (q.titres[0] || '').trim();
      if (!terme) return [];

      const url = urlRechercheCt(terme, 1);
      const candidats = await cached<Candidate[] | null>(
        `comics-tracker:${terme.toLowerCase()}`,
        TTL_MS,
        async () => {
          const debut = Date.now();
          // La recherche est PUBLIQUE : aucun jeton ne part ici. Le compte ne sert qu'a ouvrir.
          const donnees = await getJson<unknown>(url, { timeoutMs: 8000, signal: ctx.signal });
          const editions = donnees ? editionsDeLaRecherche(donnees) : [];
          tracerAppel({
            source: 'comics-tracker', hote: hoteDe(url), statut: donnees ? 200 : null,
            duree: Date.now() - debut, resultats: editions.length, ok: Boolean(donnees),
          });
          return donnees ? editions.slice(0, MAX_RESULTATS).map(candidatCt) : null;
        },
        {
          scope: 'comics-tracker',
          echec: (v) => v === null,
          shouldCache: (v) => v !== null && v.length > 0,
          negativeTtlMs: TTL_VIDE_MS,
        },
      );
      // Echec, pas resultat vide : les confondre afficherait « rien » pendant une panne.
      if (candidats === null) throw new Error("Comics Tracker n'a pas repondu");
      return candidats;
    },
  };
}
