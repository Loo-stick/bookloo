// Ecriture d'une archive ZIP « stockee », en flux.
//
// Fonctions PURES : chacune rend un bloc d'octets. Rien ici ne lit un fichier ni n'ecrit
// sur une socket — c'est la route qui enchaine. Un format binaire se teste octet par
// octet, et ne se devine pas.
//
// SANS COMPRESSION, DELIBEREMENT. Un mp3, un flac, un m4b sont deja compresses : les
// passer au deflate couterait du calcul pour gagner zero. Il en decoule deux proprietes
// qui portent toute la conception.
//
//   1. LA TAILLE FINALE EST CONNUE D'AVANCE. Les tailles viennent du debrideur et les
//      en-tetes ont une longueur deterministe : on annonce un `Content-Length` exact, donc
//      une vraie barre de progression au lieu d'un telechargement sans fin.
//
//   2. LE MODE ZIP64 SE DECIDE UNE FOIS, AVANT LE PREMIER OCTET. Au-dela de 4 Go le format
//      d'origine ne sait plus coder les tailles — cas reel, « La Trilogie des fourmis »
//      pese 4 338 Mo. Connaissant tout d'avance, on choisit et on s'y tient : pas de
//      bascule en cours d'ecriture, donc pas de branche ou se cacherait un defaut qui ne
//      se verrait qu'a l'ouverture, chez l'utilisateur.

const SIG_LOCAL = 0x04034b50;
const SIG_DESCRIPTEUR = 0x08074b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_FIN_ZIP64 = 0x06064b50;
const SIG_LOCALISATEUR_ZIP64 = 0x07064b50;
const SIG_FIN = 0x06054b50;

/** Valeur qui signifie « regarde dans le champ ZIP64 ». */
const DEBORDE_32 = 0xffffffff;
const DEBORDE_16 = 0xffff;

/**
 * Drapeaux : bit 3 « le CRC suit les donnees », bit 11 « le nom est en UTF-8 ».
 *
 * Le bit 3 est ce qui rend l'assemblage au vol possible : on diffuse depuis le debrideur,
 * donc le CRC n'est connu qu'une fois les octets passes.
 *
 * La difficulte habituelle de ce mode — un lecteur ne sait pas ou s'arretent les donnees —
 * NE SE POSE PAS ICI, parce qu'on connait les tailles : elles sont ecrites dans l'en-tete
 * local, et seul le CRC y vaut zero.
 */
const DRAPEAUX = 0x0008 | 0x0800;

/** 1980-01-01, valeur conventionnelle d'« aucune date ». Fixe, donc sortie reproductible. */
const DATE_DOS = 0x0021;
const HEURE_DOS = 0x0000;

export interface FichierArchive {
  /** Chemin dans l'archive. Encode en UTF-8, d'ou le bit 11 des drapeaux. */
  nom: string;
  octets: number;
}

const nomEnOctets = (nom: string) => Buffer.from(nom, 'utf8');

/**
 * Le nombre d'entrees qu'un annuaire central non-ZIP64 sait compter.
 *
 * C'est un champ de SEIZE bits dans le format, pas trente-deux : la limite sur le nombre
 * de fichiers arrive 65 000 fois plus tot que celle sur les tailles.
 */
const MAX_ENTREES_ZIP32 = 65535;

/**
 * Faut-il le mode ZIP64 ?
 *
 * Vrai des qu'un fichier ou l'archive entiere approche 4 Go, ET des que le NOMBRE de
 * fichiers approche 65 535. La comparaison porte sur la somme des donnees plus une marge
 * large pour les en-tetes : etre trop prudent ne coute que quelques dizaines d'octets,
 * l'inverse produit une archive corrompue.
 *
 * LE NOMBRE D'ENTREES A ETE OUBLIE. Seules les tailles etaient regardees, alors que le
 * compteur d'entrees de l'annuaire central tient sur seize bits : au-dela de 65 535
 * fichiers, l'ecriture produisait une archive dont le pied de page annonce un nombre
 * faux, et cela n'arrivait qu'a la toute fin de la generation — apres que l'utilisateur a
 * attendu. Une integrale de scans depasse cette barre bien avant d'approcher 4 Go.
 * Signale par une revue de code le 2026-08-29.
 */
export function besoinZip64(fichiers: FichierArchive[]): boolean {
  if (fichiers.length >= MAX_ENTREES_ZIP32) return true;
  let total = 0;
  for (const f of fichiers) {
    if (f.octets >= DEBORDE_32) return true;
    total += f.octets + 200 + nomEnOctets(f.nom).length * 2;
  }
  return total >= DEBORDE_32;
}

/** Taille exacte de l'archive, en octets. C'est la valeur annoncee au navigateur. */
export function tailleArchive(fichiers: FichierArchive[], zip64: boolean): number {
  let total = 0;
  for (const f of fichiers) {
    const n = nomEnOctets(f.nom).length;
    total += 30 + n + (zip64 ? 20 : 0); // en-tete local
    total += f.octets; // les donnees, telles quelles
    total += zip64 ? 24 : 16; // descripteur
    total += 46 + n + (zip64 ? 28 : 0); // entree du repertoire central
  }
  total += zip64 ? 56 + 20 + 22 : 22; // fin d'archive
  return total;
}

