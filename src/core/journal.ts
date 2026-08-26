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

/**
 * L'hote d'une URL, sans rien d'autre.
 *
 * Une URL de .torrent porte le passkey de l'utilisateur : elle ne doit JAMAIS entrer
 * dans un journal. L'hote, lui, dit ce qu'on a besoin de savoir — quel tracker a ete
 * sollicite — et ne revele rien.
 */
export function hoteDe(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'hote inconnu';
  }
}
