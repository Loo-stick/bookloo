// Lire les canaux et remplir l'index. Incremental : on repart du dernier message connu.
import { indexMessages, type IndexMessages, type MessageIndexe } from './index-messages';
import { identifiantDeCanal, reglagesTelegram } from './reglages';
import { clientTelegram, type ClientMinimal } from './client';

export interface MessageBrut {
  id: number;
  canalId: number;
  date: number;
  nomFichier: string | null;
  taille: number | null;
}

/** Ce que le passage rapporte pendant qu'il tourne. `lus` et `nouveaux` sont des TOTAUX. */
export interface Avance {
  canal: string;
  /** Messages lus depuis le debut du passage. */
  lus: number;
  /** Messages ECRITS dans l'index. Reste a 0 pendant toute une premiere passe. */
  nouveaux: number;
  /** Secondes d'attente imposees par Telegram, quand il y en a une. */
  attente: number | null;
}

export interface DepsMoisson {
  canaux: string[];
  index: IndexMessages;
  /**
   * Messages LUS au plus pour toute la passe, tous canaux confondus. Sert a la passe
   * AUTOMATIQUE, qui ne doit pas garder le verrou des heures ; le bouton d'Admin n'en met
   * aucun et descend jusqu'au bout, puisqu'il est annulable et reprenable.
   */
  budgetLus?: number;
  dormir: (ms: number) => Promise<void>;
  /** Les messages d'ids STRICTEMENT superieurs a `depuis`, du plus ancien au plus recent. */
  messagesDuCanal: (canal: string, depuis: number) => AsyncIterable<MessageBrut>;
  /** Le pourquoi d'un refus, pour que l'hebergeur sache QUEL canal pose probleme. */
  refus?: (canal: string, raison: string) => void;
  /**
   * L'AVANCEMENT, pour l'ecran d'Admin. Appele au debut de chaque canal, a chaque lot de 200
   * messages, et avant chaque attente imposee.
   *
   * Il existe parce que la moisson ne rend plus la main au bout d'une requete HTTP : sans
   * rapport en cours de route, l'hebergeur n'aurait qu'un bouton grise et aucune idee de ce
   * qui se passe.
   */
  avance?: (a: Avance) => void;
}

const TAILLE_LOT = 200;
// Attentes consecutives SANS aucun progres : au-dela, le canal est declare refuse plutot que
// de boucler indefiniment sur une attente que Telegram renouvelle.
const ATTENTES_SANS_PROGRES = 3;

// Au-dela, on abandonne le canal POUR CETTE PASSE. La moisson tourne en fond depuis le
// 2026-09-30, donc ce n'est plus une requete HTTP qu'on protege : c'est LE VERROU. Un passage
// qui dort une heure garderait le rafraichissement paresseux et le retrait d'un canal bloques
// tout ce temps. L'index est incremental, la passe suivante reprendra.
export const ATTENTE_MAX_MS = 300_000;

/**
 * Le refus d'un canal SUR UNE ATTENTE IMPOSEE, dit comme une attente.
 *
 * `motifSur` ne sait pas la reconnaitre : le vrai `FloodWaitError` de GramJS porte
 * `errorMessage === 'FLOOD'` (sans tiret bas) et « A wait of N seconds is required ». Le
 * laisser tomber en « erreur inconnue » enverrait l'hebergeur chercher un canal casse la ou
 * c'est son COMPTE qui est limite — le premier diagnostic dont il a besoin.
 */
function attenteDite(ms: number, suite: string): string {
  return `attente imposee de ${Math.round(ms / 1000)} s, ${suite}`;
}

/**
 * Un sommeil que le signal d'annulation ecourte, et qui NE LAISSE PAS D'ECOUTEUR derriere lui.
 *
 * Une moisson patiente attend une fois par tour : sans le retrait, au-dela d'une dizaine
 * d'attentes sur le meme signal Node ecrit « Possible EventTarget memory leak » dans le
 * journal — l'avertissement qu'on n'a pas envie d'apprendre a ignorer sur ce serveur.
 */
export function dormirAnnulable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((fin) => {
    const minuteur = setTimeout(() => terminer(), ms);
    function terminer(): void {
      clearTimeout(minuteur);
      signal?.removeEventListener('abort', terminer);
      fin();
    }
    signal?.addEventListener('abort', terminer);
  });
}

