// Unique porte de sortie vers les journaux.
//
// `masque.ts` ne sert a rien s'il n'est pas SUR LE CHEMIN. Un seul `console.log` qui
// recopie une URL d'indexeur suffit a ecrire la passkey d'un utilisateur dans un
// fichier de log — et cette fuite-la ne se rattrape pas apres coup. On monte donc ce
// module le premier jour, et rien n'appelle `console.*` directement ailleurs.

import { masquer } from './masque';

export function tracer(prefixe: string, message: string): void {
  console.log(`[${prefixe}] ${masquer(message)}`);
}

export function tracerErreur(prefixe: string, e: unknown): void {
  const message = e instanceof Error ? e.message : String(e);
  console.error(`[${prefixe}] ${masquer(message)}`);
}
