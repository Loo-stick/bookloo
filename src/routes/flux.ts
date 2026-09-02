// Resultats emis au fil de l'eau, en NDJSON.
//
// POURQUOI CE FICHIER EXISTE. Le fan-out attendait la source la plus lente avant de
// repondre : Nyaa rend en 0,4 s, une source en panne coute huit secondes de budget, et
// l'utilisateur regardait une page vide pendant tout ce temps. Ici chaque source part
// des qu'elle a fini.
//
// CE QUI RESTE AU SERVEUR, ET POURQUOI. Il serait tentant d'envoyer chaque source telle
// quelle et de laisser le navigateur dedoublonner et trier. Mais ces regles sont testees
// ici, et les dupliquer dans le client garantirait qu'elles divergent un jour. Le serveur
// n'emet donc que des AJOUTS — jamais un hash deja envoye — et des FUSIONS, qui corrigent
// une ligne deja affichee. Le tri voyage sous forme d'un simple `rang` numerique : le
// navigateur insere en ordre croissant sans rien comprendre a la regle.

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import { ecrivainNdjson } from '../core/flux';
import { interrogerSource } from '../core/fanout';
import { getSettings } from '../core/settings';
import { memoriserLien } from '../core/liens-torrent';
import { tracerErreur } from '../core/journal';
import { ficheOeuvre, requeteDepuisOeuvre, type Oeuvre } from '../catalogue/mangadex';
import { SEUIL_CERTAIN, scorer } from '../catalogue/rapprochement';
import { clesDeRecherche, clesEnClair } from '../auth/cles-utilisateur';
import { exigerConnexion, limiteurRecherche } from '../auth/garde';
import { sansSecret, toutesLesSources } from './releases';
import type { Candidate, Query, ResultatSource, Source } from '../sources/types';
import { compteAuRatio } from '../sources/ratio';
import { familleDemandee } from './famille';
import { sourceEcartee, formatEcarte, compteEnTomes, type Famille } from '../familles/table';
import { parutionDuNom } from '../presse/parution';
import { catalogueParId, lireIdentite } from '../catalogue';

export interface Fusion {
  hash: string;
  seeders?: number;
  source: string;
  aussiSur: string[];
}

export interface Lot {
  ajouts: Candidate[];
  fusions: Fusion[];
}

/**
 * Cle de tri : plus petit = plus haut dans la liste.
 *
 * La regle — plage de tomes la plus large, puis seeders — ne s'ecrit qu'ici.
 */
function rangDe(c: Candidate): number {
  const etendue = c.tomes ? (c.tomes.fin ?? c.tomes.debut) - c.tomes.debut + 1 : 0;
  return -(etendue * 1_000_000 + Math.min(c.seeders ?? 0, 999_999));
}

/**
 * Tient l'ensemble deja emis et rend, pour chaque source, ce qui est nouveau.
 *
 * Fonction pure : testee sans reseau ni base.
 */
/**
 * Garde-fou des correspondances INCERTAINES.
 *
 * DEUX RESERVOIRS, ET PAS UN — un resultat incertain ne doit JAMAIS evincer un resultat
 * certain. La regle reste, mais les deux plafonds sont desormais si hauts qu'aucune
 * recherche reelle ne les atteint : le client ne peignant plus rien avant qu'un filtre
 * soit choisi, un resultat de plus ne coute que quelques centaines d'octets.
 *
 * Ils restent la pour le jour ou une source derapera, et l'ordre reste le bon si ce jour
 * arrive.
 */
const MAX_INCERTAINES = 1000;