export function enteteLocal(f: FichierArchive, zip64: boolean): Buffer {
  const nom = nomEnOctets(f.nom);
  const extra = zip64 ? 20 : 0;
  const b = Buffer.alloc(30 + nom.length + extra);
  b.writeUInt32LE(SIG_LOCAL, 0);
  b.writeUInt16LE(zip64 ? 45 : 20, 4);
  b.writeUInt16LE(DRAPEAUX, 6);
  b.writeUInt16LE(0, 8); // methode : stocke
  b.writeUInt16LE(HEURE_DOS, 10);
  b.writeUInt16LE(DATE_DOS, 12);
  b.writeUInt32LE(0, 14); // CRC : inconnu, il suivra les donnees
  b.writeUInt32LE(zip64 ? DEBORDE_32 : f.octets, 18);
  b.writeUInt32LE(zip64 ? DEBORDE_32 : f.octets, 22);
  b.writeUInt16LE(nom.length, 26);
  b.writeUInt16LE(extra, 28);
  nom.copy(b, 30);
  if (zip64) {
    const p = 30 + nom.length;
    b.writeUInt16LE(0x0001, p);
    b.writeUInt16LE(16, p + 2);
    b.writeBigUInt64LE(BigInt(f.octets), p + 4);
    b.writeBigUInt64LE(BigInt(f.octets), p + 12);
  }
  return b;
}

/** Le CRC et les tailles, APRES les donnees. Voir `DRAPEAUX`. */
export function descripteur(crc: number, octets: number, zip64: boolean): Buffer {
  const b = Buffer.alloc(zip64 ? 24 : 16);
  b.writeUInt32LE(SIG_DESCRIPTEUR, 0);
  b.writeUInt32LE(crc >>> 0, 4);
  if (zip64) {
    b.writeBigUInt64LE(BigInt(octets), 8);
    b.writeBigUInt64LE(BigInt(octets), 16);
  } else {
    b.writeUInt32LE(octets, 8);
    b.writeUInt32LE(octets, 12);
  }
  return b;
}

/**
 * Une entree du repertoire central. C'est ELLE que lisent les outils, et elle porte le
 * vrai CRC — celui de l'en-tete local vaut zero.
 */
export function entreeCentrale(
  f: FichierArchive, crc: number, decalage: number, zip64: boolean,
): Buffer {
  const nom = nomEnOctets(f.nom);
  const extra = zip64 ? 28 : 0;
  const b = Buffer.alloc(46 + nom.length + extra);
  b.writeUInt32LE(SIG_CENTRAL, 0);
  b.writeUInt16LE(zip64 ? 45 : 20, 4); // version d'ecriture
  b.writeUInt16LE(zip64 ? 45 : 20, 6); // version requise pour lire
  b.writeUInt16LE(DRAPEAUX, 8);
  b.writeUInt16LE(0, 10);
  b.writeUInt16LE(HEURE_DOS, 12);
  b.writeUInt16LE(DATE_DOS, 14);
  b.writeUInt32LE(crc >>> 0, 16);
  b.writeUInt32LE(zip64 ? DEBORDE_32 : f.octets, 20);
  b.writeUInt32LE(zip64 ? DEBORDE_32 : f.octets, 24);
  b.writeUInt16LE(nom.length, 28);
  b.writeUInt16LE(extra, 30);
  b.writeUInt16LE(0, 32); // pas de commentaire
  b.writeUInt16LE(0, 34); // disque 0
  b.writeUInt16LE(0, 36);
  b.writeUInt32LE(0, 38);
  b.writeUInt32LE(zip64 ? DEBORDE_32 : decalage, 42);
  nom.copy(b, 46);
  if (zip64) {
    const p = 46 + nom.length;
    b.writeUInt16LE(0x0001, p);
    b.writeUInt16LE(24, p + 2);
    b.writeBigUInt64LE(BigInt(f.octets), p + 4);
    b.writeBigUInt64LE(BigInt(f.octets), p + 12);
    b.writeBigUInt64LE(BigInt(decalage), p + 20);
  }
  return b;
}

/** La fin de l'archive : le localisateur ZIP64 quand il le faut, puis l'enregistrement. */
export function finDArchive(
  nEntrees: number, tailleCentrale: number, debutCentral: number, zip64: boolean,
): Buffer {
  const fin = Buffer.alloc(22);
  fin.writeUInt32LE(SIG_FIN, 0);
  fin.writeUInt16LE(0, 4);
  fin.writeUInt16LE(0, 6);
  fin.writeUInt16LE(zip64 ? DEBORDE_16 : nEntrees, 8);
  fin.writeUInt16LE(zip64 ? DEBORDE_16 : nEntrees, 10);
  fin.writeUInt32LE(zip64 ? DEBORDE_32 : tailleCentrale, 12);
  fin.writeUInt32LE(zip64 ? DEBORDE_32 : debutCentral, 16);
  fin.writeUInt16LE(0, 20);
  if (!zip64) return fin;

  const z = Buffer.alloc(56);
  z.writeUInt32LE(SIG_FIN_ZIP64, 0);
  z.writeBigUInt64LE(BigInt(44), 4); // taille du reste de cet enregistrement
  z.writeUInt16LE(45, 12);
  z.writeUInt16LE(45, 14);
  z.writeUInt32LE(0, 16);
  z.writeUInt32LE(0, 20);
  z.writeBigUInt64LE(BigInt(nEntrees), 24);
  z.writeBigUInt64LE(BigInt(nEntrees), 32);
  z.writeBigUInt64LE(BigInt(tailleCentrale), 40);
  z.writeBigUInt64LE(BigInt(debutCentral), 48);

  const loc = Buffer.alloc(20);
  loc.writeUInt32LE(SIG_LOCALISATEUR_ZIP64, 0);
  loc.writeUInt32LE(0, 4);
  loc.writeBigUInt64LE(BigInt(debutCentral + tailleCentrale), 8);
  loc.writeUInt32LE(1, 16);
  return Buffer.concat([z, loc, fin]);
}
