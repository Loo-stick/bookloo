// Le prechargement : un fichier distant rapatrie EN ENTIER sur le disque, lu ensuite en local.
//
// POURQUOI. Mesure du 2026-09-15 sur le CDN de LibGen, depuis ce serveur qui tire 4 Mo/s de
// cdnjs : 14 a 400 Ko/s selon le moment, et quatre plages paralleles se PARTAGENT ce debit
// au lieu de le multiplier. Une planche de 269 Ko prenait 19 s ; un en-tete RAR de 1 Ko n'a
// pas recu un octet en 20 s. Lire a distance, planche par planche, n'est donc pas une lecture.
// Rapatrier le fichier une fois, avec une barre qui avance, en est une.
//
// CE QUI REND LE RAPATRIEMENT SUR :
//   - le flux va DIRECTEMENT sur le disque, rien n'est garde en memoire — un manga pese
//     90 Mo, et ce serveur a deja gele deux fois pour une question de memoire ;
//   - une coupure ne fait pas recommencer : on redemande un lien et on reprend a l'octet
//     ou le fichier partiel s'arrete (`Range: bytes=N-`) ;
//   - on ne coupe que sur un SILENCE, jamais sur une duree : un transfert lent avance ;
//   - un fichier n'est declare pret que si sa taille est COMPLETE, et il ne prend son nom
//     definitif qu'a ce moment — un partiel ne passe jamais pour un fichier.
//
// GENERIQUE : rien ici ne connait LibGen. La source fournit une cle (le nom du fichier) et
// de quoi obtenir une adresse.

import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import axios from 'axios';
import { tracer } from '../core/journal';
import type { FichierDistant } from './plages';

/** Une erreur qu'aucune reprise ne corrigera : fichier trop gros, serveur en panne… */
export class ErreurDefinitive extends Error {}

export interface SourcePrecharge {
  /**
   * Le nom du fichier sur le disque : 32 caracteres hexadecimaux, VERIFIES ici. Rien de ce
   * qu'un utilisateur ecrit n'entre dans un chemin.
   */
  cle: string;
  /** Une adresse deja verifiee. `frais` : la precedente a echoue, en redemander une. */
  resoudre: (frais: boolean) => Promise<string>;
}

export type EtatPrecharge =
  | { etat: 'absent' }
  | { etat: 'en-attente' | 'en-cours'; recus: number; taille?: number }
  | { etat: 'pret'; recus: number; taille: number }
  | { etat: 'echec'; recus: number; taille?: number; erreur: string };

export interface ReglagesPrecharges {
  /** Appele a l'usage, pas a la creation : importer ce module ne cree aucun dossier. */
  dossier: () => string;
  maxFichierOctets: number;
  maxDossierOctets: number;
  simultanes: number;
  silenceMs: number;
  maxReprises: number;
  attenteRepriseMs: number;
}

const RE_CLE = /^[a-f0-9]{32}$/;
const RE_NOM = /^([a-f0-9]{32})\.bin(?:\.partiel)?$/;
const MAX_PLAGE_OCTETS = 16 * 1024 * 1024;

interface Tache {
  cle: string;
  source: SourcePrecharge;
  etat: 'en-attente' | 'en-cours' | 'pret' | 'echec';
  recus: number;
  taille?: number;
  erreur?: string;
}

const pause = (ms: number) => new Promise((z) => { setTimeout(z, ms); });

function tailleDe(p: string): number {
  try { return fs.statSync(p).size; } catch { return 0; }
}

/** La date d'acces sert a l'eviction : la poser a chaque ouverture garde ce qu'on relit. */
function toucher(p: string): void {
  try { fs.utimesSync(p, new Date(), fs.statSync(p).mtime); } catch { /* sans importance */ }
}

