// CRC32 (IEEE 802.3), incrementiel.
//
// INCREMENTIEL, ET C'EST TOUT L'INTERET. Une archive assemblee au vol voit passer des
// fichiers de soixante Mo : en calculer la somme de controle demanderait de les retenir
// entiers, ce que cette machine ne pardonne pas — 14,6 Go pour trente-deux conteneurs, et
// `earlyoom` qui tue le plus gros processus sous 1,1 Go libres.
//
// On avance donc morceau par morceau, en ne gardant qu'un entier.

/** Table de 256 entrees, calculee une fois au chargement. */
const TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

/**
 * Somme de controle d'une suite de morceaux.
 *
 * `depart` permet d'enchainer : `crc32(b, crc32(a))` vaut `crc32(a puis b)`.
 * La valeur rendue est NON SIGNEE — un CRC s'ecrit sur quatre octets sans signe, et
 * `Buffer.writeUInt32LE` refuse un nombre negatif.
 */
export function crc32(morceau: Buffer, depart = 0): number {
  let c = ~depart;
  for (let i = 0; i < morceau.length; i++) {
    c = TABLE[(c ^ morceau[i]) & 0xff] ^ (c >>> 8);
  }
  return ~c >>> 0;
}
