// Page de compte : cles personnelles et mot de passe.
//
// UNE VALEUR DE CLE NE SORT JAMAIS D'ICI. La lecture ne rend que des noms et un
// booleen. Renvoyer une passkey au navigateur pour « pre-remplir le champ » est le
// genre de commodite qui la fait finir dans un cache, un historique ou une capture.

import { Router } from 'express';
import type { Database } from 'better-sqlite3';
import {
  chiffrer, deriverKek, developper, envelopper, hacherMotDePasse,
  motDePasseAcceptable, nouveauSel, verifierMotDePasse,
} from '../auth/crypto';
import { clesEnClair, identifiantsZlibrary } from '../auth/cles-utilisateur';
import { exigerConnexion, exigerCsrf, limiteurRecherche } from '../auth/garde';
import { fermerSessionsDe } from '../auth/sessions';
import { lireCles, poserCle, retirerCle } from '../db/cles';
import { NOMS_CLES } from '../db/schema';
import { changerSecretsUtilisateur, parId } from '../db/utilisateurs';
import { tester } from './keytest';
import { parseConfigRustatio } from '../rustatio/config';

export interface ResumeCle {
  nom: string;
  renseignee: boolean;
}

/** Fonction pure : c'est elle qui garantit qu'aucun secret ne part vers le navigateur. */
export function resumeDesCles(cles: { nom: string; valeur: string }[]): ResumeCle[] {
  const presentes = new Set(cles.filter((c) => c.valeur.length > 0).map((c) => c.nom));
  return NOMS_CLES.map((nom) => ({ nom, renseignee: presentes.has(nom) }));
}

