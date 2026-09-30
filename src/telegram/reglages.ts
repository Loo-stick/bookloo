// Les reglages Telegram de l'instance, lus et valides. PUR : aucun reseau, aucune base.
import { getSettings } from '../core/settings';

export interface ReglagesTelegram {
  apiId: number;
  apiHash: string;
  telephone: string;
  session: string;
  canaux: string[];
  direct: boolean;
}

/**
 * Un canal se designe de DEUX facons.
 *
 * Par son nom public — lettres, chiffres et tirets bas, sans arobase ni adresse. Ou, pour un
 * canal PRIVE qui n'en a aucun, par `id:<n>`. C'est la meme convention que mangaloo, dont le
 * `_cible()` presente un `PeerChannel(n)` a Telethon quand la reference est numerique : sans
 * elle, un canal sans nom public reste hors de portee.
 */
export function canalValide(nom: string): boolean {
  const x = `${nom || ''}`;
  return /^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(x) || /^id:[1-9]\d{0,18}$/.test(x);
}

/** L'identifiant numerique d'une reference `id:<n>`, ou null pour un nom public. */
export function identifiantDeCanal(reference: string): string | null {
  const m = /^id:([1-9]\d{0,18})$/.exec(`${reference || ''}`);
  return m ? m[1]! : null;
}

/** Une saisie — texte multiligne ou liste — rendue propre : valides, uniques, dans l'ordre. */
export function canauxDeLaSaisie(brut: unknown): string[] {
  const lignes = Array.isArray(brut)
    ? brut.map((x) => `${x ?? ''}`)
    : `${brut ?? ''}`.split(/[\s,;]+/);
  const out: string[] = [];
  for (const l of lignes) {
    const n = l.trim();
    if (canalValide(n) && !out.includes(n)) out.push(n);
  }
  return out;
}

export function reglagesTelegram(): ReglagesTelegram {
  const t = getSettings().telegram;
  return {
    apiId: Number(t.apiId) || 0,
    apiHash: String(t.apiHash || ''),
    telephone: String(t.telephone || ''),
    session: String(t.session || ''),
    canaux: canauxDeLaSaisie(t.canaux),
    direct: t.direct === true,
  };
}

/** Le mode direct est possible quand les trois pieces sont la. */
export function modeDirectPret(r: ReglagesTelegram): boolean {
  return Boolean(r.apiId && r.apiHash && r.session);
}

/**
 * Le mode direct est ACTIF : les pieces sont la ET l'hebergeur l'a demande.
 *
 * `modeDirectPret` suffit a moissonner ; il ne suffit pas a servir. Recherche et lecture
 * basculent ensemble sur cette seule fonction : des resultats du mode direct servis par la
 * facade echoueraient, leurs messages lui etant inconnus.
 */
export function modeDirectActif(r: ReglagesTelegram): boolean {
  return modeDirectPret(r) && r.direct === true;
}
