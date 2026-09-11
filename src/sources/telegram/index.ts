// La source Telegram.
//
// PREMIERE SOURCE DU PROJET A NE DEPENDRE D'AUCUN DEBRIDEUR. Un fichier indexe dans un
// canal EST disponible : il n'y a ni cache a verifier, ni magnet a deposer, ni cle a
// dechiffrer. Toute la mecanique `en-cache` / `absent` / `inconnu` est sans objet ici.
//
// Elle n'a pas de `cleRequise`, et ce n'est pas parce qu'elle serait publique comme Nyaa :
// son acces appartient a l'OPERATEUR, qui heberge le bot d'indexation. Un utilisateur
// n'a rien a renseigner, et rien a corriger si l'operateur ne l'heberge pas.

import { getSettings } from '../../core/settings';
import { chercherTelegram, identiteTelegram, type ResultatTelegram } from './facade';
import { parseRelease } from '../torrent/release';
import type { Candidate, Query, SearchContext, Source } from '../types';

/** Plage de tomes annoncee par l'index, quand elle est exploitable. */
function plageDeTomes(r: ResultatTelegram): Candidate['tomes'] {
  if (r.plage) {
    const m = /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(r.plage);
    if (m) return { debut: Number(m[1]), fin: Number(m[2]), integrale: false };
  }
  if (r.tome !== null && r.tome !== undefined) return { debut: r.tome, integrale: false };
  return undefined;
}

/**
 * Convertit un resultat de la facade en candidat du pipeline. PUR.
 *
 * On repasse le nom par `parseRelease` pour la langue et le format : l'index Telegram ne
 * les connait pas, alors que le nom de fichier les porte comme partout ailleurs. Le
 * numero de tome, lui, vient de l'index — il a ete etabli par un analyseur dedie, plus
 * fiable qu'une seconde lecture du nom.
 */
/**
 * Lien vers le message d'origine, ou `undefined` si l'index ne connait pas le canal.
 *
 * Ce n'est pas une devinette : `t.me/<canal>/<message>` est l'adresse publique d'un
 * message de canal, et la facade rend deja les deux morceaux. Aucun appel n'est
 * necessaire pour la construire.
 */
export function lienTelegram(r: ResultatTelegram): string | undefined {
  const message = r.id.split(':')[1];
  if (!r.canal || !message) return undefined;
  return `https://t.me/${r.canal}/${message}`;
}

export function versCandidat(r: ResultatTelegram): Candidate {
  const analyse = parseRelease(r.nom);
  return {
    source: 'telegram',
    // Ni `hash` ni `torrentUrl` : il n'y a rien a deposer chez un debrideur.
    identite: identiteTelegram(r.id),
    titre: r.nom,
    taille: r.taille ?? undefined,
    tomes: plageDeTomes(r) ?? analyse.tomes,
    langue: analyse.langue,
    format: analyse.format,
    provenance: analyse.provenance,
    // Un pack compte plusieurs fichiers ; l'index ne dit pas combien, mais « plus d'un »
    // suffit a ce que l'interface le signale comme tel.
    nbFichiers: r.estPack ? 2 : 1,
    lienExterne: lienTelegram(r),
  };
}

export function telegramSources(): Source[] {
  const { telegram } = getSettings();
  // Adresse absente : la source n'est pas enregistree DU TOUT. Pas de pastille, pas
  // d'etat, pas d'explication a donner — l'application est celle d'avant.
  if (!telegram.url) return [];

  return [
    {
      id: 'telegram',
      label: 'Telegram',
      async search(q: Query, ctx: SearchContext): Promise<Candidate[]> {
        const vus = new Set<string>();
        const out: Candidate[] = [];
        for (const forme of q.titres) {
          if (!forme) continue;
          for (const r of await chercherTelegram(forme, ctx.signal)) {
            if (vus.has(r.id)) continue;
            vus.add(r.id);
            out.push(versCandidat(r));
          }
        }
        return out;
      },
    },
  ];
}
