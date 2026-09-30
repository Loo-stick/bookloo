// Chiffrement des cles au repos.
//
// MODELE : la cle de chiffrement est derivee du MOT DE PASSE de l'utilisateur et ne vit
// qu'en memoire, le temps de sa session. Qui vole le fichier SQLite n'a rien
// d'exploitable — ni cle maitre dans un .env a cote, ni secrets lisibles.
//
// Ce modele n'est tenable que parce que TOUTE action de Mangaloo part d'un clic :
// aucune tache de fond n'a besoin des cles hors session. Contrepartie assumee : un
// redemarrage du serveur force une reconnexion.
//
// DEUX DERIVATIONS, DEUX SELS. Le hachage d'authentification (stocke) et la KEK (jamais
// stockee) ne doivent pas partager leur sortie. Sinon le hachage en base EST la cle de
// chiffrement, et le modele entier ne protege plus rien.
//
// INDIRECTION PAR DEK. Chaque compte a une cle de donnees aleatoire qui chiffre ses six
// secrets ; c'est elle, et elle seule, qui est enveloppee par la KEK. Changer de mot de
// passe ne rechiffre donc que la DEK, pas les six entrees — moins de code, et surtout
// moins de facons d'echouer a mi-chemin.

import { hash as argonHash, hashRaw, verify as argonVerify } from '@node-rs/argon2';
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

const TAILLE_CLE = 32;
const TAILLE_NONCE = 12;
const TAILLE_TAG = 16;

// Parametres argon2id. memoryCost en kio : 19 Mio est la recommandation OWASP 2024 pour
// un usage interactif, et reste supportable sur un serveur charge.
const PARAMS = { memoryCost: 19456, timeCost: 2, parallelism: 1 };

export function hacherMotDePasse(mdp: string): Promise<string> {
  return argonHash(mdp, PARAMS);
}

export async function verifierMotDePasse(mdp: string, hash: string): Promise<boolean> {
  try {
    return await argonVerify(hash, mdp);
  } catch {
    // Hash abime ou format inconnu : c'est un refus, pas une exception a propager.
    return false;
  }
}

/**
 * Cle d'enveloppe derivee du mot de passe.
 *
 * `hashRaw` avec un sel PROPRE a cet usage : la sortie ne doit avoir aucun rapport avec
 * le hachage d'authentification stocke en base.
 */
export async function deriverKek(mdp: string, sel: Buffer): Promise<Buffer> {
  return hashRaw(mdp, { ...PARAMS, salt: sel, outputLen: TAILLE_CLE });
}

export function nouveauSel(): Buffer {
  return randomBytes(16);
}

export function nouvelleDek(): Buffer {
  return randomBytes(TAILLE_CLE);
}

function chiffrerOctets(clair: Buffer, cle: Buffer): { chiffre: Buffer; nonce: Buffer } {
  const nonce = randomBytes(TAILLE_NONCE);
  const c = createCipheriv('aes-256-gcm', cle, nonce);
  const corps = Buffer.concat([c.update(clair), c.final()]);
  // Le tag d'authentification est concatene : c'est lui qui fait echouer proprement le
  // dechiffrement d'un contenu altere.
  return { chiffre: Buffer.concat([corps, c.getAuthTag()]), nonce };
}

function dechiffrerOctets(chiffre: Buffer, nonce: Buffer, cle: Buffer): Buffer | null {
  try {
    if (chiffre.length < TAILLE_TAG) return null;
    const corps = chiffre.subarray(0, chiffre.length - TAILLE_TAG);
    const tag = chiffre.subarray(chiffre.length - TAILLE_TAG);
    const d = createDecipheriv('aes-256-gcm', cle, nonce);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(corps), d.final()]);
  } catch {
    // Mauvaise cle ou contenu altere : on rend null. L'appelant traite l'absence, il
    // n'a pas a distinguer les deux cas — et le lui dire renseignerait un attaquant.
    return null;
  }
}

export function envelopper(dek: Buffer, kek: Buffer): { chiffre: Buffer; nonce: Buffer } {
  return chiffrerOctets(dek, kek);
}

export function developper(chiffre: Buffer, nonce: Buffer, kek: Buffer): Buffer | null {
  return dechiffrerOctets(chiffre, nonce, kek);
}

export function chiffrer(clair: string, dek: Buffer): { chiffre: Buffer; nonce: Buffer } {
  return chiffrerOctets(Buffer.from(clair, 'utf-8'), dek);
}

export function dechiffrer(chiffre: Buffer, nonce: Buffer, dek: Buffer): string | null {
  const octets = dechiffrerOctets(chiffre, nonce, dek);
  return octets ? octets.toString('utf-8') : null;
}

/** Comparaison a temps constant, pour tout ce qui ressemble a un jeton. */
export function egalConstant(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const LONGUEUR_MIN = 12;

// Une liste courte des mots de passe les plus repandus. Pas de regle de composition :
// « une majuscule, un chiffre, un symbole » produit « Password1! » et rien d'autre.
const COURANTS = new Set([
  'password', 'motdepasse', 'azerty', 'qwerty', '123456', '1234567890', 'iloveyou',
  'letmein', 'admin', 'welcome', 'monkey', 'dragon', 'football', 'baseball', 'sunshine',
  'princess', 'superman', 'trustno1', 'starwars', 'whatever', 'passw0rd', 'abc123',
  'soleil', 'bonjour', 'coucou', 'chocolat', 'doudou', 'nicolas', 'jetaime', 'loulou',
]);

function noyau(mdp: string): string {
  // On compare le NOYAU : « Motdepasse123 » et « password1234 » ne sont pas des mots de
  // passe differents de « motdepasse » et « password », juste decores.
  return mdp
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
}

export function motDePasseAcceptable(mdp: string): { ok: boolean; raison?: string } {
  if (mdp.length < LONGUEUR_MIN) {
    return { ok: false, raison: `${LONGUEUR_MIN} caracteres au minimum` };
  }
  if (COURANTS.has(noyau(mdp))) {
    return { ok: false, raison: 'ce mot de passe figure parmi les plus repandus' };
  }
  return { ok: true };
}
