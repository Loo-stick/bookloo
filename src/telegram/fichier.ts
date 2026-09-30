// Le fichier d'un message, lu PAR PLAGES.
//
// TELEGRAM N'ACCEPTE PAS N'IMPORTE QUELLE FENETRE : decalage multiple de 4096, taille en
// puissance de deux jusqu'a 1 Mo, et la fenetre ne doit pas enjamber une frontiere de 1 Mo.
// On lit donc la fenetre ALIGNEE qui contient la plage voulue, puis on decoupe. Sans cela,
// le serveur refuse la requete.
import type { FichierDistant } from '../lecture/plages';
import { clientTelegram } from './client';
import { indexMessages } from './index-messages';
import { attenteDeErreur } from './moisson';

const BLOC = 4096;
// 512 Ko est le `MAX_CHUNK_SIZE` de GramJS : la SEULE taille ou `chunkSize == requestSize`,
// donc la seule ou un appel rend exactement une fenetre et ou le decoupage reste le notre.
// Au-dela, GramJS recolle plusieurs requetes en interne pour un bloc que nous ne maitrisons
// plus. C'est aussi une puissance de deux qui divise 1 Mo.
const MAX_FENETRE = 512 * 1024;
// Meme plafond que `lecture/plages.ts` : une plage aberrante ne doit pas s'accumuler en memoire.
const MAX_PLAGE_OCTETS = 16 * 1024 * 1024;

export interface DepsFichier {
  taille: () => Promise<number>;
  lireFenetre: (offset: number, limite: number) => Promise<Buffer>;
  /** Oublie la reference du fichier : la prochaine lecture la redemande a Telegram. */
  rafraichir?: () => void;
}

/**
 * La plus petite fenetre valide pour Telegram contenant `debut`, et `fin` si elle tient.
 *
 * Le decalage est aligne sur la TAILLE de la fenetre (pas seulement sur 4096) : une
 * puissance de deux alignee sur elle-meme ne peut pas enjamber une frontiere de 1 Mo.
 * Si la plage depasse 1 Mo, la fenetre s'arrete a 1 Mo et l'appelant reboucle.
 */
export function fenetreAlignee(debut: number, fin: number): { offset: number; limite: number } {
  const d = Math.max(0, debut);
  for (let limite = BLOC; limite < MAX_FENETRE; limite *= 2) {
    const offset = Math.floor(d / limite) * limite;
    if (offset + limite > fin) return { offset, limite };
  }
  return { offset: Math.floor(d / MAX_FENETRE) * MAX_FENETRE, limite: MAX_FENETRE };
}

/**
 * Le motif LISIBLE et exempt de secret que l'on sait poser sur une erreur de GramJS, ou
 * `null`. Le nommer est le seul moyen d'en tirer un message utile — mais ce n'est PAS ce qui
 * decide de ce qui sort d'ici (voir `motifMontrable`) : un motif cherche dans le texte d'une
 * bibliotheque tierce laisse passer tout ce qu'il ne reconnait pas.
 */
function motifConnu(brut: string): string | null {
  if (/AUTH_KEY_UNREGISTERED|SESSION_REVOKED|SESSION_EXPIRED|USER_DEACTIVATED/i.test(brut)) {
    return 'session Telegram revoquee — reconnectez le compte dans Admin';
  }
  if (/FILE_REFERENCE/i.test(brut)) return 'la reference du fichier Telegram a expire';
  return null;
}

/**
 * Toute erreur qui sort de la lecture Telegram, nommee ou non. C'est la PROVENANCE, pas le
 * texte : une route qui sert AUSSI d'autres sources s'en sert pour appliquer la regle
 * ci-dessous sans faire taire un message de debrideur ou de lien direct.
 */
abstract class ErreurTelegramBase extends Error {}

/**
 * Une erreur dont NOUS avons ecrit le message : sure par construction, et la seule utile —
 * elle dit quoi faire (relancer la moisson, reconnecter le compte, attendre).
 */
class ErreurTelegram extends ErreurTelegramBase {}

/**
 * Une erreur venue de GramJS que l'on ne sait pas nommer. Son texte d'origine n'est pas
 * seulement cache : il n'est PAS CONSERVE. `masquer()` ne connait ni la session ni l'apiHash
 * (il ne couvre que `token=`, `Bearer`, `X-*-Secret:`) et un message de bibliotheque peut
 * porter l'un ou l'autre — le seul moyen sur est de ne jamais le transporter.
 */