/**
 * Le motif d'une erreur, sous une forme qu'on peut journaliser et afficher : le CODE de
 * Telegram (`CHANNEL_PRIVATE`, `USERNAME_NOT_OCCUPIED`), jamais le texte libre.
 *
 * Le message d'une erreur est un texte TIERS : il peut porter n'importe quoi, un numero, un
 * identifiant, une ligne de plus dans le journal. Une forme MAJUSCULE_AVEC_TIRETS_BAS est la
 * seule qu'on laisse passer ; le reste devient « erreur inconnue ».
 */
export function motifSur(e: unknown): string {
  const o = (e ?? {}) as { errorMessage?: unknown; message?: unknown };
  for (const brut of [o.errorMessage, o.message, typeof e === 'string' ? e : undefined]) {
    const m = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/.exec(typeof brut === 'string' ? brut : '');
    if (m) return m[0].slice(0, 64);
  }
  return 'erreur inconnue';
}

/** « FLOOD_WAIT_7 » -> 7000 ms. `null` quand ce n'est pas une attente imposee. */
export function attenteImposee(message: string): number | null {
  const m = /FLOOD_WAIT_(\d+)/i.exec(String(message || ''));
  return m ? Number(m[1]) * 1000 : null;
}

/**
 * L'attente imposee, reconnue sur l'ERREUR. Le `FloodWaitError` de GramJS ne porte pas
 * `FLOOD_WAIT_N` dans son message (« A wait of N seconds is required ») : la duree est dans
 * `seconds`, et la classe de base porte `errorMessage === 'FLOOD'` et `code === 420`. Lire le
 * texte seul ne reconnaitrait jamais l'attente reelle et refuserait le canal a tort.
 */
export function attenteDeErreur(e: unknown): number | null {
  const o = (e ?? {}) as { seconds?: unknown; message?: unknown; errorMessage?: unknown; code?: unknown };
  if (typeof o.seconds === 'number' && Number.isFinite(o.seconds) && o.seconds >= 0) {
    return o.seconds * 1000;
  }
  const texte = String(o.message ?? e ?? '');
  const parLeTexte = attenteImposee(texte);
  if (parLeTexte !== null) return parLeTexte;
  if (o.errorMessage === 'FLOOD' || o.code === 420) {
    const m = /wait of (\d+) seconds/i.exec(texte);
    if (m) return Number(m[1]) * 1000;
  }
  return null;
}

/**
 * L'identifiant numerique d'un canal, en nombre sur. GramJS rend un `bigInt` : passe tel quel
 * dans `tg:<canalId>:<message>`, il donnerait une identite que `estIdentiteTelegram`
 * (`/^tg:\d+:\d+$/`) refuse, et toute la bibliotheque avec. Mieux vaut ne pas moissonner que
 * d'ecrire des identites cassees dans l'index.
 */
export function canalIdSur(id: unknown): number {
  const texte = typeof id === 'number' || typeof id === 'bigint' || (typeof id === 'object' && id !== null)
    ? String(id) : '';
  const n = /^\d+$/.test(texte) ? Number(texte) : NaN;
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new Error('identifiant de canal inexploitable');
  }
  return n;
}

/**
 * UNE SEULE LECTURE : DU PLUS ANCIEN VERS LE PLUS RECENT, depuis le curseur du canal.
 *
 * C'est la methode de mangaloo (`indexer/src/indexer/scraper.py`), et elle est meilleure que
 * celle qu'elle remplace. L'ancienne descendait d'abord pour avoir les parutions recentes en
 * premier, ce qui l'obligeait a garder toute la passe EN MEMOIRE avant d'ecrire : ecrite a
 * moitie, elle aurait laisse les recents, et la passe montante suivante aurait condamne
 * l'historique ancien. D'ou un plafond de profondeur — 5 000 messages par defaut — qui laissait
 * 2 988 fichiers indexes sur les 645 274 d'un canal.
 *
 * En montant depuis un curseur, les trois problemes disparaissent a la fois : le curseur ne
 * depasse jamais ce qui est ecrit, donc une interruption ne perd ni ne saute rien ; la memoire
 * ne depend plus du nombre de messages mais de la taille d'un lot ; et aucun plafond n'est
 * necessaire.
 *
 * La contrepartie, assumee : sur un canal neuf, les plus VIEUX fichiers arrivent d'abord.
 */
