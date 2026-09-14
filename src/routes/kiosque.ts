// Le kiosque : ce qui bouge dans un rayon, en flux.
//
// EN NDJSON, SOURCE PAR SOURCE, pour la meme raison que le kiosque de presse : les sources
// n'ont pas les memes latences, et faire attendre la plus rapide derriere la plus lente
// rendrait un ecran qui ne se remplit jamais.

import { Router } from 'express';
import { exigerConnexion } from '../auth/garde';
import { ecrivainNdjson } from '../core/flux';
import { tracer } from '../core/journal';
import {
  MOTIF_A_PARAITRE, MOTIFS_SECTION_ABSENTE, famillesDe, rayonParId, rayons, sourcesDe,
  sourcesPour, type Section,
} from '../tendances';
import { clesEnClair } from '../auth/cles-utilisateur';
import type { Database } from 'better-sqlite3';

/** Au-dela, la source est abandonnee et sa pastille le dit. */
const BUDGET_MS = 12_000;

function avecBudget<T>(travail: Promise<T>, budget: number, quoi: string): Promise<T> {
  return Promise.race([
    travail,
    new Promise<T>((_, rejeter) =>
      setTimeout(() => rejeter(new Error(`${quoi} n a pas repondu a temps`)), budget).unref(),
    ),
  ]);
}

export function routesKiosque(db: Database): Router {
  const r = Router();

  /** Les rayons de la vitrine, et lesquels sont servis. Sert a peindre les onglets. */
  r.get('/api/kiosque/rayons', exigerConnexion, (req, res) => {
    // LES RAYONS DEPENDENT DE SES CLES : un tracker sans passkey ne sert rien, et le dire
    // vaut mieux que promettre un rayon qui restera vide.
    const cles = clesEnClair(db, req.session!.userId, req.session!.dek);
    res.json({
      rayons: rayons(sourcesDe(cles, req.session!.userId)),
      motifAParaitre: MOTIF_A_PARAITRE,
    });
  });

  r.get('/api/kiosque/flux', exigerConnexion, async (req, res) => {
    // JAMAIS DE RAYON PAR DEFAUT : servir les mangas a qui demande un onglet inconnu
    // ferait lire des mangas comme des livres. La table des onglets decide, et elle seule.
    const rayon = rayonParId(req.query.rayon);
    if (!rayon) {
      res.status(400).type('application/x-ndjson');
      res.end(`${JSON.stringify({ type: 'erreur', erreur: 'rayon inconnu' })}\n`);
      return;
    }
    const familles = famillesDe(rayon);

    const ecrivain = ecrivainNdjson(res);
    const sections: Section[] = ['tendances', 'nouveautes'];
    const cles = clesEnClair(db, req.session!.userId, req.session!.dek);
    const toutes = sourcesDe(cles, req.session!.userId);

    // TOUTES LES SOURCES DE TOUTES LES SECTIONS EN PARALLELE. Une section n'attend pas
    // l'autre : les tendances arrivent souvent avant les parutions, et l'ecran se remplit
    // dans l'ordre ou les reponses viennent.
    // UNE SECTION SANS SOURCE LE DIT AVANT TOUTE ATTENTE. Sans cela elle disparaissait
    // simplement de l'ecran, ce qui se lit « c'est casse » et non « c'est en chantier ».
    // UN ONGLET PEUT REUNIR PLUSIEURS FAMILLES : la section est absente seulement si
    // AUCUNE d'elles n'a de source. Tester la premiere aurait tu les deux autres.
    const paires = sections.flatMap((section) => familles
      .filter((f) => sourcesPour(f, section, toutes).length > 0)
      .flatMap((f) => sourcesPour(f, section, toutes).map((s) => ({ section, famille: f, s }))));

    for (const section of sections) {
      if (!paires.some((x) => x.section === section)) {
        // eslint-disable-next-line no-await-in-loop
        await ecrivain.ecrire({
          type: 'section-absente', section, motif: MOTIFS_SECTION_ABSENTE[section],
        });
      }
    }

    const travaux = paires.map(async ({ section, famille, s }) => {
        try {
          const entrees = await avecBudget(s[section]!(famille), BUDGET_MS, s.libelle);
          await ecrivain.ecrire({
            type: 'section', section, source: s.id, libelle: s.libelle, etat: 'repondu', entrees,
          });
        } catch (e) {
          // UNE SOURCE QUI TOMBE NE VIDE PAS LE RAYON. Sa pastille dit « n'a pas repondu »,
          // ce qui ne veut pas dire « rien ne bouge » — meme distinction que partout.
          tracer('Kiosque', `${s.id}/${section} : ${(e as Error).message.slice(0, 80)}`);
          await ecrivain.ecrire({
            type: 'section', section, source: s.id, libelle: s.libelle, etat: 'echec', entrees: [],
          });
        }
    });

    // LE RAYON NON SERVI SE DIT AVANT TOUTE ATTENTE. Sans cela, l'ecran restait vide le
    // temps d'un budget entier pour ne rien annoncer.
    if (travaux.length === 0) {
      await ecrivain.ecrire({ type: 'rayon-non-servi', rayon: rayon.id });
    }

    await Promise.all(travaux);
    await ecrivain.ecrire({ type: 'fin', motifAParaitre: MOTIF_A_PARAITRE });
    ecrivain.terminer();
  });

  return r;
}