class ErreurTelegramOpaque extends ErreurTelegramBase {
  override name = 'ErreurTelegramOpaque';
  constructor() { super(''); }
}

/*
 * AUCUNE DE CES TROIS CLASSES NE SORT D'ICI : une route ne reecrit pas la regle avec son
 * propre `instanceof`, elle pose la question aux deux fonctions ci-dessous.
 */

/**
 * LA decision, une seule pour les trois routes qui exposent une erreur de lecture Telegram
 * (telechargement, visionneuse, liseuse EPUB) : ce que cette erreur a le droit de dire a un
 * navigateur ET a un journal. `null` = rien a montrer, a l'appelant de poser son texte fixe,
 * dans son vocabulaire.
 *
 * Le critere est QUI A ECRIT ce message, pas a quoi il ressemble : nos propres messages sont
 * surs par construction, et ce sont eux qui disent quoi faire.
 */
export function motifMontrable(e: unknown): string | null {
  return e instanceof ErreurTelegram ? e.message : null;
}

/** Vrai si l'erreur sort de la lecture Telegram, quoi qu'elle dise. */
export function vientDeTelegram(e: unknown): boolean {
  return e instanceof ErreurTelegramBase;
}

// Une erreur de GramJS ne dit rien a la personne devant la liseuse : on nomme celles qu'elle
// peut corriger ou attendre, le reste devient opaque. Une erreur DEJA A NOUS traverse telle
// quelle — la reemballer ferait taire un message que nous avons ecrit nous-memes.
function erreurTelegram(e: unknown): Error {
  if (e instanceof ErreurTelegramBase) return e;
  // L'ATTENTE IMPOSEE SE LIT SUR L'ERREUR, PAS SUR SON TEXTE, et c'est le meme lecteur que
  // l'indexation (`attenteDeErreur`). Le `FloodWaitError` de GramJS n'ecrit JAMAIS
  // « FLOOD_WAIT_N » : son message dit « A wait of N seconds is required (caused by
  // upload.GetFile) », la duree vit dans `seconds`, et la classe de base porte
  // `errorMessage: 'FLOOD'` et `code: 420`. Chercher le raccourci ne reconnaissait rien.
  //
  // Tant que `floodSleepThreshold` valait 60, GramJS dormait puis rejouait `upload.GetFile` :
  // la planche arrivait en retard. A zero, elle ARRIVE ICI — et sans cette branche elle
  // echouerait sur un texte fixe generique, alors que dire l'attente est precisement ce que
  // le reglage devait rendre possible.
  //
  // Seul un NOMBRE sort de l'erreur : aucun texte tiers ne traverse.
  const ms = attenteDeErreur(e);
  if (ms !== null) {
    return new ErreurTelegram(`Telegram impose une attente de ${Math.round(ms / 1000)} s avant de continuer`);
  }
  const motif = motifConnu(String((e as Error)?.message ?? ''));
  return motif ? new ErreurTelegram(motif) : new ErreurTelegramOpaque();
}