export function routesCompte(db: Database): Router {
  const r = Router();

  r.get('/api/compte/cles', exigerConnexion, (req, res) => {
    const enClair = clesEnClair(db, req.session!.userId, req.session!.dek);
    const liste = lireCles(db, req.session!.userId).map((c) => ({
      nom: c.nom,
      // Une entree presente mais illisible (DEK changee hors de Mangaloo) doit
      // apparaitre « non renseignee » : l'utilisateur pourra la ressaisir.
      valeur: enClair[c.nom] ?? '',
    }));
    res.json({ cles: resumeDesCles(liste) });
  });

  // L'URL Rustatio est une ADRESSE, pas un secret : on la renvoie pour pre-remplir le
  // champ. Le TOKEN, lui, ne sort JAMAIS (meme regle que les passkeys) — d'ou cette route
  // dediee, a l'ecart de /api/compte/cles qui ne rend jamais aucune valeur.
  r.get('/api/compte/rustatio', exigerConnexion, (req, res) => {
    const enClair = clesEnClair(db, req.session!.userId, req.session!.dek);
    const cfg = parseConfigRustatio(enClair.rustatio);
    res.json({ url: cfg?.url ?? null });
  });

  // L'ADRESSE EST RENVOYEE, LE MOT DE PASSE JAMAIS. Meme partage que pour Rustatio, ou
  // l'URL revient et le token non : sans l'adresse, l'utilisateur ne peut pas voir quel
  // compte est enregistre, et une faute de frappe reste invisible pour toujours.
  r.get('/api/compte/zlibrary', exigerConnexion, (req, res) => {
    const enClair = clesEnClair(db, req.session!.userId, req.session!.dek);
    res.json({
      email: (enClair.zlib_email ?? '').trim() || null,
      complet: identifiantsZlibrary(enClair) !== null,
    });
  });

  r.put('/api/compte/cles', exigerConnexion, exigerCsrf, (req, res) => {
    const corps = (req.body ?? {}) as Record<string, unknown>;
    const modifiees: string[] = [];
    for (const nom of NOMS_CLES) {
      if (!(nom in corps)) continue;
      let valeur = String(corps[nom] ?? '').trim();
      // Rustatio : l'UI pre-remplit l'URL mais JAMAIS le token. Enregistrer avec le champ
      // token vide ne doit pas effacer un token deja en place -> on preserve l'ancien.
      if (nom === 'rustatio' && valeur) {
        const entrant = parseConfigRustatio(valeur);
        if (entrant && !entrant.token) {
          const ancien = parseConfigRustatio(
            clesEnClair(db, req.session!.userId, req.session!.dek).rustatio,
          );
          if (ancien?.token) valeur = JSON.stringify({ url: entrant.url, token: ancien.token });
        }
      }
      if (!valeur) {
        // Chaine vide = retrait explicite. Plus lisible qu'un endpoint DELETE de plus.
        retirerCle(db, req.session!.userId, nom);
      } else {
        const { chiffre, nonce } = chiffrer(valeur, req.session!.dek);
        poserCle(db, req.session!.userId, nom, chiffre, nonce);
      }
      modifiees.push(nom);
    }
    res.json({ ok: true, modifiees });
  });

  /**
   * Teste les cles ENREGISTREES.
   *
   * Aucun corps de requete : le serveur dechiffre avec la DEK de la session. C'est
   * l'ecart voulu avec Dramallyu, qui passe la cle en parametre d'URL faute de la
   * stocker — ici aucune cle ne transite par le navigateur, ni dans une query string,
   * ni dans un journal d'acces.
   *
   * Les six tests partent EN PARALLELE : en serie, six services lents feraient
   * patienter une minute pour une information que l'utilisateur veut d'un coup d'oeil.
   */
  r.post('/api/compte/cles/tester', exigerConnexion, exigerCsrf, limiteurRecherche, async (req, res) => {
    const enClair = clesEnClair(db, req.session!.userId, req.session!.dek);
    const resultats = await Promise.all(
      NOMS_CLES
        // `zlib_email` n'est pas une cle testable a elle seule : le couple est teste une
        // fois, sous `zlib_mdp`, la ou l'utilisateur voit le champ mot de passe.
        .filter((nom) => nom !== 'zlib_email')
        .map(async (nom) => ({
          nom,
          ...(await tester(nom, enClair[nom] ?? '',
            nom === 'zlib_mdp' ? enClair.zlib_email ?? '' : undefined)),
        })),
    );
    res.json({ resultats });
  });

  r.post('/api/compte/motdepasse', exigerConnexion, exigerCsrf, async (req, res) => {
    const ancien = String(req.body?.ancien ?? '');
    const nouveau = String(req.body?.nouveau ?? '');

    const u = parId(db, req.session!.userId);
    if (!u) { res.status(404).json({ erreur: 'compte introuvable' }); return; }
    if (!(await verifierMotDePasse(ancien, u.hash))) {
      res.status(401).json({ erreur: 'ancien mot de passe incorrect' });
      return;
    }
    const politique = motDePasseAcceptable(nouveau);
    if (!politique.ok) { res.status(400).json({ erreur: politique.raison }); return; }

    // On developpe la DEK avec l'ANCIENNE KEK, puis on la re-enveloppe avec la
    // nouvelle. Les six secrets ne sont PAS retouches : c'est tout l'interet de
    // l'indirection, et cela supprime le risque d'un rechiffrement a moitie fait.
    const ancienneKek = await deriverKek(ancien, u.sel_kek);
    const dek = developper(u.dek_chiffre, u.dek_nonce, ancienneKek);
    if (!dek) { res.status(500).json({ erreur: 'les secrets de ce compte sont illisibles' }); return; }

    const nouveauSelKek = nouveauSel();
    const nouvelleKek = await deriverKek(nouveau, nouveauSelKek);
    const enveloppe = envelopper(dek, nouvelleKek);
    const hash = await hacherMotDePasse(nouveau);

    changerSecretsUtilisateur(db, u.id, hash, nouveauSelKek, enveloppe.chiffre, enveloppe.nonce);
    // Toutes les sessions tombent, y compris celle-ci : un changement de mot de passe
    // sert souvent a couper un acces, et laisser les autres ouvertes le viderait de son
    // sens.
    fermerSessionsDe(db, u.id);
    res.json({ ok: true, reconnexionRequise: true });
  });

  return r;
}
