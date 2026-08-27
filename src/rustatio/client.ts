import type { ConfigRustatio } from './config';
import type { ConfigHnr } from './config-hnr';
import type { InstanceRustatio } from './instances';
import { getJson, postMultipart, postJson, patchJson, del } from '../core/http';

export type ResultatSeed = { statut: 'seede' | 'echec'; raison?: string };

const TIMEOUT = 15000;

function entetes(cfg: ConfigRustatio): Record<string, string> {
  return cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {};
}

/**
 * Reproduit ce que fait l'UI Rustatio pour ajouter un torrent (addInstance) :
 *   1. POST /api/instances                  -> cree une instance vide, renvoie son id
 *   2. POST /api/instances/{id}/torrent      -> charge le .torrent DANS cette instance
 *   3. PATCH /api/instances/{id}/config      -> applique la config H&R (merge)
 *   4. POST /api/faker/{id}/resume           -> demarre le seed
 *
 * On tient l'id des la creation : pas besoin de matcher par info_hash. Best-effort :
 * n'echoue jamais bruyamment. Si une etape apres la creation echoue, on SUPPRIME
 * l'instance pour ne pas laisser d'orpheline vide dans Rustatio.
 */
export async function seederRelease(cfg: ConfigRustatio, torrent: Buffer, hnr: ConfigHnr): Promise<ResultatSeed> {
  const h = entetes(cfg);

  const cree = await postJson<{ data?: { id?: string }; id?: string }>(
    `${cfg.url}/api/instances`, {}, { headers: h, timeoutMs: TIMEOUT },
  );
  const id = cree?.data?.id ?? cree?.id;
  if (!id) return { statut: 'echec', raison: 'create-refuse' };

  const r = await chargerConfigurerResume(cfg, id, torrent, hnr, h);
  // L'instance qu'on vient de creer ne doit survivre QUE si on l'a remplie et lancee.
  // Echec, ou doublon (le torrent est deja une AUTRE instance) -> on la supprime.
  if (r.statut === 'echec' || r.raison === 'deja-present') {
    await del(`${cfg.url}/api/instances/${id}?force=true`, { headers: h, timeoutMs: TIMEOUT });
  }
  return r;
}

async function chargerConfigurerResume(
  cfg: ConfigRustatio,
  id: string,
  torrent: Buffer,
  hnr: ConfigHnr,
  h: Record<string, string>,
): Promise<ResultatSeed> {
  // 2) charger le .torrent dans l'instance (multipart, champ "file")
  const form = new FormData();
  form.append('file', new Blob([torrent]), 'release.torrent');
  const charge = await postMultipart<{ success?: boolean; error?: string }>(
    `${cfg.url}/api/instances/${id}/torrent`, form, { headers: h, timeoutMs: TIMEOUT },
  );
  if (charge === null) return { statut: 'echec', raison: 'load-injoignable' };
  if (/duplicate|already imported/i.test(String(charge.data?.error ?? ''))) {
    // Deja seede dans Rustatio (ex. ajoute a la main via le bot) -> H&R deja couvert.
    return { statut: 'seede', raison: 'deja-present' };
  }
  if (charge.status < 200 || charge.status >= 300 || charge.data?.success === false) {
    return { statut: 'echec', raison: 'load-refuse' };
  }

  // 3) config H&R : lire la config courante de l'instance et merger (comme le bot)
  const corps = await getJson<{ data?: InstanceRustatio[] }>(`${cfg.url}/api/instances`, {
    headers: h, timeoutMs: TIMEOUT, retries: 0,
  });
  const base = (corps?.data ?? []).find((i) => i.id === id)?.config ?? {};
  const ok = await patchJson(`${cfg.url}/api/instances/${id}/config`, { ...base, ...hnr }, { headers: h, timeoutMs: TIMEOUT });
  if (!ok) return { statut: 'echec', raison: 'config-refusee' };

  // 4) resume
  const resume = await postJson(`${cfg.url}/api/faker/${id}/resume`, {}, { headers: h, timeoutMs: TIMEOUT });
  if (resume === null) return { statut: 'echec', raison: 'resume-refuse' };

  return { statut: 'seede' };
}
