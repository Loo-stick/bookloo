// 1001ebooks — un catalogue de romans et de presse, cherche dans son propre inventaire.
//
// CE QU'ELLE APPORTE, mesure du 2026-09-08 : 43 528 livres et 3 973 numeros de presse
// repartis sur 888 periodiques — L'Equipe, Le Parisien, Mediapart, Le Figaro, Elle. C'est
// la source de presse la plus fournie du projet.
//
// CE QU'ELLE N'APPORTE PAS, et le dire evite d'y revenir : aucun manga, aucun comics.
// Elle ne sert donc que Livres et Presse.
//
// ELLE NE LIVRE PAS LE FICHIER, ET C'EST ASSUME. Le telechargement passe par un guichet
// sur un domaine compagnon, avec un quota gratuit et une offre payante. L'application
// n'essaie donc pas de l'ouvrir : elle donne l'ADRESSE PUBLIQUE de la fiche, et c'est le
// navigateur de l'utilisateur qui va la chercher — le meme choix que « Ouvrir dans
// Telegram », pour la meme raison : les octets n'ont rien a faire sur ce serveur.
//
// Sa recherche est fermee aux automates par son `robots.txt` ; on cherche dans l'index
// bati sur ses sitemaps. Voir `1001ebooks-fiches.ts`.

import { parseRelease } from '../torrent/release';
import type { Candidate, Query, SearchContext, Source } from '../types';
import { identiteDdl } from './wawacity';
import type { LienDdl } from './wawacity';
import {
  categoriesDeFamille, motsDemandes, titreDuSlug, urlFiche,
} from './1001ebooks-fiches';
import { assurerIndex, chercherIndex } from './1001ebooks-index';

const MAX_RESULTATS = 40;

/** `romans__stephen-king-shining` — le souligne double, qu'aucun slug ne porte. */
export function idMille(categorie: string, slug: string): string {
  return `${categorie}__${slug}`;
}

/** L'inverse. Le decoupage se fait au PREMIER separateur : un slug peut en contenir. */
export function decouperIdMille(id: string): { categorie: string; slug: string } | null {
  const s = String(id || '');
  const i = s.indexOf('__');
  if (i <= 0) return null;
  const categorie = s.slice(0, i);
  const slug = s.slice(i + 2);
  return slug ? { categorie, slug } : null;
}

/**
 * « Ouvrir » sur une fiche 1001ebooks rend son adresse publique, et rien d'autre.
 *
 * Aucun debrideur ne connait ce site, et c'est tant mieux : l'interface retombe alors sur
 * la sortie qui existe deja pour ce cas — un bouton vers la page. On ne promet donc
 * jamais une lecture en ligne qu'on ne saurait pas tenir.
 */
export async function ouvrirFicheMille(id: string): Promise<LienDdl[] | null> {
  const d = decouperIdMille(id);
  if (!d) return null;
  return [{ hebergeur: '1001ebooks', url: urlFiche(d) }];
}

export function milleEbooksSource(): Source {
  return {
    id: '1001ebooks',
    label: '1001ebooks',

    async search(q: Query, ctx: SearchContext): Promise<Candidate[]> {
      const famille = ctx.famille?.id;
      if (!famille) return [];
      // Deux rayons, pas six : une famille que ce site ne sert pas repond VIDE tout de
      // suite, sans toucher a l'index.
      if (!categoriesDeFamille(famille).length) return [];

      const mots = motsDemandes(q.titres[0] || '');
      if (!mots.length) return [];

      // Echec, pas resultat vide : un index qui n'existe pas encore ne veut pas dire
      // « ce site ne connait pas cette oeuvre ». Meme regle que dans torznab.ts.
      if (!assurerIndex()) {
        throw new Error('1001ebooks : inventaire en cours de construction, reessayez dans une minute');
      }

      const fiches = chercherIndex(famille, mots, MAX_RESULTATS);
      return fiches.map((f) => {
        const titre = titreDuSlug(f.slug);
        const { tomes, langue, provenance } = parseRelease(titre);
        return {
          source: '1001ebooks',
          titre,
          identite: identiteDdl('1001ebooks', idMille(f.categorie, f.slug)),
          // L'ADRESSE PUBLIQUE, qui est tout ce que cette source promet.
          lienExterne: urlFiche(f),
          tomes,
          langue,
          // LE FORMAT N'EST PAS ANNONCE PAR L'INVENTAIRE. Le deviner depuis la categorie
          // — presse donc PDF — tiendrait sur deux fichiers observes et mentirait sur les
          // autres. On ne le sait pas, et on le dit.
          format: 'inconnu' as const,
          provenance,
        };
      });
    },
  };
}