export async function ouvrirMessageTelegram(
  canalId: number,
  message: number,
  deps: DepsFichier,
): Promise<FichierDistant> {
  void canalId; void message; // l'identite vit dans `deps` ; gardes pour les journaux futurs
  let taille: number;
  try {
    taille = await deps.taille();
  } catch (e) {
    throw erreurTelegram(e);
  }

  return {
    taille,
    lire: async (debut, fin) => {
      // Un drapeau PAR APPEL : deux plages lues en parallele dont la reference expire
      // ensemble ont chacune leur reprise. Partage, le second appel levait sans en avoir eu.
      let referenceRafraichie = false;
      // Un tampon vide se lit comme une fin de fichier : un debut negatif est une erreur.
      if (debut < 0) throw new ErreurTelegram('plage demandee invalide');
      if (fin - debut + 1 > MAX_PLAGE_OCTETS) throw new ErreurTelegram('plage demandee trop grande');
      // Jamais de demande pour des octets qui n'existent pas : `bout` est ramene a la fin du
      // fichier, et la boucle ne tourne pas si la plage est vide ou hors fichier.
      const bout = Math.min(fin, taille - 1);
      const morceaux: Buffer[] = [];
      let position = debut;
      while (position <= bout) {
        const f = fenetreAlignee(position, bout);
        let recu: Buffer;
        try {
          recu = await deps.lireFenetre(f.offset, f.limite);
        } catch (e) {
          // Une reference de fichier vieillit : UNE nouvelle demande, pas davantage, comme
          // la re-resolution des liens dans `lecture/plages.ts`.
          if (!referenceRafraichie && /FILE_REFERENCE/i.test((e as Error).message)) {
            referenceRafraichie = true;
            deps.rafraichir?.();
            continue;
          }
          throw erreurTelegram(e);
        }
        // Fenetre qui n'atteint meme pas `position` alors que le fichier continue (position
        // <= bout < taille) : sans ce garde la boucle redemanderait la meme fenetre a
        // l'infini. On LEVE : rendre un tampon court passerait pour une fin de fichier et
        // la liseuse afficherait une planche corrompue sans rien dire.
        const suivante = f.offset + recu.length;
        if (suivante <= position) {
          throw new ErreurTelegram(`Telegram a rendu une fenetre trop courte a l'octet ${position} sur ${taille}`);
        }
        morceaux.push(recu.subarray(position - f.offset, Math.min(recu.length, bout - f.offset + 1)));
        position = suivante;
      }
      return Buffer.concat(morceaux);
    },
  };
}

/** Les dependances reelles : le message du canal, puis ses fenetres. */
export function depsTelegramReelles(canalId: number, message: number): DepsFichier {
  // LA PROMESSE, PAS LE RESULTAT — meme motif que la fabrication de `client.ts`. Deux plages
  // demandees en meme temps (la visionneuse precharge la planche suivante) voyaient toutes
  // deux « pas encore ouvert » et lancaient chacune un `iterMessages` : deux allers-retours
  // pour un seul message, et deux fois plus de chances de declencher une attente imposee.
  let ouverture: Promise<{ media: unknown; taille: number }> | null = null;
  const assurer = (): Promise<{ media: unknown; taille: number }> => {
    if (ouverture) return ouverture;
    const mienne = (async () => {
      // Un identifiant numerique nu ne se resout pas hors cache d'entites : Telegram veut le
      // nom public, que l'index a retenu a la moisson.
      const nom = indexMessages().canalDe(canalId);
      if (!nom) {
        throw new ErreurTelegram(`le canal ${canalId} est inconnu de l'index Telegram — relancez la moisson dans Admin`);
      }
      const client = await clientTelegram();
      for await (const msg of client.iterMessages(nom, { ids: [message] })) {
        const m = msg as { media?: unknown; document?: { size?: unknown } };
        if (m.media && m.document) {
          return { media: m.media, taille: Number(m.document.size) || 0 };
        }
      }
      throw new ErreurTelegram('ce message Telegram ne porte plus de fichier');
    })();
    ouverture = mienne;
    // Un echec ne reste pas colle : la lecture suivante redemande, comme `client.ts`
    // refabrique apres une connexion ratee.
    mienne.catch(() => { if (ouverture === mienne) ouverture = null; });
    return mienne;
  };
  return {
    taille: async () => (await assurer()).taille,
    rafraichir: () => { ouverture = null; },
    lireFenetre: async (offset, limite) => {
      const { media: fichier } = await assurer();
      const client = await clientTelegram();
      const { iterDownload } = await import('telegram/client/downloads');
      const bigInt = (await import('big-integer')).default;
      // `offset` est un bigInt chez GramJS ; `limit` compte des BLOCS, pas des octets : un
      // seul bloc de `limite` octets.
      for await (const bloc of iterDownload(client as never, {
        file: fichier as never, offset: bigInt(offset), limit: 1, requestSize: limite,
      })) {
        return Buffer.from(bloc as Uint8Array);
      }
      return Buffer.alloc(0);
    },
  };
}

/**
 * Le fichier d'une release Telegram en MODE DIRECT, a partir de son identite `tg:<canal>:<message>`.
 * Partage par la visionneuse, les liseuses et le telechargement : une route n'importe pas
 * d'une autre route, et aucune ne decoupe l'identite a sa facon.
 */
export function distantTelegramDirect(identite: string): Promise<FichierDistant> {
  const [canalId, message] = identite.slice(3).split(':').map(Number);
  return ouvrirMessageTelegram(canalId, message, depsTelegramReelles(canalId, message));
}
