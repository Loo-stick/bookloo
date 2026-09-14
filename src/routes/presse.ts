// Le kiosque de presse, EN FLUX.
//
// POURQUOI UN FLUX PLUTOT QU'UNE REPONSE. Mesure du 2026-08-31 : Wawacity et zone-ebook
// rendent leur rubrique en moins d'une seconde, bookys en quatorze a dix-sept — c'est le
// cout du defi Cloudflare, et il se paie a chaud aussi. Les attendre ensemble ferait
// patienter quinze secondes devant un ecran vide pour des numeros deja disponibles ; un
// budget commun assez court pour les deux rapides exclurait bookys a chaque fois.
//
// Chaque site part donc avec SON budget, et sa ligne est ecrite des qu'il repond.

import { Router } from 'express';
import { exigerConnexion } from '../auth/garde';
import { ecrivainNdjson } from '../core/flux';
import { tracer } from '../core/journal';
import { KIOSQUES } from '../presse';
import { categoriesBookys, numerosDeCategorie } from '../presse/bookys';
import { RUBRIQUES, type IdSite, type Rubrique } from '../presse/types';
import type { Database } from 'better-sqlite3';
import { clesEnClair } from '../auth/cles-utilisateur';

/**
 * Un budget PAR SITE : voir l'en-tete.
 *
 * Celui de bookys couvre DEUX pages a quatorze secondes, plus la marge du defi Cloudflare
 * quand la session flaresolverr est froide.
 */
export const BUDGETS_MS: Record<IdSite, number> = {
  wawacity: 12_000,
  'zone-ebook': 12_000,
  bookys: 60_000,
};

/** Les rubriques ou rien. Jamais de rubrique par defaut : on n'interroge pas au hasard. */
export function rubriqueValide(brut: unknown): Rubrique | null {
  const v = String(brut ?? '');
  return (RUBRIQUES as string[]).includes(v) ? (v as Rubrique) : null;
}

/**
 * Les chemins de categorie que bookys sert, et EUX SEULS.
 *
 * `bandes-dessinees` en est SORTI : une revue de BD, de comics ou de manga n'est pas de la
 * presse, et l'application a deja un rayon pour chacune — avec son catalogue et son
 * rapprochement par tome. L'afficher ici la noyait parmi les journaux.
 */
const CHEMINS_CATEGORIE = new Set(['journaux', 'magazines']);

/**
 * Relit « rubrique/slug ».
 *
 * LA VALIDATION EST LA POUR QUE L'URL CONSTRUITE NE PUISSE PAS DESIGNER AUTRE CHOSE. Le
 * slug vient du navigateur, et il est concatene dans une adresse : sans ce filtre, un
 * « journaux/../../etc » sortirait du site.
 */
export function categorieValide(brut: unknown): { rubrique: string; slug: string } | null {
  const m = /^([a-z-]+)\/([a-z][a-z0-9-]*)$/.exec(String(brut ?? ''));
  if (!m || !CHEMINS_CATEGORIE.has(m[1])) return null;
  return { rubrique: m[1], slug: m[2] };
}

function avecBudget<T>(travail: Promise<T>, budget: number, quoi: string): Promise<T> {
  return Promise.race([
    travail,
    new Promise<T>((_, rejeter) =>
      setTimeout(() => rejeter(new Error(`${quoi} n a pas repondu a temps`)), budget).unref(),
    ),
  ]);
}

export function routesPresse(db: Database): Router {
  const r = Router();

  r.get('/api/presse/flux', exigerConnexion, async (req, res) => {
    // UNE RECHERCHE TRAVERSE LES DEUX RUBRIQUES : parcourir suffit pour « qu'est-ce qui
    // est paru cette semaine », pas pour « je veux les Cahiers du Cinema » — un mensuel
    // sort du kiosque en trois jours. La rubrique de chaque resultat se lit alors dans le
    // resultat lui-meme.
    const terme = String(req.query.q ?? '').trim();
    const rubrique = terme ? null : rubriqueValide(req.query.rubrique);
    if (!terme && !rubrique) {
      res.status(400).json({ erreur: 'rubrique inconnue' });
      return;
    }
    const categorie = req.query.categorie === undefined
      ? null
      : categorieValide(req.query.categorie);
    if (req.query.categorie !== undefined && !categorie) {
      res.status(400).json({ erreur: 'categorie inconnue' });
      return;
    }

    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Accel-Buffering', 'no');
    const ecrivain = ecrivainNdjson(res);

    // UNE CATEGORIE N'EXISTE QUE CHEZ BOOKYS : on n'interroge que lui, et l'interface le
    // dit deja en toutes lettres. Interroger les trois rendrait un melange ou deux sites
    // ignoreraient le filtre demande.
    const travaux = categorie
      ? [{
        id: 'bookys' as IdSite,
        libelle: 'bookys',
        // Une categorie n'est jamais une recherche : bookys y repond toujours.
        etat: undefined as 'sans-recherche' | undefined,
        promesse: numerosDeCategorie(categorie.rubrique, categorie.slug),
      }]
      : KIOSQUES.map((k) => ({
        id: k.id,
        libelle: k.libelle,
        // Un site qui ne sait pas chercher n'est pas interroge, et sa pastille le dit.
        // L'interroger quand meme rendrait ses derniers parus, qui s'afficheraient comme
        // des resultats de recherche.
        etat: terme && !k.chercheable ? ('sans-recherche' as const) : undefined,
        // LE CONTEXTE N'EST FABRIQUE QUE POUR UNE RECHERCHE. Parcourir les dernieres
        // parutions ne demande aucun compte, et dechiffrer les cles a chaque visite du
        // kiosque ferait payer un travail dont personne n'a besoin.
        promesse: terme
          ? k.chercher(terme, { userId: req.session!.userId, cles: clesEnClair(db, req.session!.userId, req.session!.dek) })
          : k.dernieres(rubrique as Rubrique),
      }));

    await Promise.all(
      travaux.map(async ({ id, libelle, promesse, etat }) => {
        if (etat === 'sans-recherche') {
          await ecrivain.ecrire({ type: 'site', site: id, libelle, etat, numeros: [] });
          return;
        }
        try {
          const numeros = await avecBudget(promesse, BUDGETS_MS[id], libelle);
          await ecrivain.ecrire({ type: 'site', site: id, libelle, etat: 'repondu', numeros });
        } catch (e) {
          // UN SITE QUI TOMBE NE VIDE PAS LE KIOSQUE. Sa pastille dit « n'a pas repondu »,
          // ce qui ne veut pas dire « rien n'est paru » — meme distinction que pour les
          // catalogues, et pour la meme raison.
          tracer('Presse', `${libelle} : ${(e as Error).message}`);
          await ecrivain.ecrire({ type: 'site', site: id, libelle, etat: 'echec', numeros: [] });
        }
      }),
    );

    await ecrivain.ecrire({ type: 'fin' });
    ecrivain.terminer();
  });

  r.get('/api/presse/categories', exigerConnexion, async (_req, res) => {
    try {
      // Lues dans la page des derniers journaux, DEJA en cache pour la rubrique : cet
      // appel ne coute rien tant que le cache tient.
      res.json({ categories: await categoriesBookys() });
    } catch (e) {
      tracer('Presse', `categories : ${(e as Error).message}`);
      res.status(502).json({ erreur: 'les categories n ont pas pu etre lues' });
    }
  });

  return r;
}
