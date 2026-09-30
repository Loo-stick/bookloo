// Quel service peut-on essayer sur un lien direct, et dans quel ordre.
//
// POURQUOI CE MODULE EXISTE. La liste d'hebergeurs d'un debrideur servait de BARRIERE a
// cinq endroits — la sonde, deux fois, la liste envoyee a l'ecran, la redirection de
// telechargement et la lecture — et elle s'y trompait deux fois :
//
// - TorBox y etait compte comme capable d'ouvrir un lien d'hebergeur. Or `resoudreDdl`
//   ne sait parler qu'a AllDebrid : le chemin TorBox n'a jamais ete ecrit, et la garde
//   le refuse d'office. Un lien que seul TorBox « prenait en charge » etait donc essaye
//   par lui, rendait null, et l'ecran concluait : « vos 2 debrideurs n a su ouvrir aucun
//   des 1 lien(s) utilisables ». Signale a l'usage sur downmagaz, le 2026-09-11.
// - Et la liste d'AllDebrid est INCOMPLETE. Le meme jour, elle declarait turbobit
//   desactive et ne citait pas `turbobita.net` parmi ses domaines — or AllDebrid ouvre ce
//   lien, essaye a la main. L'application ne le lui avait jamais demande.
//
// D'ou deux regles. Un lien direct ne se propose qu'au service qui sait le debloquer ICI.
// Et pour ce service, la liste ORDONNE les essais — les hebergeurs qu'il declare d'abord —
// sans en interdire aucun : c'est sa reponse qui fait foi, un essai ne coute qu'un appel
// et ne depose rien, et un refus est deja memorise par lien (`refus-debrideur.ts`).

import type { NomService } from './index';
import { hoteExploitable } from './hosts';

/** Ce service sait-il debloquer un lien d'hebergeur dans cette application ? */
export function debloqueLesLiensDirects(service: NomService): boolean {
  return service === 'alldebrid';
}

/**
 * Pourquoi ce service n'est pas propose sur un lien direct. `null` : il l'est.
 *
 * « non pris en charge par torbox » aurait ete faux dans l'autre sens : TorBox prend
 * turbobita.net en charge, c'est l'application qui ne sait pas encore le lui demander.
 */
export function motifSansLienDirect(service: NomService): string | null {
  return debloqueLesLiensDirects(service)
    ? null
    : `${service} : l application ne sait pas encore debloquer un lien direct avec lui`;
}

/** Les liens, ceux que le service DECLARE d'abord. L'ordre de la fiche est garde dedans. */
export function declaresDabord<T extends { hebergeur: string }>(
  liens: readonly T[],
  supportes: Set<string>,
): T[] {
  return [
    ...liens.filter((l) => hoteExploitable(l.hebergeur, supportes)),
    ...liens.filter((l) => !hoteExploitable(l.hebergeur, supportes)),
  ];
}

/**
 * Le motif d'une sonde ou aucun lien n'a pu etre ouvert.
 *
 * IL DIT CE QUI A ETE ESSAYE, pas ce qui etait disponible : annoncer quatre echecs pour
 * un seul essai est une conclusion qu'on n'a pas gagnee. IL NOMME LE DEBRIDEUR, jamais
 * l'hebergeur : verifie le 2026-09-02, un lien refuse par les deux services s'ouvrait au
 * navigateur. Et IL S'ACCORDE avec celui qui a essaye.
 */
export function motifSondeEchouee(
  services: readonly string[],
  essayes: number,
  utilisables: number,
  max: number,
): string {
  const pluriel = services.length > 1;
  const qui = pluriel ? `vos ${services.length} debrideurs` : services[0];
  const ne = pluriel ? 'n ont' : 'n a';
  return essayes < utilisables
    ? `${qui} ${ne} pas su ouvrir ${essayes} lien(s) essaye(s) `
      + `(${utilisables - essayes} autre(s) non testes : la sonde en essaie ${max} au plus)`
    : `${qui} ${ne} su ouvrir aucun des ${utilisables} lien(s) utilisables de cette release`;
}