export function creerAccumulateur(
  oeuvre: Oeuvre | null,
  maxResultats = Infinity,
  maxIncertaines = MAX_INCERTAINES,
) {
  const parHash = new Map<string, Candidate>();
  let emisCertains = 0;
  let emisIncertains = 0;

  /**
   * Le candidat tient-il dans son reservoir ?
   *
   * `certain === undefined` en recherche libre : sans fiche, il n'y a rien a rapprocher,
   * et tout va dans le reservoir principal.
   */
  const place = (c: Candidate): boolean =>
    c.certain === false ? emisIncertains < maxIncertaines : emisCertains < maxResultats;

  const compter = (c: Candidate): void => {
    if (c.certain === false) emisIncertains++;
    else emisCertains++;
  };

  return {
    absorber(candidats: Candidate[]): Lot {
      const ajouts: Candidate[] = [];
      const fusions: Fusion[] = [];

      for (const brut of candidats) {
        // `continue` et NON `break` : un reservoir plein n'arrete pas la lecture. Le
        // candidat suivant est peut-etre certain, et sa place l'attend.
        const existant = brut.hash ? parHash.get(brut.hash) : undefined;

        if (!existant) {
          // Le rapprochement doit etre calcule AVANT de decider : c'est lui qui dit dans
          // quel reservoir le candidat compte.
          const pret = preparer(brut, oeuvre);
          if (!place(pret)) continue;
          if (brut.hash) parHash.set(brut.hash, pret);
          ajouts.push(pret);
          compter(pret);
          continue;
        }

        // Deja affiche : on corrige la ligne au lieu d'en ajouter une seconde.
        const meilleur = (brut.seeders ?? 0) > (existant.seeders ?? 0);
        const sources = new Set([...(existant.aussiSur ?? []), existant.source, brut.source]);
        const gagnante = meilleur ? brut.source : existant.source;
        sources.delete(gagnante);

        existant.seeders = meilleur ? brut.seeders : existant.seeders;
        existant.source = gagnante;
        existant.aussiSur = [...sources];
        existant.rang = rangDe(existant);

        fusions.push({
          hash: brut.hash!,
          seeders: existant.seeders,
          source: existant.source,
          aussiSur: existant.aussiSur,
        });
      }

      return { ajouts, fusions };
    },
  };
}

/**
 * Un ISBN en commun entre la fiche et le candidat.
 *
 * C'est la seule preuve EXACTE dont on dispose : deux livres qui partagent un ISBN sont
 * le meme livre, quels que soient leurs titres. Tout le reste — titre, auteur, annee —
 * n'est qu'une ressemblance.
 */
function memeIsbn(oeuvre: Oeuvre, c: Candidate): boolean {
  if (!oeuvre.isbns?.length || !c.isbns?.length) return false;
  const connus = new Set(oeuvre.isbns);
  return c.isbns.some((x) => connus.has(x));
}

function preparer(brut: Candidate, oeuvre: Oeuvre | null): Candidate {
  // `sansSecret` retire l'URL du .torrent : elle porte la passkey du tracker et ne doit
  // jamais atteindre le navigateur.
  const c = sansSecret({ ...brut });
  if (oeuvre) {
    // L'ISBN L'EMPORTE SUR LE TITRE, et il le doit. Une fiche « Holly Gibney, Tome 1 :
    // L'Outsider » et un fichier « L'Outsider » ne se ressemblent pas assez pour passer
    // le seuil, alors qu'ils partagent un ISBN : c'est le meme livre, et le classer en
    // « correspondance incertaine » le cachait dans un bloc replie.
    //
    // L'inverse n'est jamais vrai : un ISBN qui ne recoupe pas ne PROUVE rien — les
    // catalogues n'ont pas les memes editions — donc on retombe sur le titre au lieu
    // d'ecarter.
    c.score = memeIsbn(oeuvre, c) ? 1 : scorer(oeuvre, c.titre);
    c.certain = c.score >= SEUIL_CERTAIN;
  }
  c.rang = rangDe(c);
  return c;
}

/** Rend les resultats DANS L'ORDRE OU ILS ARRIVENT, pas dans celui du tableau. */
async function* auFilDeLEau<T>(promesses: Promise<T>[]): AsyncGenerator<T> {
  const restants = new Map(promesses.map((p, i) => [i, p.then((v) => ({ i, v }))]));
  while (restants.size > 0) {
    const { i, v } = await Promise.race(restants.values());
    restants.delete(i);
    yield v;
  }
}

