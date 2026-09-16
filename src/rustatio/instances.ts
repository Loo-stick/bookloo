export type InstanceRustatio = {
  id: string;
  config: Record<string, unknown>;
  torrent?: { info_hash?: unknown };
};

/** Rustatio renvoie info_hash comme tableau d'octets. On le rend en hex minuscule. */
export function hashHexDeInfohash(infohash: unknown): string | null {
  if (!Array.isArray(infohash) || infohash.length === 0) return null;
  if (!infohash.every((b) => typeof b === 'number' && b >= 0 && b <= 255)) return null;
  return infohash.map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function trouverInstanceParHash(
  instances: InstanceRustatio[],
  hashHex: string,
): InstanceRustatio | null {
  const cible = hashHex.toLowerCase();
  for (const inst of instances) {
    const h = hashHexDeInfohash(inst.torrent?.info_hash);
    if (h && h === cible) return inst;
  }
  return null;
}