export async function moissonner(
  deps: DepsMoisson,
  signal?: AbortSignal,
): Promise<{ lus: number; nouveaux: number; refuses: string[] }> {
  let lus = 0;
  let nouveaux = 0;
  const refuses: string[] = [];

  for (const canal of deps.canaux) {
    if (signal?.aborted) break;
    if (deps.budgetLus && lus >= deps.budgetLus) break;
    let curseur = deps.index.curseur(canal);
    let attentes = 0;

    for (;;) {
      const lot: MessageIndexe[] = [];
      let plusHaut = curseur;
      /**
       * Ecrit le lot PUIS avance le curseur. L'ordre est tout : le curseur ne doit jamais
       * depasser ce qui est en base, sinon une interruption sauterait les messages ecrits
       * nulle part.
       */
      const vider = () => {
        if (lot.length) {
          deps.index.ecrire(lot);
          nouveaux += lot.length;
          lot.length = 0;
        }
        if (plusHaut > curseur) {
          curseur = plusHaut;
          deps.index.noterCurseur(canal, curseur);
        }
        deps.avance?.({ canal, lus, nouveaux, attente: null });
      };
      let progres = false;
      try {
        for await (const m of deps.messagesDuCanal(canal, curseur)) {
          lus += 1;
          progres = true;
          // La position se note AVANT le tri : un message sans fichier a quand meme ete lu, et
          // ne doit pas etre relu au passage suivant.
          if (m.id > plusHaut) plusHaut = m.id;
          if (m.taille !== null) {
            lot.push({
              canal, canalId: m.canalId, message: m.id, nom: m.nomFichier || '',
              taille: m.taille, date: m.date,
            });
            if (lot.length >= TAILLE_LOT) vider();
          }
          if (signal?.aborted) break;
          if (deps.budgetLus && lus >= deps.budgetLus) break;
        }
        vider();
        break;
      } catch (e) {
        // CE QUE LE CANAL A DEJA DONNE EST GARDE, curseur compris, AVANT de decider quoi que
        // ce soit : c'est ce qui rend la reprise exacte.
        //
        // Sous garde : si c'est l'ECRITURE qui a jete, `vider` jettera de nouveau, et cette
        // seconde erreur masquerait la premiere. Le curseur n'a alors pas bouge — la passe
        // suivante relira tout, ce qui est exactement ce qu'on veut.
        try { vider(); } catch { /* l'erreur d'origine est celle qui compte */ }
        const raison = motifSur(e);
        const ms = attenteDeErreur(e);
        if (progres) attentes = 0;
        // TELEGRAM IMPOSE UNE ATTENTE : on dort le temps demande et on reprend AU CURSEUR, qui
        // vient d'avancer. Marteler allongerait l'attente, abandonner perdrait la suite.
        if (ms !== null && ms > ATTENTE_MAX_MS) {
          refuses.push(canal);
          deps.refus?.(canal, attenteDite(ms, 'abandonnee pour cette passe'));
          break;
        }
        if (ms !== null && attentes < ATTENTES_SANS_PROGRES) {
          attentes += 1;
          // L'ATTENTE SE DIT AVANT DE DORMIR : c'est le seul moment ou l'ecran peut expliquer
          // pourquoi rien ne bouge, et la difference entre « mon compte est limite » et « mon
          // canal est casse » est le premier diagnostic dont l'hebergeur a besoin.
          deps.avance?.({ canal, lus, nouveaux, attente: Math.round(ms / 1000) });
          await deps.dormir(ms);
          if (signal?.aborted) break;
          continue;
        }
        // UN CANAL INACCESSIBLE EST NOMME, et les autres continuent. Une attente imposee
        // qu'on renonce a suivre se dit COMME UNE ATTENTE, pas comme une erreur anonyme.
        refuses.push(canal);
        deps.refus?.(canal, ms !== null ? attenteDite(ms, 'renouvelee sans progres') : raison);
        break;
      }
    }
  }
  return { lus, nouveaux, refuses };
}

/** Le nom de fichier vit dans un attribut du document, pas sur le message. */
export function nomDuDocument(document: unknown): string | null {
  const attrs = (document as { attributes?: { fileName?: unknown }[] } | undefined)?.attributes;
  if (!Array.isArray(attrs)) return null;
  for (const a of attrs) {
    if (typeof a?.fileName === 'string' && a.fileName) return a.fileName;
  }
  return null;
}

