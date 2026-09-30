// L'administration du mode direct : identifiants, canaux, interrupteur, connexion, moisson.
//
// LA SESSION NE SORT JAMAIS. Elle ouvre le compte entier, pas une API limitee : l'etat dit
// « ouverte » ou « absente », rien de plus. L'apiHash non plus — on rend sa PRESENCE.
// RIEN NE PART DANS LES JOURNAUX : ni numero, ni code, ni mot de passe, ni session.
import { Router } from 'express';
import { exigerAdmin, exigerConnexion, exigerCsrf } from '../auth/garde';
import { ecrireReglage } from '../core/settings';
import {
  canauxDeLaSaisie, modeDirectPret, reglagesTelegram, type ReglagesTelegram,
} from '../telegram/reglages';
import {
  abandonnerConnexion, demarrerConnexion, donnerCode, donnerMotDePasse, etatConnexion, type EtatConnexion,
} from '../telegram/auth';
import { indexMessages } from '../telegram/index-messages';
import {
  annulerMoisson, avecVerrouMoissonSync, etatMoisson, lancerMoisson, type EtatMoisson,
} from '../telegram/moisson';

export interface DepsTelegramAdmin {
  etat: () => EtatConnexion;
  abandonner: () => void;
  demarrer: () => Promise<EtatConnexion>;
  code: (code: string) => Promise<EtatConnexion>;
  motDePasse: (mdp: string) => Promise<EtatConnexion>;
  /** Lance un passage EN FOND ; `{ lance: false }` si un autre tourne deja. */
  lancerMoisson: () => { lance: boolean };
  annulerMoisson: () => void;
  etatMoisson: () => EtatMoisson;
}

const depsReelles: DepsTelegramAdmin = {
  etat: etatConnexion,
  abandonner: abandonnerConnexion,
  demarrer: () => demarrerConnexion(),
  // UN SEUL ARGUMENT : `delaiMs` est reserve aux tests, aucune requete ne le fixe.
  code: (c) => donnerCode(c),
  motDePasse: (m) => donnerMotDePasse(m),
  lancerMoisson: () => lancerMoisson(),
  annulerMoisson,
  etatMoisson,
};

/**
 * LA REGLE « PRET », UNE SEULE FOIS. Ce qui manque pour moissonner (un compte, un canal), ou
 * null. L'ecran affiche cette phrase telle quelle : il ne la recalcule pas.
 */
function raisonPasPret(g: ReglagesTelegram): string | null {
  if (!g.apiId || !g.apiHash) return 'Renseignez api_id et api_hash, puis connectez le compte.';
  if (!modeDirectPret(g)) return 'Connectez le compte Telegram.';
  if (g.canaux.length === 0) return 'Declarez au moins un canal.';
  return null;
}

/** Pourquoi l'interrupteur ne peut pas etre allume, ou null s'il le peut. */
function raisonDeRefus(g: ReglagesTelegram): string | null {
  const manque = raisonPasPret(g);
  if (manque) return manque;
  if (indexMessages().taille() === 0) {
    return "L'index est vide : lancez « Indexer maintenant » avant d'activer le mode direct.";
  }
  return null;
}

