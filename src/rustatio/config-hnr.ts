// Config de seed H&R par source mangaloo, poussee a Rustatio apres un download qui coute
// du ratio. Valeurs alignees sur /projets/seedbox/CLAUDE.md (sections HnR) au 2026-08-21.
// COUPLING : un ajustement seedbox doit etre repercute ici.

export type ConfigHnr = {
  upload_rate: number;
  download_rate: number;
  completion_percent: number;
  idle_when_no_leechers: boolean;
  stop_at_ratio: number | null;
  stop_at_seed_time: number | null;
};

const BASE = {
  upload_rate: 30,
  download_rate: 1,
  completion_percent: 100,
  idle_when_no_leechers: true,
} as const;

const PAR_SOURCE: Record<string, ConfigHnr> = {
  c411: { ...BASE, stop_at_ratio: 1.5, stop_at_seed_time: 388800 }, // 108h
  tr4ker: { ...BASE, stop_at_ratio: 1.5, stop_at_seed_time: 388800 }, // 108h
  v3x: { ...BASE, stop_at_ratio: 1.5, stop_at_seed_time: 388800 }, // 108h (anti-cheat, pas de H&R documente)
  g3mini: { ...BASE, stop_at_ratio: null, stop_at_seed_time: 864000 }, // 240h (cross-seed Gemini)
  // yggreborn : differe (cf. spec).
};

/** Config H&R d'une source, ou null si non couverte (Ygg, gratuite, inconnue). */
export function configHnrPour(source: string): ConfigHnr | null {
  return PAR_SOURCE[source] ?? null;
}
