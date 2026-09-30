// Le client GramJS de l'instance, cree AU PREMIER USAGE et jamais a l'import.
//
// La fabrique est remplacable : c'est ce qui permet de tester la moisson et la lecture sans
// reseau, exactement comme `resolveurCt` accepte ses dependances.
import type { TelegramClient } from 'telegram';
import { modeDirectPret, reglagesTelegram, type ReglagesTelegram } from './reglages';

export interface ClientMinimal {
  connect(): Promise<unknown>;
  invoke(requete: unknown): Promise<unknown>;
  // `cible` est un nom public (chaine) ou un `Api.PeerChannel` pour un canal prive : GramJS
  // accepte les deux, et un canal sans nom public n'est atteignable que par le second.
  iterMessages(cible: unknown, options: Record<string, unknown>): AsyncIterable<unknown>;
  getEntity(cible: unknown): Promise<{ id: unknown }>;
  disconnect?(): Promise<unknown>;
  downloadFile?(...args: unknown[]): unknown;
}

export type Fabrique = (r: ReglagesTelegram) => Promise<ClientMinimal>;

// Empreinte des reglages : si elle change, un nouveau client est fabrique.
interface Empreinte {
  apiId: number;
  apiHash: string;
  session: string;
}

// UN SEUL etat : la fabrication courante et, une fois finie, son client. Trois variables
// paralleles (client, promesse, empreinte) se contredisaient a chaque correction ; ici
// l'empreinte et le client ne peuvent pas diverger, et l'identite de l'objet sert de jeton
// pour savoir si une fabrication en vol a ete abandonnee.
interface Fabrication {
  empreinte: Empreinte;
  promesse: Promise<ClientMinimal>;
  client: ClientMinimal | null; // rempli quand la fabrication a abouti ET n'est pas abandonnee
}

let actif: Fabrication | null = null;
let fabrique: Fabrique | null = null;

function empreinte(r: ReglagesTelegram): Empreinte {
  return { apiId: r.apiId, apiHash: r.apiHash, session: r.session };
}

function memeEmpreinte(a: Empreinte, b: Empreinte): boolean {
  return a.apiId === b.apiId && a.apiHash === b.apiHash && a.session === b.session;
}

// Un disconnect qui leve de facon SYNCHRONE ne doit jamais remonter : il ferait echouer un
// remplacement ou un oubli, alors que le client est deja jete de toute facon.
function deconnecter(c: ClientMinimal): void {
  try {
    c.disconnect?.().catch(() => {});
  } catch {
    // ignore
  }
}

// Le seul geste qui abandonne l'etat courant. Une fabrication encore en vol se reconnait
// abandonnee a ce que `actif` n'est plus elle : elle deconnectera son client en arrivant.
function detacher(): void {
  const ancien = actif;
  actif = null;
  if (ancien?.client) deconnecter(ancien.client);
}

/** Pour les tests : impose une fabrique, ou la retire avec `null`. */
export function poserFabrique(f: Fabrique | null): void {
  fabrique = f;
  detacher();
}

export function oublierClient(): void {
  detacher();
}

/**
 * LE SEUL ENDROIT OU UN `TelegramClient` EST CONSTRUIT — `auth.ts` passe par ici aussi.
 *
 * Deux defauts de GramJS s'y annulent, et aucun faux client ne peut les montrer :
 *
 * - SANS `baseLogger`, GramJS se fabrique un `Logger` de niveau `INFO` qui ecrit par un
 *   `console.log` DIRECT, donc hors de `core/journal.ts` et hors de `masquer()`. Il dirait le
 *   NOM D'AFFICHAGE du titulaire du compte a chaque connexion — precisement le rattachement a
 *   un compte personnel que ce mode existe pour supprimer —, une ligne par fenetre de 512 Ko
 *   lue (environ 930 pour un tome de 477 Mo), les adresses de centre de donnees et les
 *   attentes imposees. `LogLevel.NONE` ne passe aucun niveau (`canSend` cherche « none » dans
 *   une liste qui ne le contient pas).
 * - SANS `floodSleepThreshold: 0`, il vaut 60 : GramJS dort lui-meme puis rejoue la requete
 *   pour toute attente imposee de 60 s ou moins. Elle ne remonterait jamais a
 *   `attenteDeErreur`, ne decompterait jamais les tours sans progres, ne serait jamais vue par
 *   le signal d'annulation, et la liseuse se figerait au lieu de dire l'attente. A zero, toute
 *   attente remonte en `FloodWaitError` et c'est NOTRE `dormir` qui la gere.
 *
 * `LogLevel` vient de `telegram/extensions/Logger` : `telegram/extensions` ne reexporte que
 * `Logger`, et un `LogLevel` indefini rendrait le niveau `INFO` par defaut, en silence.
 */
export async function construireClient(
  session: string, apiId: number, apiHash: string,
): Promise<TelegramClient> {
  // Import PARESSEUX : une instance sans Telegram ne charge jamais GramJS ni ses quatorze
  // dependances.
  const { TelegramClient: Classe } = await import('telegram');
  const { StringSession } = await import('telegram/sessions');
  const { Logger, LogLevel } = await import('telegram/extensions/Logger');
  return new Classe(new StringSession(session), apiId, apiHash, {
    connectionRetries: 3,
    baseLogger: new Logger(LogLevel.NONE),
    floodSleepThreshold: 0,
  });
}

const fabriqueReelle: Fabrique = async (r) => {
  const c = await construireClient(r.session, r.apiId, r.apiHash);
  try {
    await c.connect();
  } catch (err) {
    // Si la connexion echoue, deconnecter le client plutot que de le laisser
    // avec ses tentatives de reconnexion.
    deconnecter(c);
    throw err;
  }
  return c as unknown as ClientMinimal;
};

export async function clientTelegram(): Promise<ClientMinimal> {
  const r = reglagesTelegram();
  const emp = empreinte(r);

  // Memes reglages : le client pret, ou la fabrication en cours, sont reutilises.
  if (actif && memeEmpreinte(actif.empreinte, emp)) {
    return actif.client ?? actif.promesse;
  }

  if (!modeDirectPret(r)) {
    throw new Error('Telegram n est pas configure sur cette instance — connectez un compte dans Admin');
  }

  // Reglages differents : l'ancien client est deconnecte AVANT d'en fabriquer un autre, sinon
  // sa session reste ouverte cote Telegram.
  detacher();

  const entree: Fabrication = {
    empreinte: emp,
    client: null,
    promesse: (fabrique ?? fabriqueReelle)(r).then(
      (c) => {
        if (actif !== entree) {
          // Oubliee ou remplacee pendant l'ouverture : ne surtout pas l'installer.
          deconnecter(c);
          throw new Error('la connexion Telegram a ete remplacee pendant son ouverture — reessayez');
        }
        entree.client = c;
        return c;
      },
      (err) => {
        // Un echec ne doit pas rester colle : le prochain appel refabrique.
        if (actif === entree) actif = null;
        throw err;
      },
    ),
  };
  actif = entree;
  return entree.promesse;
}
