// Memoire courte des LIVRES AUDIO ouverts.
//
// Troisieme table de ce genre apres `sommaires.ts` (CBZ) et `livres-ouverts.ts` (EPUB).
// La forme est volontairement identique aux deux autres : un lecteur qui en connait une
// les connait toutes. Le jour ou une quatrieme apparaitra, il faudra les factoriser.
//
// CE QU'ELLE EVITE. Obtenir le sommaire d'une release debridee coute TROIS allers-retours
// au debrideur : deposer le magnet, lister ses fichiers, puis deverrouiller un lien. Sans
// memoire, chaque changement de chapitre les refait — et la liseuse EPUB a deja paye
// exactement cette facture, 1100 ms de refonte sur 1320 ms de chargement.
//
// Avec la memoire, changer de chapitre coute UN deverrouillage de lien.
//
// LA CLE DU DEBRIDEUR N'EST PAS RETENUE ICI. Elle se redechiffre a chaque requete depuis
// la session, comme partout ailleurs. Ce qu'on garde est le fruit du depot — un
// identifiant de release et une liste de pistes — qui ne vaut rien sans elle.

import type { Piste } from './audio';

const TTL_MS = 30 * 60 * 1000;
/** Plafond : un sommaire pese quelques kilo-octets. */
const MAX_ENTREES = 200;

export interface EcouteOuverte {
  /** Identifiant de la release CHEZ LE DEBRIDEUR, rendu par le depot. */
  idDebrid: string;
  /** Le service qui l'a rendu : un identifiant AllDebrid ne veut rien dire chez TorBox. */
  service: string;
  pistes: Piste[];
  /** Le nom de la release, pour l'entete du lecteur. */
  titre: string;
}

interface Entree { ouverte: EcouteOuverte; expire: number }

const table = new Map<string, Entree>();

const cle = (userId: number, identite: string) => `${userId}:${identite}`;

function purger(): void {
  const maintenant = Date.now();
  for (const [k, v] of table) if (v.expire < maintenant) table.delete(k);
  if (table.size <= MAX_ENTREES) return;
  const parAnciennete = [...table.entries()].sort((a, b) => a[1].expire - b[1].expire);
  for (const [k] of parAnciennete.slice(0, table.size - MAX_ENTREES)) table.delete(k);
}

export function poserEcoute(userId: number, identite: string, ouverte: EcouteOuverte): void {
  purger();
  table.set(cle(userId, identite), { ouverte, expire: Date.now() + TTL_MS });
}

export function ecouteMemorisee(userId: number, identite: string): EcouteOuverte | undefined {
  const k = cle(userId, identite);
  const e = table.get(k);
  if (!e) return undefined;
  if (e.expire < Date.now()) { table.delete(k); return undefined; }
  // Relire prolonge : un livre qu'on ecoute ne doit pas expirer sous l'auditeur. Un
  // chapitre dure vingt minutes, le delai en vaut trente.
  e.expire = Date.now() + TTL_MS;
  return e.ouverte;
}
