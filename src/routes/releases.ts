// Agregation des releases pour une oeuvre.
//
// L'ordre des operations n'est pas arbitraire :
//
//   1. fan-out sur les quatre sources, sous budget dur
//   2. DEDOUBLONNAGE PAR HASH — la meme release traine souvent sur deux trackers
//   3. rapprochement avec la fiche, partition certaines / incertaines
//   4. etat de cache : TorBox en lot, AllDebrid via StremThru en lot
//   5. tri
//
// L'etape 4 ne DEPOSE JAMAIS rien. La verification qui touche le compte AllDebrid est
// une action separee, declenchee par un clic, une release a la fois (voir debrid.ts).

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import { fanout } from '../core/fanout';
import { getSettings } from '../core/settings';
import { torznabSources } from '../sources/torrent/torznab';
import { unit3dSources } from '../sources/torrent/unit3d';
import { nyaaSource } from '../sources/torrent/nyaa';
import { knabenSource } from '../sources/torrent/knaben';
import { wawacitySource } from '../sources/ddl/wawacity';
import { ficheOeuvre, requeteDepuisOeuvre, type Oeuvre } from '../catalogue/mangadex';
import { SEUIL_CERTAIN, scorer } from '../catalogue/rapprochement';
import { clesDeRecherche, clesEnClair } from '../auth/cles-utilisateur';
import { memoriserLien, poserEtatCache } from '../core/liens-torrent';
import { exigerConnexion, exigerCsrf, limiteurRecherche } from '../auth/garde';
import { MARQUEUR_ECHEC, torbox } from '../debrid/torbox';
import type { Candidate, EtatSource, Query, ResultatSource } from '../sources/types';
import type { EtatCache } from '../debrid/types';
import { telegramSources } from '../sources/telegram';
import { zlibrarySources } from '../sources/zlibrary';

/** Fusionne les doublons par infohash, en gardant la meilleure entree. */
export function dedoublonner(candidats: Candidate[]): Candidate[] {
  const parHash = new Map<string, Candidate>();
  const sansHash: Candidate[] = [];

  for (const c of candidats) {
    if (!c.hash) {
      // Sans hash, aucune identite fiable : fusionner sur le titre marierait deux
      // releases differentes portant le meme nom.
      sansHash.push(c);
      continue;
    }
    const existant = parHash.get(c.hash);
    if (!existant) {
      parHash.set(c.hash, { ...c });
      continue;
    }
    const gagnant = (c.seeders ?? 0) > (existant.seeders ?? 0) ? { ...c } : existant;
    const perdant = gagnant === existant ? c : existant;
    const sources = new Set([...(gagnant.aussiSur ?? []), ...(perdant.aussiSur ?? []), perdant.source]);
    sources.delete(gagnant.source);
    gagnant.aussiSur = [...sources];
    parHash.set(c.hash, gagnant);
  }

  return [...parHash.values(), ...sansHash];
}

export function trier(candidats: Candidate[]): Candidate[] {
  const etendue = (c: Candidate) =>
    c.tomes ? (c.tomes.fin ?? c.tomes.debut) - c.tomes.debut + 1 : 0;
  return [...candidats].sort(
    (a, b) => etendue(b) - etendue(a) || (b.seeders ?? 0) - (a.seeders ?? 0),
  );
}

/**
 * Partitionne selon le rapprochement avec la fiche.
 *
 * Rien n'est jete : sous le seuil, la release part dans « incertaines ». Un faux
 * negatif silencieux coute plus cher qu'une ligne en trop.
 */
export function assembler(
  candidats: Candidate[],
  oeuvre: Oeuvre | null,
): { certaines: Candidate[]; incertaines: Candidate[] } {
  if (!oeuvre) return { certaines: trier(candidats), incertaines: [] };

  const certaines: Candidate[] = [];
  const incertaines: Candidate[] = [];
  for (const c of candidats) {
    const score = scorer(oeuvre, c.titre);
    const avecScore = { ...c, score };
    (score >= SEUIL_CERTAIN ? certaines : incertaines).push(avecScore);
  }
  return { certaines: trier(certaines), incertaines: trier(incertaines) };
}

export function toutesLesSources() {
  const settings = getSettings();
  return [
    ...torznabSources(), ...unit3dSources(), nyaaSource(), knabenSource(), wawacitySource(),
    // Rend un tableau VIDE tant qu'aucune facade n'est configuree : la source n'existe
    // alors pas, plutot que d'exister en panne.
    ...telegramSources(),
    // Meme regle, sur le domaine. La recherche est anonyme : la source reste utile
    // avant toute saisie d'identifiants.
    ...zlibrarySources(),
  ].filter(
    (s) => settings.sources[s.id] !== false,
  );
}

/** Au-dela, la colonne de cache reste « inconnu » plutot que de faire attendre. */
// Genereux : cette route ne fait plus attendre la liste, elle la complete.
const BUDGET_CACHE_MS = 25000;

export interface EtatsDebrid {
  torbox: Record<string, EtatCache>;
  alldebrid: Record<string, EtatCache>;
  /**
   * Etat des SERVICES eux-memes, distinct de celui des releases.
   *
   * Meme lecon que pour les sources : « pas en cache » et « le service n'a pas
   * repondu » ne veulent pas dire la meme chose, et les confondre laisse croire a un
   * verdict definitif la ou il n'y a qu'une panne passagere.
   */
  services: { torbox: 'repondu' | 'echec' | 'cle-absente'; alldebrid: 'manuel' | 'cle-absente' };
}

