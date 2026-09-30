import { allDebrid } from './alldebrid';
import { torbox } from './torbox';
import type { DebridService } from './types';

export type NomService = 'alldebrid' | 'torbox';

export function service(nom: NomService, cle: string): DebridService {
  return nom === 'alldebrid' ? allDebrid(cle) : torbox(cle);
}
