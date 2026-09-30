// La connexion par telephone, en DEUX TEMPS.
//
// Elle existe parce que le code de Telegram arrive HORS du navigateur : le serveur garde une
// connexion en cours entre deux requetes HTTP, et resout la promesse du rappel `code()`
// quand l'utilisateur le saisit dans Admin.
import { ecrireReglage, getSettings } from '../core/settings';
import { construireClient, oublierClient } from './client';
import { reglagesTelegram } from './reglages';

export type Etat = 'absente' | 'code-demande' | 'mdp-demande' | 'ouverte' | 'echec';
export interface EtatConnexion { etat: Etat; message?: string }

export interface DepsConnexion {
  connecter: (rappels: {
    code: () => Promise<string>;
    motDePasse: (indice?: string) => Promise<string>;
  }) => Promise<string>;
  enregistrerSession: (session: string) => void;
}

// Une connexion en cours. L'IDENTITE de l'objet sert de jeton, comme `Fabrication` dans
// client.ts : tout rappel asynchrone verifie qu'il parle encore pour `courante`, sinon il se
// tait. Sans cela, l'hebergeur qui recharge sa page laissait l'ancienne connexion en vol,
// capable d'ecrire sa session apres celle de la nouvelle ou de noircir son etat.
interface Connexion {
  etat: Etat;
  message?: string;
  attendCode?: (code: string) => void;
  attendMdp?: (mdp: string) => void;
  abandonner: () => void;
  ecouteurs: Set<() => void>;
}

let courante: Connexion | null = null;

// Telegram juge un code en quelques centaines de ms a quelques secondes ; passe ce delai on
// rend l'etat tel quel et le navigateur interroge de nouveau.
const DELAI_VERDICT_MS = 20000;

export function etatConnexion(): EtatConnexion {
  if (!courante) return reglagesTelegram().session ? { etat: 'ouverte' } : { etat: 'absente' };
  return { etat: courante.etat, message: courante.message };
}

function changer(moi: Connexion, etat: Etat, message?: string): void {
  moi.etat = etat;
  moi.message = message;
  for (const f of [...moi.ecouteurs]) f();
}

/** Abandonne la connexion en cours : ses promesses en attente sont rejetees, pas laissees pendantes. */
export function abandonnerConnexion(): void {
  const ancienne = courante;
  courante = null;
  if (!ancienne) return;
  ancienne.attendCode = undefined;
  ancienne.attendMdp = undefined;
  ancienne.abandonner();
  for (const f of [...ancienne.ecouteurs]) f();
}

const depsReelles: DepsConnexion = {
  connecter: async (rappels) => {
    const r = reglagesTelegram();
    // La MEME construction que `client.ts` : journal de GramJS muet, attentes imposees
    // rendues plutot qu'avalees. Un second constructeur ici aurait reintroduit les deux
    // defauts sur le chemin ou le NOM DU TITULAIRE est justement journalise a la connexion.
    const c = await construireClient('', r.apiId, r.apiHash);
    try {
      await c.start({
        phoneNumber: async () => String(getSettings().telegram.telephone || ''),
        phoneCode: rappels.code,
        password: rappels.motDePasse,
        // DOIT lever. GramJS (signInUser) boucle : a chaque erreur il appelle onError et ne
        // s'arrete que si celui-ci rend une valeur vraie. Un onError qui rendrait undefined
        // ferait retenter sans fin la connexion avec un code deja refuse.
        onError: (e) => { throw e; },
      });
      return String(c.session.save());
    } finally {
      // Ce client ne sert qu'a obtenir la session (le vrai est refabrique par client.ts) :
      // sans cela, chaque tentative laisserait une socket ouverte vers Telegram.
      try { await c.disconnect(); } catch { /* deja ferme */ }
    }
  },
  enregistrerSession: (session) => {
    ecrireReglage(['telegram', 'session'], session);
    oublierClient();
  },
};

