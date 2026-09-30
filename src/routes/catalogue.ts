import { Router } from 'express';
import { catalogueParId, lireIdentite, prefixerIdentite } from '../catalogue';
import { premierQuiRepond } from '../catalogue/repli';
import { exigerConnexion, limiteurRecherche } from '../auth/garde';
import { familleDemandee } from './famille';
import { FAMILLES } from '../familles/table';
import type { ModeRecherche } from '../catalogue/types';
import { getSettings } from '../core/settings';

/**
 * Familles a montrer, avec le nombre de sources qui les servent reellement.
 *
 * Une famille dont aucune source n'est active n'apparait PAS : meme regle que la source
 * Telegram sans facade configuree. Une boite qui ne peut rien chercher ne doit pas
 * s'afficher comme un reglage oublie.
 */
export function famillesVisibles(sourcesActives: Record<string, boolean>) {
  return FAMILLES.map((f) => ({
    id: f.id,
    libelle: f.libelle,
    catalogues: f.catalogues,
    lisibleEnLigne: f.lisibleEnLigne,
    sources: Object.keys(f.categories).filter((s) => sourcesActives[s] !== false).length,
  })).filter((f) => f.sources > 0);
}

export function routesCatalogue(): Router {
  const r = Router();

  r.get('/api/familles', exigerConnexion, (_req, res) => {
    res.json({ familles: famillesVisibles(getSettings().sources) });
  });

  r.get('/api/catalogue', exigerConnexion, limiteurRecherche, async (req, res) => {
    const famille = familleDemandee(req.query);
    if (!famille) { res.status(400).json({ erreur: 'famille inconnue' }); return; }

    if (famille.catalogues.length === 0) {
      // L'audio n'a pas de catalogue. Le client bascule sur la recherche libre — et le
      // dit, plutot que de rendre une liste vide qui passerait pour « cette oeuvre
      // n'existe pas ».
      res.json({ oeuvres: [], sansCatalogue: true });
      return;
    }

    const q = String(req.query.q ?? '').trim();
    if (!q) { res.json({ oeuvres: [] }); return; }
    const mode: ModeRecherche = req.query.mode === 'auteur' ? 'auteur' : 'titre';

    // LES CATALOGUES SONT ESSAYES DANS L'ORDRE, et le premier qui rend quelque chose
    // gagne. Booknode est du scraping derriere un pare-feu Cloudflare : le jour ou il
    // tombe, la famille Livres continue de fonctionner avec Open Library au lieu de
    // s'eteindre. Aucune fusion des deux : melanger deux sources donnerait des doublons
    // que rien ne saurait rapprocher, leurs identifiants n'ayant rien en commun.
    const repli = await premierQuiRepond(
      famille.catalogues
        .map((id) => catalogueParId(id))
        .filter((c): c is NonNullable<typeof c> => c !== null)
        .map((c) => ({ id: c.id, chercher: () => c.chercher(q, mode) })),
    );

    // AUCUN catalogue n'a repondu. Rendre une liste vide ferait ecrire « ce catalogue ne
    // connait pas ce titre » — un diagnostic faux, et le seul que l'utilisateur verrait.
    if (repli === null) {
      res.status(502).json({
        erreur: 'aucun catalogue n a repondu — le service est peut-etre indisponible, '
          + 'reessayez dans un moment ou passez par la recherche libre',
      });
      return;
    }

    // L'identite porte son catalogue. C'est elle que la bibliotheque memorise, et elle
    // doit dire d'ou vient la fiche : le repli change de service en cours de route.
    const repondeur = repli.catalogue ?? famille.catalogues[0];
    res.json({
      catalogue: repondeur,
      oeuvres: repli.oeuvres.map((o) => ({ ...o, id: prefixerIdentite(repondeur, o.id) })),
    });
  });

  r.get('/api/oeuvre/:id', exigerConnexion, async (req, res) => {
    const ident = lireIdentite(String(req.params.id));
    if (!ident) { res.status(400).json({ erreur: 'identite d oeuvre invalide' }); return; }
    const cat = catalogueParId(ident.catalogue);
    const o = cat ? await cat.fiche(ident.id) : null;
    if (!o) { res.status(404).json({ erreur: 'oeuvre introuvable' }); return; }
    res.json({ ...o, id: String(req.params.id) });
  });

  return r;
}
