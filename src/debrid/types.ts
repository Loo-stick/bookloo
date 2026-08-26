// Interface commune aux debrideurs.
//
// TROIS CAPACITES DECLAREES, LA OU DRAMALLYU N'AVAIT QU'UN BOOLEEN. Le
// `supportsCacheCheck` unique repondait en fait a deux questions differentes, et
// l'interface ne permettait pas de les distinguer :
//
//   - « sait-il repondre sur la mise en cache ? »   -> supporteVerificationCache
//   - « le demander touche-t-il mon compte ? »      -> verificationDepose
//
// La distinction n'est pas theorique. AllDebrid a supprime son endpoint de
// disponibilite instantanee : la seule facon de connaitre l'etat d'un hash est
// `POST /magnet/upload`, qui DEPOSE le magnet — et si le torrent n'est pas en cache,
// AllDebrid commence a le telecharger. Interroger, chez lui, c'est envoyer.
//
// L'interface porte donc l'information, et l'interface utilisateur s'en deduit sans
// qu'aucun « si c'est AllDebrid » ne soit ecrit en dur nulle part.

export type EtatCache = 'en-cache' | 'absent' | 'inconnu';

export interface FichierDebride {
  id?: number | string;
  nom: string;
  taille?: number;
  lien?: string;
}

export interface ResultatVerification {
  etat: EtatCache;
  /** Le depot a-t-il ete retire ? `null` quand la verification n'a rien depose. */
  retire: boolean | null;
  message: string;
}

export interface DebridService {
  nom: 'alldebrid' | 'torbox';
  supporteVerificationCache: boolean;
  verificationDepose: boolean;
  supporteZip: boolean;

  /** hash -> etat. Une entree absente vaut 'inconnu', JAMAIS 'absent'. */
  verifierCache(hashes: string[], signal?: AbortSignal): Promise<Map<string, EtatCache>>;

  /** Depose le torrent et rend son identifiant cote debrideur. */
  deposer(hash: string, torrentUrl?: string, signal?: AbortSignal): Promise<string | null>;

  /**
   * L'identifiant de cette release SI elle est deja sur le compte, `null` sinon.
   *
   * POURQUOI CETTE METHODE EXISTE. Recuperer le `.torrent` d'un tracker prive ENREGISTRE
   * un telechargement chez lui, et son annonceur porte le passkey : le debrideur leeche
   * ensuite au nom de l'utilisateur, avec l'obligation de seed qui va avec. Signale a
   * l'usage — un tableau de bord C411 plein de telechargements pour des releases
   * seulement consultees.
   *
   * Le `.torrent` est donc reserve au DEPOT EXPLICITE. Tout le reste — lister les
   * fichiers, lire, fabriquer une archive — passe par ici et se contente de ce que le
   * debrideur connait deja.
   */
  trouver(hash: string, signal?: AbortSignal): Promise<string | null>;

  listerFichiers(idOuHash: string, signal?: AbortSignal): Promise<FichierDebride[]>;

  /** Lien HTTP telechargeable pour UN fichier. */
  lienFichier(
    idOuHash: string,
    idFichier: string | number,
    signal?: AbortSignal,
  ): Promise<string | null>;

  /** Archive de tous les fichiers, cote debrideur. `null` si supporteZip est faux. */
  lienZip(idOuHash: string, signal?: AbortSignal): Promise<string | null>;
}

const PRIORITE: Record<EtatCache, number> = { inconnu: 0, absent: 1, 'en-cache': 2 };

/**
 * Combine plusieurs sources d'etat pour un meme lot de hashs.
 *
 * L'ordre de priorite est `en-cache` > `absent` > `inconnu`, et il ne depend pas de
 * l'ordre des sources : StremThru, qui ne sait dire que « oui », ne doit jamais faire
 * regresser un « non » venu de TorBox, ni l'inverse.
 *
 * Tout hash demande figure dans le resultat. Sans cela, l'appelant ne pourrait pas
 * distinguer « pas en cache » de « pas interroge » — et c'est exactement la confusion
 * que l'interface entiere cherche a eviter.
 */
export function fusionnerEtats(
  hashes: string[],
  ...cartes: Map<string, EtatCache>[]
): Map<string, EtatCache> {
  const out = new Map<string, EtatCache>();
  for (const brut of hashes) {
    const h = brut.toLowerCase();
    let meilleur: EtatCache = 'inconnu';
    for (const carte of cartes) {
      const v = carte.get(h);
      if (v && PRIORITE[v] > PRIORITE[meilleur]) meilleur = v;
    }
    out.set(h, meilleur);
  }
  return out;
}