/**
 * Etat de cache, SANS jamais rien deposer.
 *
 * SEUL TORBOX PEUT REPONDRE ICI, et il repond exhaustivement.
 *
 * La colonne AllDebrid reste entierement « inconnu ». Ce n'est pas un manque : c'est
 * l'etat exact des choses. AllDebrid n'expose aucune consultation en lecture seule, et
 * StremThru n'y change rien — mesure du 2026-08-20 : authentifie sur le compte
 * (`/v0/store/user` rend bien le pseudo et le statut premium), il rend `items: []` meme
 * pour un hash PRET dans ce compte. Il n'invente pas ce qu'AllDebrid n'expose pas.
 *
 * L'appeler coutait 2,6 a 5,6 s par lot pour aucune information. Il a donc ete retire —
 * et ce commentaire existe pour qu'on ne le rajoute pas.
 */
async function etatsDeCache(
  hashes: string[],
  cleTb: string | undefined,
  signal?: AbortSignal,
): Promise<EtatsDebrid> {
  const out: EtatsDebrid = {
    torbox: {},
    alldebrid: {},
    services: {
      torbox: cleTb ? 'repondu' : 'cle-absente',
      // Chez AllDebrid il n'existe aucune consultation en lecture seule : l'etat ne
      // peut venir que d'un clic. Ce n'est pas une panne, c'est le fonctionnement.
      alldebrid: 'manuel',
    },
  };
  if (hashes.length === 0) return out;

  // BUDGET DUR, comme le fan-out. StremThru met plusieurs secondes par appel, et son
  // silence a deja une signification exacte : « inconnu ». Faire patienter l'utilisateur
  // devant une liste deja construite, pour une colonne qui peut rester vide, serait un
  // mauvais echange.
  const controleur = new AbortController();
  signal?.addEventListener('abort', () => controleur.abort(), { once: true });
  const minuteur = setTimeout(() => controleur.abort(), BUDGET_CACHE_MS);
  const signalInterne = controleur.signal;

  const travaux: Promise<void>[] = [];
  if (cleTb) {
    travaux.push(
      torbox(cleTb)
        .verifierCache(hashes, signalInterne)
        .then((m) => {
          for (const [h, e] of m) {
            if (h === MARQUEUR_ECHEC) { out.services.torbox = 'echec'; continue; }
            out.torbox[h] = e;
          }
        })
        .catch(() => { out.services.torbox = 'echec'; }),
    );
  }
  try {
    await Promise.all(travaux);
  } finally {
    clearTimeout(minuteur);
  }

  // Tout hash demande figure dans les deux tables : « inconnu » est une reponse, pas
  // une absence de reponse.
  for (const h of hashes) {
    out.torbox[h] ??= 'inconnu';
    out.alldebrid[h] ??= 'inconnu';
  }
  return out;
}

/** Retire de la reponse tout ce qui ne doit pas atteindre le navigateur. */
export function sansSecret(c: Candidate): Candidate {
  const { torrentUrl: _ignore, ...reste } = c;
  return reste as Candidate;
}

function resumeSources(resultats: ResultatSource[]): { source: string; label: string; etat: EtatSource; n: number }[] {
  return resultats.map((r) => ({ source: r.source, label: r.label, etat: r.etat, n: r.candidats.length }));
}

async function chercher(db: Database, req: Parameters<Parameters<Router['get']>[1]>[0], q: Query) {
  const session = req.session!;
  const cles = clesEnClair(db, session.userId, session.dek);
  const settings = getSettings();

  const resultats = await fanout(
    toutesLesSources(),
    q,
    { cles: clesDeRecherche(cles) },
    settings.fanoutBudgetMs,
  );

  const tous = dedoublonner(resultats.flatMap((r) => r.candidats)).slice(0, settings.maxResultats);

  // L'URL du .torrent PORTE LA PASSKEY du tracker : elle reste cote serveur, et le
  // navigateur ne manipule qu'un hash. La renvoyer la ferait atterrir dans
  // l'historique et dans les outils de developpement.
  for (const c of tous) if (c.hash) memoriserLien(session.userId, c.hash, c.torrentUrl, c.source, c.aussiSur);

  return { tous: tous.map(sansSecret), resultats };
}

export function routesReleases(db: Database): Router {
  const r = Router();

  // Les recherches sont passees au FLUX (`routes/flux.ts`) : les resultats arrivent
  // source par source au lieu d'attendre la plus lente. Il n'en reste qu'une version,
  // volontairement — deux chemins pour le meme resultat divergent toujours.

  /**
   * Etats de cache, demandes SEPAREMENT.
   *
   * La liste des releases ne doit pas attendre cette reponse : mesure du 2026-08-20,
   * TorBox traverse des periodes ou il repond en 25 s ou pas du tout. Faire patienter
   * devant une page deja construite, pour une colonne qui peut ne jamais arriver, est
   * un mauvais echange. La recherche revient donc en 2,7 s, et les pastilles se
   * remplissent quand elles peuvent.
   */
  r.post('/api/etats-cache', exigerConnexion, exigerCsrf, async (req, res) => {
    const brut = (req.body as { hashes?: unknown })?.hashes;
    const hashes = Array.isArray(brut)
      ? [...new Set(brut.map((h) => String(h).toLowerCase()).filter((h) => /^[a-f0-9]{40}$/.test(h)))]
      : [];
    if (hashes.length === 0) {
      res.status(400).json({ erreur: 'aucun hash a verifier' });
      return;
    }
    const cles = clesEnClair(db, req.session!.userId, req.session!.dek);
    const etats = await etatsDeCache(hashes, cles.tb);

    // Les verdicts TorBox viennent d'une consultation en lecture seule : acquis sans
    // rien deposer, ils autorisent la lecture en ligne sans geste supplementaire.
    for (const [h, etat] of Object.entries(etats.torbox)) {
      poserEtatCache(req.session!.userId, h, 'torbox', etat);
    }
    res.json({ etats });
  });

  return r;
}
