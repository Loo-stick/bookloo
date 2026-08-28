// Fichier de config a chaud, greffe de LooStream (src/endpoint-config.ts).
//
// Chaque source dont le domaine tourne (KissKH, VoirDrama, Zone-Telechargement,
// Wawacity, les Torznab...) pose son JSON sous config/. Le dossier est bind-monte
// dans docker-compose : l'operateur corrige un domaine SANS rebuild, SANS restart
// (fs.watch), et un endpoint admin peut forcer le rechargement.

import * as fs from 'fs';
import * as path from 'path';

export interface EndpointConfig<T> {
  get: () => T;
  reload: () => T;
  path: string;
}

export function makeEndpointConfig<T extends Record<string, unknown>>(
  fileName: string,
  envVar: string,
  defaults: T,
): EndpointConfig<T> {
  const configPath =
    process.env[envVar] ||
    (fs.existsSync(`/app/config/${fileName}`)
      ? `/app/config/${fileName}`
      : path.join(process.cwd(), 'config', fileName));

  let current: T = { ...defaults };

  const load = (): T => {
    try {
      if (fs.existsSync(configPath)) {
        const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        // Fusion PAR-DESSUS les defauts : un fichier partiel (ou portant une cle
        // inconnue comme _commentaire) ne peut jamais faire disparaitre un champ requis.
        current = { ...defaults, ...raw };
      } else {
        current = { ...defaults };
      }
    } catch (e) {
      console.error(`[Config] ${fileName}: ${(e as Error).message} — defauts appliques`);
      current = { ...defaults };
    }
    return current;
  };

  load();

  try {
    if (fs.existsSync(configPath)) {
      fs.watch(configPath, (eventType) => {
        if (eventType === 'change') {
          console.log(`[Config] ${fileName} modifie, rechargement`);
          setTimeout(load, 100);
        }
      });
    }
  } catch {
    // fs.watch indisponible sur cette plateforme : le rechargement reste possible
    // via l'endpoint admin.
  }

  return { get: () => current, reload: load, path: configPath };
}