/**
 * CE QU'ON PRESENTE A GRAMJS POUR DESIGNER UN CANAL.
 *
 * Un canal public se resout par son nom. Un canal prive n'en a aucun : il faut lui presenter son
 * identifiant numerique. C'est le `_cible()` de mangaloo, qui rend un `PeerChannel(n)` a
 * Telethon dans ce cas — sans quoi un canal sans nom public reste hors de portee.
 */
export async function cibleDuCanal(reference: string): Promise<unknown> {
  const n = identifiantDeCanal(reference);
  if (n === null) return reference;
  const { Api } = await import('telegram');
  const bigInt = (await import('big-integer')).default;
  return new Api.PeerChannel({ channelId: bigInt(n) });
}

/** Les messages d'un canal via un client GramJS ; separe de `moissonnerVraiment` pour etre testable. */
export function messagesReels(client: ClientMinimal): DepsMoisson['messagesDuCanal'] {
  return async function* (canal, depuis) {
    // L'identifiant numerique est demande AVANT de lire : sans lui pas d'identite valide, et
    // un canal introuvable leve ici, donc est nomme parmi les refuses.
    // La CIBLE sert aux deux appels : resoudre une seconde fois par son nom couterait une
    // requete, et un canal prive n'a pas de nom a donner.
    const cible = await cibleDuCanal(canal);
    const entite = await client.getEntity(cible);
    const canalId = canalIdSur(entite?.id);
    // TOUJOURS MONTANTE, depuis le curseur. `minId: 0` sur un canal neuf part du tout premier
    // message — c'est exactement ce que fait `iter_messages(min_id=cursor, reverse=True)` de
    // mangaloo, et c'est ce qui rend la passe reprenable sans rien garder en memoire.
    const options: Record<string, unknown> = { minId: depuis, reverse: true };
    for await (const msg of client.iterMessages(cible, options)) {
      const m = msg as { id: number; date: number; document?: { size?: unknown } };
      yield {
        id: m.id, canalId, date: Number(m.date) || 0,
        nomFichier: nomDuDocument(m.document),
        taille: m.document ? Number(m.document.size) || 0 : null,
      };
    }
  };
}

export interface OptionsPasse {
  /** Restreint la passe a ces canaux ; par defaut, tous ceux qui sont regles. */
  canaux?: readonly string[];
  /** Voir `DepsMoisson.budgetLus`. */
  budgetLus?: number;
  /** Voir `DepsMoisson.avance`. */
  avance?: (a: Avance) => void;
}

/** La moisson reelle, branchee sur GramJS. */
export async function moissonnerVraiment(signal?: AbortSignal, options: OptionsPasse = {}) {
  const r = reglagesTelegram();
  const client = await clientTelegram();
  const index = indexMessages();
  const resultat = await moissonner({
    canaux: [...(options.canaux ?? r.canaux)],
    index,
    budgetLus: options.budgetLus,
    dormir: (ms) => dormirAnnulable(ms, signal),
    messagesDuCanal: messagesReels(client),
    refus: (canal, raison) => console.warn(`[telegram] canal refuse : ${canal} (${raison})`),
    avance: options.avance,
  }, signal);
  // LA DATE NE SE POSE QUE SUR UNE PASSE ALLEE AU BOUT : une moisson interrompue (onglet
  // ferme, proxy qui coupe) ne doit pas faire passer l'index pour frais pendant douze heures.
  if (!signal?.aborted) index.noterMoisson(Date.now());
  console.log(`[telegram] ${resultat.nouveaux} message(s) indexe(s), ${resultat.refuses.length} canal(aux) refuse(s)`);
  return resultat;
}

/**
 * La fraicheur de l'index Telegram : 12 h, le seuil de worldivx et de downmagaz — les deux
 * index que `assurer()` reconstruit paresseusement. (1001ebooks tient 24 h, mais son
 * catalogue de 47 000 fiches ne bouge pas au rythme d'un canal de parutions.)
 */
export const FRAICHEUR_MS = 12 * 60 * 60 * 1000;

// UN SEUL PASSAGE A LA FOIS, POUR TOUT LE PROCESSUS. Deux moissons gardent chacune leurs
// messages en memoire, et le conteneur est plafonne a 512 Mo. Le verrou vit ici et pas dans
// la route parce que la route n'est plus le seul appelant : la recherche en lance un aussi.
let passageEnCours: Promise<unknown> | null = null;

