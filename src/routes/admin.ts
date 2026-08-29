// Administration : comptes, invitations, sources.
//
// PAS D'INSCRIPTION OUVERTE. Sur une application exposee sur Internet, un formulaire
// d'inscription public est une invitation. Les comptes se creent ici, ou par un lien
// d'invitation a usage unique.

import { Router } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import type { Database } from 'better-sqlite3';
import {
  deriverKek, envelopper, hacherMotDePasse, motDePasseAcceptable, nouveauSel, nouvelleDek,
} from '../auth/crypto';
import { exigerAdmin, exigerConnexion, exigerCsrf } from '../auth/garde';
import { fermerSessionsDe } from '../auth/sessions';
import { creerUtilisateur, listerUtilisateurs, parLogin } from '../db/utilisateurs';
import { getSettings, rechargerSettings } from '../core/settings';

const DUREE_INVITATION_MS = 7 * 24 * 60 * 60 * 1000;

function empreinte(jeton: string): Buffer {
  return createHash('sha256').update(jeton).digest();
}

/** Cree un compte complet : hash, sel de KEK, DEK enveloppee. */
export async function creerCompte(
  db: Database,
  login: string,
  motDePasse: string,
  role: 'admin' | 'utilisateur',
): Promise<number> {
  const selKek = nouveauSel();
  const kek = await deriverKek(motDePasse, selKek);
  const enveloppe = envelopper(nouvelleDek(), kek);
  return creerUtilisateur(db, {
    login,
    hash: await hacherMotDePasse(motDePasse),
    selKek,
    dekChiffre: enveloppe.chiffre,
    dekNonce: enveloppe.nonce,
    role,
  });
}

export function routesAdmin(db: Database): Router {
  const r = Router();
  r.use('/api/admin', exigerConnexion, exigerAdmin);

  r.get('/api/admin/utilisateurs', (_req, res) => {
    // Ni hash, ni sel, ni DEK : l'administration n'a aucun besoin de les voir.
    res.json({
      utilisateurs: listerUtilisateurs(db).map((u) => ({
        id: u.id, login: u.login, role: u.role, creeLe: u.cree_le,
        echecs: u.echecs, verrouilleJusqua: u.verrouille_jusqua,
      })),
    });
  });

  r.post('/api/admin/utilisateurs', exigerCsrf, async (req, res) => {
    const login = String(req.body?.login ?? '').trim();
    const motDePasse = String(req.body?.motDePasse ?? '');
    const role = req.body?.role === 'admin' ? 'admin' : 'utilisateur';

    if (!/^[a-zA-Z0-9._-]{3,32}$/.test(login)) {
      res.status(400).json({ erreur: 'identifiant invalide (3 a 32 caracteres simples)' });
      return;
    }
    if (parLogin(db, login)) { res.status(409).json({ erreur: 'identifiant deja pris' }); return; }
    const politique = motDePasseAcceptable(motDePasse);
    if (!politique.ok) { res.status(400).json({ erreur: politique.raison }); return; }

    const id = await creerCompte(db, login, motDePasse, role);
    res.json({ ok: true, id, login, role });
  });

  r.delete('/api/admin/utilisateurs/:id', exigerCsrf, (req, res) => {
    const id = Number(req.params.id);
    if (id === req.session!.userId) {
      res.status(400).json({ erreur: 'on ne supprime pas le compte avec lequel on est connecte' });
      return;
    }
    // LE DERNIER ADMINISTRATEUR NE PART PAS. Seule l'auto-suppression etait bloquee : rien
    // n'empechait de supprimer tous les AUTRES comptes admin l'un apres l'autre. Il n'y a
    // pas d'inscription publique pour en recreer un — l'instance serait alors definitivement
    // sans administration. Signale par une revue de code le 2026-08-29.
    const cible = db.prepare('SELECT role FROM utilisateurs WHERE id = ?').get(id) as
      { role?: string } | undefined;
    if (cible?.role === 'admin') {
      const { n } = db.prepare("SELECT COUNT(*) n FROM utilisateurs WHERE role = 'admin'")
        .get() as { n: number };
      if (n <= 1) {
        res.status(400).json({ erreur: 'on ne supprime pas le dernier administrateur' });
        return;
      }
    }

    fermerSessionsDe(db, id);
    // Le CASCADE emporte les cles chiffrees avec le compte.
    const res2 = db.prepare('DELETE FROM utilisateurs WHERE id = ?').run(id);
    res.json({ ok: res2.changes > 0 });
  });

  r.post('/api/admin/invitations', exigerCsrf, (req, res) => {
    const jeton = randomBytes(24).toString('hex');
    db.prepare(
      'INSERT INTO invitations (token_hash, cree_par, expire_le) VALUES (?, ?, ?)',
    ).run(empreinte(jeton), req.session!.userId, Date.now() + DUREE_INVITATION_MS);
    // Le jeton en clair n'est montre qu'ICI, une seule fois : seule son empreinte est
    // stockee.
    res.json({ jeton, expireLe: Date.now() + DUREE_INVITATION_MS });
  });

  r.get('/api/admin/sources', (_req, res) => {
    const s = getSettings();
    res.json({
      sources: s.sources,
      torznab: s.torznab,
      unit3d: s.unit3d,
      fanoutBudgetMs: s.fanoutBudgetMs,
    });
  });

  r.post('/api/admin/sources/recharger', exigerCsrf, (_req, res) => {
    // La configuration est un fichier bind-monte : on la relit sans redemarrer.
    rechargerSettings();
    res.json({ ok: true, sources: getSettings().sources });
  });

  return r;
}