export async function demarrerConnexion(deps: DepsConnexion = depsReelles): Promise<EtatConnexion> {
  abandonnerConnexion();

  let rejeterCode: (e: Error) => void = () => {};
  let rejeterMdp: (e: Error) => void = () => {};
  const moi: Connexion = {
    etat: 'code-demande',
    ecouteurs: new Set(),
    abandonner: () => {
      const e = new Error('CONNEXION_ABANDONNEE');
      rejeterCode(e);
      rejeterMdp(e);
    },
  };
  const code = new Promise<string>((ok, ko) => { moi.attendCode = ok; rejeterCode = ko; });
  const mdp = new Promise<string>((ok, ko) => { moi.attendMdp = ok; rejeterMdp = ko; });
  // Ces promesses sont rejetees a l'abandon meme si personne ne les attend (le mot de passe
  // n'est reclame que par certains comptes) : sans ce filet, Node tuerait le processus sur
  // un rejet non gere.
  code.catch(() => {});
  mdp.catch(() => {});
  courante = moi;

  // La connexion tourne EN FOND : la requete HTTP repond « code demande » tout de suite.
  void deps.connecter({
    code: () => code,
    motDePasse: async (indice) => {
      changer(moi, 'mdp-demande', indice);
      return mdp;
    },
  })
    .then((session) => {
      if (moi !== courante) return;
      deps.enregistrerSession(session);
      changer(moi, 'ouverte');
    })
    .catch((e) => {
      changer(moi, 'echec', motifLisible(e instanceof Error ? e.message : ''));
    });
  return { etat: 'code-demande' };
}

/** Les codes d'erreur de Telegram, dits en francais. Rien d'autre ne sort de ce module. */
function motifLisible(brut: string): string {
  if (/PHONE_CODE_INVALID|PHONE_CODE_EXPIRED/i.test(brut)) return 'code refuse ou expire, recommencez';
  if (/PASSWORD_HASH_INVALID/i.test(brut)) return 'mot de passe a deux facteurs refuse';
  if (/PHONE_NUMBER_INVALID/i.test(brut)) return 'numero de telephone refuse par Telegram';
  return 'la connexion a echoue, reessayez';
}

/** Rend l'etat des que la connexion quitte `avant` (ou est abandonnee), ou au bout du delai. */
function attendreVerdict(moi: Connexion, avant: Etat, delaiMs: number): Promise<EtatConnexion> {
  return new Promise((fini) => {
    const sortir = () => {
      clearTimeout(minuteur);
      moi.ecouteurs.delete(sortir);
      fini(etatConnexion());
    };
    const minuteur = setTimeout(sortir, delaiMs);
    moi.ecouteurs.add(sortir);
    if (moi !== courante || moi.etat !== avant) sortir();
  });
}

export async function donnerCode(code: string, delaiMs = DELAI_VERDICT_MS): Promise<EtatConnexion> {
  const moi = courante;
  if (!moi) return { etat: 'echec', message: 'aucune connexion en cours' };
  // Le code n'est accepte qu'a son heure, une seule fois : un double clic ne doit pas
  // repondre « echec » a une connexion qui va bien.
  if (moi.etat !== 'code-demande' || !moi.attendCode) return etatConnexion();
  const donner = moi.attendCode;
  moi.attendCode = undefined;
  donner(String(code || ''));
  return attendreVerdict(moi, 'code-demande', delaiMs);
}

export async function donnerMotDePasse(mdp: string, delaiMs = DELAI_VERDICT_MS): Promise<EtatConnexion> {
  const moi = courante;
  if (!moi) return { etat: 'echec', message: 'aucune connexion en cours' };
  // Trop tot : Telegram n'a encore rien reclame. Le mot de passe donne d'avance serait servi
  // comme s'il venait du bon moment.
  if (moi.etat === 'code-demande') return { etat: 'echec', message: 'Telegram ne demande pas de mot de passe pour le moment' };
  // Deja donne (double clic) ou verdict rendu : la connexion est saine, pas d'echec a afficher.
  if (moi.etat !== 'mdp-demande' || !moi.attendMdp) return etatConnexion();
  const donner = moi.attendMdp;
  moi.attendMdp = undefined;
  donner(String(mdp || ''));
  return attendreVerdict(moi, 'mdp-demande', delaiMs);
}

/** Pour les tests : nombre d'ecouteurs de verdict encore accroches a la connexion courante. */
export function ecouteursEnAttente(): number {
  return courante?.ecouteurs.size ?? 0;
}