async function diffuser(
  db: Database,
  req: Parameters<Parameters<Router['get']>[1]>[0],
  res: Parameters<Parameters<Router['get']>[1]>[1],
  oeuvre: Oeuvre | null,
  q: Query,
  famille: Famille,
): Promise<void> {
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Accel-Buffering', 'no');

  const ecrivain = ecrivainNdjson(res);
  const settings = getSettings();
  // Les sources ECARTEES par la famille ne sont pas seulement muettes : elles ne doivent
  // pas afficher de pastille non plus. Une pastille « Ygg : vide » sur une recherche
  // d'audiobook laisserait croire qu'Ygg a cherche et n'a rien trouve, alors qu'il n'a
  // meme pas de categorie pour ca.
  const sources = toutesLesSources().filter((s) => !sourceEcartee(famille, s.id));
  const session = req.session!;
  const cles = clesEnClair(db, session.userId, session.dek);

  // Le budget dur ne bouge pas : une source en retard est abandonnee et le DIT.
  //
  // MAIS IL EST DESORMAIS PAR SOURCE, et non plus commun a toutes. Une source peut
  // declarer le sien quand son cout n'a rien a voir avec celui des autres : bookys passe
  // par un defi Cloudflare et met quatorze secondes la ou un tracker en met deux. Sous le
  // budget commun il arrivait systematiquement au bord, abandonne, avec une pastille
  // « echec » qui ne voulait pas dire qu'il n'avait rien.
  //
  // Cela ne retarde personne : les resultats partent AU FIL DE L'EAU, source par source.
  // Les trackers s'affichent en deux secondes comme avant, et la source lente complete la
  // liste quand elle arrive.
  const controleur = new AbortController();
  // Le client a ferme l'onglet : inutile de continuer a interroger des trackers.
  res.on('close', () => controleur.abort());
  const minuteurs: NodeJS.Timeout[] = [];

  /** Le signal d'une source : son propre budget, ou celui de tout le monde. */
  const signalPour = (s: Source): AbortSignal => {
    const propre = new AbortController();
    const minuteur = setTimeout(() => propre.abort(), s.budgetMs ?? settings.fanoutBudgetMs);
    minuteur.unref();
    minuteurs.push(minuteur);
    // La fermeture de l'onglet coupe TOUT, quel que soit le budget de chacun.
    if (controleur.signal.aborted) propre.abort();
    else controleur.signal.addEventListener('abort', () => propre.abort(), { once: true });
    return propre.signal;
  };

  try {
    await ecrivain.ecrire({ type: 'oeuvre', oeuvre });
    await ecrivain.ecrire({
      type: 'attente',
      // On envoie le cout UNE FOIS, avec la liste des sources : le client n'a alors
      // aucune regle a dupliquer, et la verite reste ici. Deux listes finiraient par
      // diverger, et c'est le compte de l'utilisateur qui paierait l'ecart.
      famille: famille.id,
      lisibleEnLigne: famille.lisibleEnLigne,
      sources: sources.map((s) => ({ id: s.id, label: s.label, ratio: compteAuRatio(s.id) })),
    });

    const accumulateur = creerAccumulateur(oeuvre, settings.maxResultats);
    const etats: { source: string; label: string; etat: string; n: number; retenus: number }[] = [];

    const travaux = sources.map((s) =>
      interrogerSource(
        s,
        q,
        { cles: clesDeRecherche(cles), famille, userId: req.session!.userId },
        controleur.signal,
      ),
    );

    for await (const r of auFilDeLEau<ResultatSource>(travaux)) {
      // Le tri par format est ICI, et pas dans le navigateur : filtre cote client, la
      // pastille de la source annoncerait des resultats qu'on refuse ensuite d'afficher.
      //
      // `n` reste ce que la source a rendu et `retenus` ce qui est affiche : l'ecart est
      // exactement ce que ces deux nombres existent pour dire.
      const gardes = r.candidats
        .filter((c) => !formatEcarte(famille, c.format))
        // UN NUMERO DE JOURNAL N'A PAS DE TOME. Le parseur de release lit le quantieme du
        // mois comme un volume — « 26 Aout 2026 » devenait le tome 26 — et l'etagere se
        // remplissait de tomes inexistants. On les retire ici, une fois, plutot que dans
        // chaque source.
        //
        // ET IL PORTE SA DATE A LA PLACE. C'est elle qui distingue deux numeros du meme
        // journal ; « Le.Journal.De.Spirou.N°4611.26.Août.2026.FR.[Pdf]-NOTAG » ne se
        // compare pas d'un coup d'oeil au suivant. La date brute voyage a cote du
        // libelle : elle seule se TRIE, « 2 septembre » venant apres « 26 aout ».
        .map((c) => {
          if (compteEnTomes(famille)) return c;
          const p = parutionDuNom(c.titre);
          return { ...c, tomes: undefined, parution: p?.libelle, paruLe: p?.date };
        });

      // L'URL du .torrent reste cote serveur, indexee par hash.
      // La cle est le hash quand on l'a, l'identite sinon. Une release sans empreinte
      // garde ainsi son lien cote serveur, ce qui permet de le calculer plus tard sur
      // demande — sans que l'URL, qui porte le jeton de l'utilisateur, atteigne jamais
      // le navigateur.
      for (const c of gardes) {
        const cle = c.hash || c.identite;
        if (cle) memoriserLien(session.userId, cle, c.torrentUrl, c.source, c.aussiSur);
      }

      const lot = accumulateur.absorber(gardes);
      // DEUX NOMBRES, ET PAS UN. `n` est ce que la source a rendu, `retenus` ce qui est
      // reellement affiche. Ils divergent des que le plafond global est atteint : une
      // source arrivee tard voit ses candidats ecartes en silence, et la pastille
      // annoncait « repondu (30) » a cote d'une liste ou elle n'avait pas une seule
      // carte. Le compteur avait raison, l'ecran mentait.
      etats.push({
        source: r.source, label: r.label, etat: r.etat,
        n: r.candidats.length, retenus: lot.ajouts.length,
      });

      // C'est cette attente qui applique la contre-pression : un client lent ralentit
      // le fan-out au lieu de faire gonfler un tampon.
      await ecrivain.ecrire({
        type: 'source',
        id: r.source,
        label: r.label,
        etat: r.etat,
        n: r.candidats.length,
        retenus: lot.ajouts.length,
        ajouts: lot.ajouts,
        fusions: lot.fusions,
      });
    }

    await ecrivain.ecrire({ type: 'fin', sources: etats });
  } catch (e) {
    tracerErreur('Flux', e);
    await ecrivain.ecrire({ type: 'erreur', erreur: 'la recherche s est interrompue' });
  } finally {
    for (const m of minuteurs) clearTimeout(m);
    ecrivain.terminer();
  }
}