export function routesTelegramAdmin(deps: DepsTelegramAdmin = depsReelles): Router {
  const r = Router();

  r.get('/api/admin/telegram', exigerConnexion, exigerAdmin, (_req, res) => {
    const g = reglagesTelegram();
    res.json({
      connexion: deps.etat(),
      apiId: g.apiId || null,
      // NI LA SESSION NI L'EMPREINTE : on dit seulement si elles sont posees.
      apiHash: Boolean(g.apiHash),
      telephone: Boolean(g.telephone),
      canaux: g.canaux,
      messagesIndexes: indexMessages().taille(),
      direct: g.direct,
      pret: raisonPasPret(g) === null,
      // Ce qui empeche d'allumer l'interrupteur (null : rien). L'ecran l'affiche, sans le deduire.
      raison: raisonDeRefus(g),
      // L'AVANCEMENT DU PASSAGE, par la route que l'ecran interroge deja. Une route de plus
      // pour cela n'aurait rien apporte.
      moisson: deps.etatMoisson(),
    });
  });

  r.put('/api/admin/telegram', exigerConnexion, exigerAdmin, exigerCsrf, (req, res) => {
    const corps = (req.body ?? {}) as Record<string, unknown>;
    const actuel = reglagesTelegram();

    // TOUT SE VALIDE AVANT D'ECRIRE : un refus ne laisse pas un enregistrement a moitie fait.
    let apiId: number | undefined;
    if (corps.apiId !== undefined && corps.apiId !== '') {
      if (typeof corps.apiId !== 'number' && typeof corps.apiId !== 'string') {
        res.status(400).json({ erreur: 'api_id : un nombre entier est attendu' });
        return;
      }
      apiId = Number(corps.apiId);
      if (!Number.isInteger(apiId) || apiId < 0) {
        res.status(400).json({ erreur: 'api_id : un nombre entier est attendu' });
        return;
      }
    }
    const apiHash = typeof corps.apiHash === 'string' ? corps.apiHash.trim() : '';
    const telephone = typeof corps.telephone === 'string' ? corps.telephone.trim() : '';
    const canaux = corps.canaux !== undefined ? canauxDeLaSaisie(corps.canaux) : undefined;
    // UNE LISTE VIDE EST REFUSEE quand il y avait des canaux. Elle effacerait tout l'index
    // (chaque canal partant passe par `oublierCanal`), donc imposerait une premiere passe
    // complete a la main pour une soumission vide accidentelle. Et ce n'est de toute facon
    // pas un etat que l'ecran propose : `raisonPasPret` reclame au moins un canal. Pour
    // arreter Telegram, c'est l'interrupteur qu'on eteint, pas la liste qu'on vide.
    if (canaux && canaux.length === 0 && actuel.canaux.length > 0) {
      res.status(400).json({
        erreur: 'Declarez au moins un canal : une liste vide effacerait tout l index. Pour arreter, eteignez le mode direct.',
      });
      return;
    }
    if (corps.direct !== undefined && typeof corps.direct !== 'boolean') {
      res.status(400).json({ erreur: 'direct : vrai ou faux attendu' });
      return;
    }
    // UNE AUTRE APPLICATION, UNE AUTRE AUTORISATION : la session obtenue avec l'ancien couple
    // ne vaut plus rien, et l'ecran continuerait d'annoncer « ouverte ».
    const identifiantsChanges = (apiId !== undefined && apiId !== actuel.apiId)
      || (apiHash !== '' && apiHash !== actuel.apiHash);
    if (corps.direct === true) {
      // L'ETAT QUE LE PUT VA PRODUIRE, pas celui d'avant : « canaux » peut arriver avec « direct ».
      const projete: ReglagesTelegram = {
        ...actuel,
        apiId: apiId ?? actuel.apiId,
        apiHash: apiHash || actuel.apiHash,
        canaux: canaux ?? actuel.canaux,
        session: identifiantsChanges ? '' : actuel.session,
      };
      const refus = raisonDeRefus(projete);
      if (refus) {
        res.status(400).json({ erreur: refus });
        return;
      }
    }

    // PREMIERE ECRITURE, ET SOUS LE VERROU DE MOISSON. `oublierCanal` efface les messages ET
    // le curseur ; une passe en cours qui tiendrait encore ce canal le reecrirait aussitot,
    // curseur compris, et le retrait n'aurait servi a rien. Si le verrou est pris, rien n'est
    // ecrit du tout.
    const partis = canaux ? actuel.canaux.filter((c) => !canaux.includes(c)) : [];
    if (partis.length > 0) {
      const oubli = avecVerrouMoissonSync(() => {
        const idx = indexMessages();
        // UN CANAL RETIRE DE LA LISTE QUITTE AUSSI L'INDEX. Sinon ses messages restent
        // cherchables et telechargeables indefiniment, alors que l'ecran ne le montre plus :
        // l'hebergeur qui retire un canal croit l'avoir retire. Les canaux gardes ne sont pas
        // touches — on ne refait pas une premiere passe pour rien.
        for (const parti of partis) idx.oublierCanal(parti);
      });
      if (!oubli.pris) {
        res.status(409).json({ erreur: 'Une indexation est en cours : retirez ce canal quand elle sera finie.' });
        return;
      }
    }

    if (identifiantsChanges) {
      ecrireReglage(['telegram', 'session'], '');
      // ET ON ETEINT LE MODE DIRECT. Sans session, `modeDirectActif` est faux de toute facon :
      // l'instance retomberait en silence sur la facade — ou, sans facade reglee, Telegram
      // disparaitrait — pendant que l'ecran continue de montrer la case cochee et active.
      ecrireReglage(['telegram', 'direct'], false);
      // Une connexion en vol parle encore avec les anciens identifiants.
      deps.abandonner();
    }
    if (apiId !== undefined) ecrireReglage(['telegram', 'apiId'], apiId);
    if (apiHash) ecrireReglage(['telegram', 'apiHash'], apiHash);
    if (telephone) ecrireReglage(['telegram', 'telephone'], telephone);
    if (canaux) ecrireReglage(['telegram', 'canaux'], canaux);
    if (typeof corps.direct === 'boolean') ecrireReglage(['telegram', 'direct'], corps.direct);
    res.json({ ok: true });
  });

  r.post('/api/admin/telegram/connexion', exigerConnexion, exigerAdmin, exigerCsrf, async (_req, res) => {
    res.json(await deps.demarrer());
  });

  r.post('/api/admin/telegram/code', exigerConnexion, exigerAdmin, exigerCsrf, async (req, res) => {
    res.json(await deps.code(String((req.body as { code?: unknown })?.code ?? '')));
  });

  r.post('/api/admin/telegram/motdepasse', exigerConnexion, exigerAdmin, exigerCsrf, async (req, res) => {
    res.json(await deps.motDePasse(String((req.body as { mdp?: unknown })?.mdp ?? '')));
  });

  // LE BOUTON LANCE, IL N'ATTEND PAS.
  //
  // Avant le 2026-09-30 cette route portait le passage entier et l'annulait a la fermeture de
  // la requete. Mesure sur l'instance : cloudflared coupe a 60 s, et la premiere passe est
  // atomique par choix — elle jette tout ce qu'elle a lu si elle n'aboutit pas. Une operation
  // atomique plus longue que la requete qui la porte ne peut JAMAIS aboutir, et recliquer ne
  // convergeait pas. Le passage vit donc dans le module ; l'ecran suit `moisson` dans le GET.
  r.post('/api/admin/telegram/moisson', exigerConnexion, exigerAdmin, exigerCsrf, (_req, res) => {
    const manque = raisonPasPret(reglagesTelegram());
    if (manque) {
      res.status(409).json({ erreur: manque });
      return;
    }
    // UN PASSAGE A LA FOIS : deux moissons gardent chacune leurs messages en memoire, et le
    // verrou est celui du module — partage avec le rafraichissement paresseux de la recherche.
    if (!deps.lancerMoisson().lance) {
      res.status(409).json({ erreur: 'Une indexation est deja en cours.' });
      return;
    }
    res.status(202).json({ demarre: true });
  });

  // L'ANNULATION EST UN GESTE EXPLICITE, plus un effet de bord de la fermeture d'un onglet.
  r.post('/api/admin/telegram/moisson/annuler', exigerConnexion, exigerAdmin, exigerCsrf, (_req, res) => {
    deps.annulerMoisson();
    res.json({ ok: true });
  });

  return r;
}