export function creerPrecharges(r: ReglagesPrecharges) {
  const taches = new Map<string, Tache>();
  const file: Tache[] = [];
  let actives = 0;

  function dossier(): string {
    const d = r.dossier();
    fs.mkdirSync(d, { recursive: true });
    return d;
  }

  function verifierCle(cle: string): void {
    if (!RE_CLE.test(String(cle || ''))) throw new Error('cle de prechargement invalide');
  }

  function chemins(cle: string) {
    const final = path.join(dossier(), `${cle}.bin`);
    return { final, partiel: `${final}.partiel` };
  }

  const occupe = (t: Tache | undefined) => !!t && (t.etat === 'en-cours' || t.etat === 'en-attente');

  /**
   * Fait de la place pour `attendu` octets. Rend `false` s'il n'y en a pas assez meme apres
   * avoir evince tout ce qui peut l'etre : les fichiers en cours ne sont jamais touches.
   */
  function evincer(attendu: number): boolean {
    const d = dossier();
    const fichiers = fs.readdirSync(d)
      .map((nom) => {
        const m = RE_NOM.exec(nom);
        if (!m) return null;
        const p = path.join(d, nom);
        try {
          const st = fs.statSync(p);
          return { p, cle: m[1], taille: st.size, vu: Math.max(st.atimeMs, st.mtimeMs) };
        } catch {
          return null; // deja parti
        }
      })
      .filter((f): f is { p: string; cle: string; taille: number; vu: number } => f !== null)
      .sort((a, b) => a.vu - b.vu);

    let total = fichiers.reduce((s, f) => s + f.taille, 0);
    for (const f of fichiers) {
      if (total + attendu <= r.maxDossierOctets) return true;
      if (occupe(taches.get(f.cle))) continue;
      try { fs.unlinkSync(f.p); total -= f.taille; } catch { /* deja parti */ }
    }
    return total + attendu <= r.maxDossierOctets;
  }

  /** Une tentative, qui reprend au bout du fichier partiel. Leve en cas d'echec. */
  async function uneTentative(t: Tache, partiel: string, frais: boolean): Promise<void> {
    const url = await t.source.resoudre(frais);
    const deja = tailleDe(partiel);
    t.recus = deja;

    const controleur = new AbortController();
    let raison: string | null = null;
    const muet = `plus rien recu du serveur de fichiers depuis ${Math.round(r.silenceMs / 1000)} s`;
    const couper = () => { raison = raison ?? muet; controleur.abort(); };
    let silence = setTimeout(couper, r.silenceMs);

    try {
      // `maxRedirects: 0` : l'adresse rendue par la source est deja verifiee. Suivre une
      // redirection menerait ailleurs sans que personne ne l'ait jugee.
      const res = await axios.get(url, {
        responseType: 'stream', signal: controleur.signal, validateStatus: () => true,
        maxRedirects: 0, headers: deja > 0 ? { Range: `bytes=${deja}-` } : {},
      });
      const abandonner = (e: Error) => { res.data.destroy(); return e; };

      let depart: number;
      let taille: number;
      if (res.status === 206) {
        const plage = /bytes\s+(\d+)-\d+\/(\d+)\s*$/.exec(String(res.headers['content-range'] || ''));
        // Une plage qui ne commence pas la ou on l'a demandee collerait des octets au
        // mauvais endroit, sans que rien ne le signale.
        if (!plage || Number(plage[1]) !== deja) throw abandonner(new Error('reponse de plage incoherente'));
        depart = deja;
        taille = Number(plage[2]);
      } else if (res.status === 200) {
        // Le serveur ignore la plage : il renvoie tout depuis le debut, on repart de zero.
        depart = 0;
        taille = Number(res.headers['content-length']);
      } else {
        throw abandonner(new Error(`le serveur de fichiers a repondu ${res.status}`));
      }

      if (!Number.isFinite(taille) || taille <= 0) {
        throw abandonner(new Error('le serveur de fichiers n a pas annonce de taille'));
      }
      if (taille > r.maxFichierOctets) {
        throw abandonner(new ErreurDefinitive(
          `fichier trop volumineux pour le prechargement : ${Math.round(taille / 1024 / 1024)} Mo`));
      }
      if (t.taille !== undefined && t.taille !== taille) {
        // Ce n'est plus le meme fichier : le partiel ne vaut plus rien.
        fs.rmSync(partiel, { force: true });
        throw abandonner(new Error('la taille du fichier a change, reprise depuis le debut'));
      }
      t.taille = taille;
      if (!evincer(taille - depart)) {
        throw abandonner(new ErreurDefinitive('plus assez de place pour precharger ce fichier'));
      }

      t.recus = depart;
      await pipeline(
        res.data,
        async function* (flux: AsyncIterable<Buffer>) {
          for await (const morceau of flux) {
            t.recus += morceau.length;
            if (t.recus > taille) throw new ErreurDefinitive('le serveur envoie plus que la taille annoncee');
            clearTimeout(silence);
            silence = setTimeout(couper, r.silenceMs);
            yield morceau;
          }
        },
        fs.createWriteStream(partiel, { flags: depart > 0 ? 'a' : 'w' }),
      );

      const obtenu = tailleDe(partiel);
      if (obtenu !== taille) throw new Error(`fichier incomplet : ${obtenu} octets sur ${taille}`);
    } catch (e) {
      if (raison && !(e instanceof ErreurDefinitive)) throw new Error(raison);
      throw e;
    } finally {
      clearTimeout(silence);
    }
  }

  async function telecharger(t: Tache): Promise<void> {
    const { final, partiel } = chemins(t.cle);
    let reprises = 0;
    for (;;) {
      try {
        await uneTentative(t, partiel, reprises > 0);
        fs.renameSync(partiel, final);
        t.etat = 'pret';
        return;
      } catch (e) {
        const message = (e as Error).message;
        if (e instanceof ErreurDefinitive || reprises >= r.maxReprises) {
          t.etat = 'echec';
          t.erreur = message;
          // Un partiel qu'aucune reprise ne completera n'a pas a occuper le disque.
          if (e instanceof ErreurDefinitive) fs.rmSync(partiel, { force: true });
          tracer('Precharge', `${t.cle.slice(0, 8)} abandonne : ${message}`);
          return;
        }
        reprises += 1;
        tracer('Precharge', `${t.cle.slice(0, 8)} reprise ${reprises} apres : ${message}`);
        await pause(r.attenteRepriseMs * reprises);
      }
    }
  }

  function pomper(): void {
    while (actives < r.simultanes && file.length > 0) {
      const t = file.shift()!;
      t.etat = 'en-cours';
      actives += 1;
      telecharger(t)
        .catch((e) => { t.etat = 'echec'; t.erreur = (e as Error).message; })
        .finally(() => { actives -= 1; pomper(); });
    }
  }

  function vue(t: Tache): EtatPrecharge {
    if (t.etat === 'echec') return { etat: 'echec', recus: t.recus, taille: t.taille, erreur: t.erreur || 'echec' };
    if (t.etat === 'pret') return { etat: 'pret', recus: t.recus, taille: t.taille ?? t.recus };
    return { etat: t.etat, recus: t.recus, taille: t.taille };
  }

  return {
    /** Lance le prechargement s'il n'est ni fait ni en cours. Rend l'etat, sans attendre. */
    lancer(source: SourcePrecharge): EtatPrecharge {
      verifierCle(source.cle);
      const existante = taches.get(source.cle);
      if (occupe(existante)) return vue(existante!);
      const { final, partiel } = chemins(source.cle);
      if (fs.existsSync(final)) {
        toucher(final);
        const taille = tailleDe(final);
        return { etat: 'pret', recus: taille, taille };
      }
      const t: Tache = { cle: source.cle, source, etat: 'en-attente', recus: tailleDe(partiel) };
      taches.set(source.cle, t);
      file.push(t);
      pomper();
      return vue(t);
    },

    /** L'etat, sans rien lancer. */
    etat(cle: string): EtatPrecharge {
      verifierCle(cle);
      const t = taches.get(cle);
      if (occupe(t) || t?.etat === 'echec') return vue(t!);
      const { final } = chemins(cle);
      if (fs.existsSync(final)) {
        const taille = tailleDe(final);
        return { etat: 'pret', recus: taille, taille };
      }
      return { etat: 'absent' };
    },

    /** Le chemin du fichier complet, ou `null`. */
    cheminPret(cle: string): string | null {
      verifierCle(cle);
      const { final } = chemins(cle);
      if (!fs.existsSync(final)) return null;
      toucher(final);
      return final;
    },

    /** Attend que plus rien ne tourne. Pour les tests. */
    async auRepos(): Promise<void> {
      while (actives > 0 || file.length > 0) await pause(20);
    },
  };
}

/**
 * Un fichier du disque, sous la forme qu'attendent les lecteurs d'archive.
 *
 * Meme contrat que `ouvrirDistant` — `zip.ts`, `rar.ts` et les liseuses ne savent pas d'ou
 * viennent les octets — et meme plafond par plage.
 */
export async function ouvrirLocal(chemin: string): Promise<FichierDistant> {
  const taille = (await fs.promises.stat(chemin)).size;
  return {
    taille,
    lire: async (debut: number, fin: number) => {
      if (fin - debut + 1 > MAX_PLAGE_OCTETS) throw new Error('plage demandee trop grande');
      const bout = Math.min(fin, taille - 1);
      if (debut > bout) return Buffer.alloc(0);
      const fh = await fs.promises.open(chemin, 'r');
      try {
        const tampon = Buffer.alloc(bout - debut + 1);
        const { bytesRead } = await fh.read(tampon, 0, tampon.length, debut);
        return tampon.subarray(0, bytesRead);
      } finally {
        await fh.close();
      }
    },
  };
}