export function routesFlux(db: Database): Router {
  const r = Router();

  r.get('/api/oeuvre/:id/releases/flux', exigerConnexion, limiteurRecherche, async (req, res) => {
    const famille = familleDemandee(req.query);
    if (!famille) {
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.end(`${JSON.stringify({ type: 'erreur', erreur: 'famille inconnue' })}\n`);
      return;
    }
    const ident = lireIdentite(String(req.params.id));
    const cat = ident ? catalogueParId(ident.catalogue) : null;
    const oeuvre = cat && ident ? await cat.fiche(ident.id) : null;
    if (!oeuvre) {
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.end(`${JSON.stringify({ type: 'erreur', erreur: 'oeuvre introuvable' })}\n`);
      return;
    }
    await diffuser(db, req, res, oeuvre, requeteDepuisOeuvre(oeuvre), famille);
  });

  r.get('/api/recherche-libre/flux', exigerConnexion, limiteurRecherche, async (req, res) => {
    const famille = familleDemandee(req.query);
    if (!famille) {
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.end(`${JSON.stringify({ type: 'erreur', erreur: 'famille inconnue' })}\n`);
      return;
    }
    const q = String(req.query.q ?? '').trim();
    if (!q) {
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.end(`${JSON.stringify({ type: 'erreur', erreur: 'recherche vide' })}\n`);
      return;
    }
    // UNE FICHE SYNTHETIQUE, POUR QUE LE RAPPROCHEMENT S'ALLUME.
    //
    // En passant `null`, la recherche libre n'appelait jamais `scorer` : `certain`
    // restait indefini et TOUT arrivait au meme niveau. Sur « Old Boy », cela remontait
    // quarante-neuf lignes dont la moitie ne contenait que « boy » — jusqu'a du spam
    // manifeste chez Knaben. Signale a l'usage.
    //
    // La fiche ne porte que le titre saisi : c'est tout ce dont `scorer` a besoin, avec
    // l'auteur quand il existe — et une recherche libre n'en a pas. Le score et le seuil
    // restent ceux du reste du site.
    const fiche = {
      id: `libre:${q}`, titre: q, titres: [q], formes: [q],
    } as unknown as Oeuvre;
    await diffuser(db, req, res, fiche, { titres: [q] }, famille);
  });

  return r;
}
