// L'anneau des traces, lu par la page d'administration.
//
// BORNE, DONC IL OUBLIE. Un journal qui grossit sans fin finit par tuer le process qu'il
// devait aider a diagnostiquer — et ce serveur n'a que quelques gigaoctets de marge pour
// tout ce qui tourne dessus.
//
// EN MEMOIRE, ET NULLE PART AILLEURS. Un fichier rattache a des personnes serait une
// promesse qu'on ne veut pas faire : la page d'administration affiche « l'operateur ne
// detient aucune cle d'utilisateur », et un journal sur disque la fragiliserait.

export interface LigneTrace {
  seq: number;
  ts: number;
  niveau: 'info' | 'warn' | 'error';
  source: string;
  message: string;
}

export const MAX_LIGNES = 1000;

const anneau: LigneTrace[] = [];
let compteur = 0;

export function poser(
  niveau: LigneTrace['niveau'],
  source: string,
  message: string,
): void {
  compteur += 1;
  anneau.push({ seq: compteur, ts: Date.now(), niveau, source, message });
  // `shift` sur mille elements est negligeable, et garde le tableau EN ORDRE : le client
  // lit une suite, pas un anneau qu'il devrait recoller lui-meme.
  while (anneau.length > MAX_LIGNES) anneau.shift();
}

/**
 * Les lignes posterieures a `seq`, et le `seq` courant.
 *
 * Le client redemande a partir du dernier `seq` qu'il a vu : ni doublon, ni trou. Un `seq`
 * du futur — garde d'avant un redemarrage — ne rend rien plutot que tout, sans quoi l'ecran
 * se remplirait d'un coup de lignes deja lues.
 */
export function depuis(seq: number): { lignes: LigneTrace[]; seq: number } {
  const depart = Number.isFinite(seq) && seq > 0 ? seq : 0;
  return { lignes: anneau.filter((l) => l.seq > depart), seq: compteur };
}

/** Exportee pour les tests : rien en production ne vide l'anneau. */
export function vider(): void {
  anneau.length = 0;
  compteur = 0;
}