/**
 * Lance `faire` si aucun passage ne tourne, et rend sa promesse ; rend `null` — sans rien
 * lancer — si un passage tourne deja.
 */
export function avecVerrouMoisson<T>(faire: () => Promise<T>): Promise<T> | null {
  if (passageEnCours) return null;
  // L'enveloppe `async` transforme un jet SYNCHRONE en rejet : sans elle le verrou resterait
  // pris pour toujours.
  const mien: Promise<T> = (async () => faire())()
    .finally(() => { if (passageEnCours === mien) passageEnCours = null; });
  passageEnCours = mien;
  return mien;
}

/**
 * Prend le verrou de moisson pour un geste SYNCHRONE, ou rend `{ pris: false }` sans rien
 * faire. Sert au PUT d'Admin, qui vide l'index des canaux retires : `moissonner` relit
 * `dernierMessage` pour son compte, et un effacement en plein passage ferait revenir le canal.
 */
export function avecVerrouMoissonSync(faire: () => void): { pris: boolean } {
  if (passageEnCours) return { pris: false };
  // Un jeton deja resolu : le geste est synchrone, le verrou est rendu avant que la moindre
  // autre tache puisse tourner.
  const jeton = Promise.resolve();
  passageEnCours = jeton;
  try {
    faire();
    return { pris: true };
  } finally {
    if (passageEnCours === jeton) passageEnCours = null;
  }
}

/** Ce que l'ecran montre d'un passage : celui qui tourne, ou le dernier fini. */
export interface EtatMoisson {
  enCours: boolean;
  canal: string | null;
  lus: number;
  nouveaux: number;
  attente: number | null;
  /** Le dernier passage FINI, ou null si aucun depuis le demarrage du processus. */
  dernier: {
    nouveaux: number;
    refuses: string[];
    annule: boolean;
    /** Le CODE d'une erreur, jamais son texte : celui de GramJS est tiers. */
    erreur: string | null;
  } | null;
}

/** Le passage lance par `lancerMoisson`, ou null. Son `arret` est ce que le bouton annule. */
let enVol: { canal: string | null; lus: number; nouveaux: number; attente: number | null; arret: AbortController } | null = null;
let dernier: EtatMoisson['dernier'] = null;

export function etatMoisson(): EtatMoisson {
  if (!enVol) return { enCours: false, canal: null, lus: 0, nouveaux: 0, attente: null, dernier };
  return {
    enCours: true, canal: enVol.canal, lus: enVol.lus, nouveaux: enVol.nouveaux, attente: enVol.attente, dernier,
  };
}

/**
 * ANNULER EST UN GESTE, PLUS UN EFFET DE BORD.
 *
 * Jusqu'au 2026-09-30 c'etait la fermeture de la requete HTTP qui annulait — sense quand la
 * requete portait le travail, et fatal des qu'un proxy s'en melait : cloudflared coupait a
 * 60 s, la premiere passe (atomique par choix) jetait tout ce qu'elle avait lu, et recliquer
 * ne pouvait pas converger.
 */
export function annulerMoisson(): void {
  enVol?.arret.abort();
}

type Passer = (signal?: AbortSignal, options?: OptionsPasse) => Promise<{ nouveaux: number; refuses: string[] }>;

/**
 * LANCE UN PASSAGE EN FOND et rend la main tout de suite. Plus rien ne depend de la duree
 * d'une requete : l'ecran suit l'avancement par `etatMoisson()`, et `annulerMoisson()` arrete.
 *
 * Rend `{ lance: false }` — sans rien lancer — si un passage tourne deja, verrou partage avec
 * le rafraichissement paresseux de la recherche.
 *
 * `passer` n'est la que pour les tests : la production ne passe jamais ce parametre.
 */
