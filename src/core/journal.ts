// Unique porte de sortie vers les journaux.
//
// `masque.ts` ne sert a rien s'il n'est pas SUR LE CHEMIN. Un seul `console.log` qui
// recopie une URL d'indexeur suffit a ecrire la passkey d'un utilisateur dans un
// fichier de log — et cette fuite-la ne se rattrape pas apres coup. On monte donc ce
// module le premier jour, et rien n'appelle `console.*` directement ailleurs.

import { masquer } from './masque';
import { poser } from './anneau';

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

/**
 * Une trace d'APPEL SORTANT, a champs nommes.
 *
 * RIEN DE BRUT N'Y ENTRE, et c'est toute la garantie. Le masquage a posteriori demande de
 * connaitre chaque secret et chaque forme d'URL ; il existe dans ce projet — `masquer` — et
 * il fonctionne, mais DEUX RELECTEURS SUCCESSIFS L'ONT MANQUE le 2026-08-29, l'un signalant
 * une fuite de cle qui n'existait pas. Une garantie que personne ne retrouve est fragile.
 *
 * On n'accepte donc que ces champs-la. `hote` et non `url` : `hoteDe()` dit quel service a
 * ete sollicite sans reveler le passkey qui vit dans le chemin. Et `motif`, seule valeur
 * venue de l'exterieur, passe quand meme par `masquer` — en ceinture.
 */
export function tracerAppel(a: {
  source: string;
  hote: string;
  statut?: number | null;
  duree?: number;
  resultats?: number;
  motif?: string;
  ok?: boolean;
}): void {
  const morceaux = [`${a.source} chez ${a.hote}`];
  if (a.statut === null) morceaux.push('sans reponse');
  else if (typeof a.statut === 'number') morceaux.push(`HTTP ${a.statut}`);
  if (typeof a.resultats === 'number') morceaux.push(`${a.resultats} resultat(s)`);
  if (typeof a.duree === 'number') morceaux.push(`${a.duree} ms`);
  if (a.motif) morceaux.push(masquer(a.motif));

  // LE NIVEAU SE DEDUIT, il ne se declare pas : un appelant qui doit choisir son niveau
  // finit par tout mettre en « info ». Une reponse VIDE est un avertissement, pas une
  // erreur — la source a repondu, elle n'a simplement rien.
  const echec = a.ok === false || a.statut === null
    || (typeof a.statut === 'number' && (a.statut < 200 || a.statut >= 300));
  const vide = !echec && a.resultats === 0;
  poser(echec ? 'error' : vide ? 'warn' : 'info', a.source, morceaux.join(' · '));
}