export function lancerMoisson(options: OptionsPasse = {}, passer: Passer = moissonnerVraiment): { lance: boolean } {
  const arret = new AbortController();
  const mien = { canal: null as string | null, lus: 0, nouveaux: 0, attente: null as number | null, arret };
  const passage = avecVerrouMoisson(async () => {
    enVol = mien;
    try {
      const r = await passer(arret.signal, {
        ...options,
        avance: (a) => {
          // Un rapport qui arriverait apres la fin, ou d'un passage deja remplace, se tait.
          if (enVol !== mien) return;
          mien.canal = a.canal;
          mien.lus = a.lus;
          mien.nouveaux = a.nouveaux;
          mien.attente = a.attente;
        },
      });
      dernier = { nouveaux: r.nouveaux, refuses: r.refuses, annule: arret.signal.aborted, erreur: null };
    } catch (e) {
      dernier = { nouveaux: 0, refuses: [], annule: arret.signal.aborted, erreur: motifSur(e) };
      throw e;
    } finally {
      if (enVol === mien) enVol = null;
    }
  });
  if (!passage) return { lance: false };
  // PERSONNE N'ATTEND CETTE PROMESSE : sans ce filet, un echec tuerait le processus sur un
  // rejet non gere. L'erreur est deja dans `dernier`, ou l'ecran la lira.
  passage.catch(() => {});
  return { lance: true };
}

/**
 * LE REPOS APRES UN ECHEC : 15 minutes.
 *
 * `noterMoisson` n'est atteint qu'en sortie REUSSIE. Sans seconde date, une instance dont
 * Telegram est injoignable — session revoquee, reseau coupe — retentait a CHAQUE recherche :
 * une construction de client et une connexion (`connectionRetries: 3`, `retryDelay: 1000`)
 * par requete. Le verrou serialise, il ne freine pas.
 *
 * Quinze minutes, parce que le bouton « Indexer maintenant » ne passe PAS par ici : l'hebergeur
 * garde a tout moment un chemin immediat, donc le repos automatique peut etre genereux. Il
 * plafonne les tentatives a quatre par heure — invisible pour Telegram — tout en rendant les
 * resultats dans le quart d'heure a celui qui vient de reconnecter son compte.
 */
export const REPOS_TENTATIVE_MS = 15 * 60 * 1000;

/**
 * MESSAGES LUS AU PLUS PAR PASSE AUTOMATIQUE.
 *
 * `iterMessages` rend 100 messages par requete : 5 000 tiennent en une cinquantaine d'appels,
 * moins d'une minute, et le verrou est rendu. Un canal de plusieurs centaines de milliers de
 * messages se rattrape ainsi par tranches, une toutes les douze heures, sans jamais bloquer ni
 * le retrait d'un canal ni une autre indexation.
 */
export const BUDGET_AUTOMATIQUE = 5000;

/**
 * LE RAFRAICHISSEMENT PARESSEUX de l'index, lance A COTE d'une recherche — l'equivalent de
 * l'`assurer()` des index de sitemap. Sans lui, une instance en mode direct fige son
 * catalogue le jour de son installation et le compteur « N message(s) indexe(s) » reste juste
 * tout en devenant faux.
 *
 * Trois gardes, parce que la moisson n'est pas un index sur disque comme les autres :
 *
 * 1. UN BUDGET DE LECTURE. La passe s'arrete au bout de `BUDGET_AUTOMATIQUE` messages lus, tous
 *    canaux confondus. Un canal de 645 000 messages se rattrape donc par petits bouts au lieu
 *    de garder le verrou des heures — et comme la lecture est montante depuis un curseur, ces
 *    bouts se recollent exactement. Le bouton « Indexer maintenant », lui, n'a aucun budget :
 *    il est annulable et reprenable, donc il peut aller jusqu'au bout.
 * 2. NON BLOQUANT. Cette fonction rend la main tout de suite ; la recherche sert l'index tel
 *    qu'il est et n'attend jamais le reseau.
 * 3. UN SEUL PASSAGE A LA FOIS, le meme verrou que le bouton d'Admin.
 */
export function rafraichirIndexTelegram(): void {
  const index = indexMessages();
  if (Date.now() - index.derniereMoisson() < FRAICHEUR_MS) return;
  // 4. PAS DE TEMPETE : une tentative au plus par periode de repos, qu'elle aboutisse ou non.
  if (Date.now() - index.derniereTentative() < REPOS_TENTATIVE_MS) return;
  if (reglagesTelegram().canaux.length === 0) return;
  // La tentative se date AVANT de partir : une passe qui jette tout de suite compte quand meme.
  index.noterTentative(Date.now());
  avecVerrouMoisson(() => moissonnerVraiment(undefined, { budgetLus: BUDGET_AUTOMATIQUE }))
    // Le texte d'une erreur de GramJS est TIERS : on n'en dit que le code.
    ?.catch((e) => console.warn(`[telegram] index non rafraichi (${motifSur(e)})`));
}
