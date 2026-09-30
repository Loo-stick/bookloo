// De l'index aux candidats. `candidatDuMessage` est PUR : aucun reseau, aucune base.
//
// `search`, lui, sert l'index tel qu'il est ET lance le rafraichissement A COTE — il ne
// l'attend jamais. C'est la seule chose qui peut faire partir du reseau depuis ce module.
import { parseRelease } from '../sources/torrent/release';
import { identiteTelegram } from '../sources/telegram/facade';
import type { Candidate, Query, SearchContext, Source } from '../sources/types';
import { indexMessages, type MessageIndexe } from './index-messages';
import { rafraichirIndexTelegram } from './moisson';

export function candidatDuMessage(m: MessageIndexe): Candidate {
  const a = parseRelease(m.nom);
  return {
    source: 'telegram',
    // L'IDENTIFIANT NUMERIQUE, jamais le nom : `estIdentiteTelegram` n'accepte que des
    // chiffres, et c'est la forme que la bibliotheque existante porte deja.
    identite: identiteTelegram(`${m.canalId}:${m.message}`),
    titre: m.nom,
    taille: m.taille || undefined,
    tomes: a.tomes,
    langue: a.langue,
    format: a.format,
    provenance: a.provenance,
    // UN PACK PORTE UNE PLAGE. La facade posait `estPack` ; ici le nom le dit.
    nbFichiers: a.tomes?.fin ? 2 : 1,
    // Le NOM sert au lien public seulement : l'identite, elle, ne le porte jamais.
    lienExterne: `https://t.me/${m.canal}/${m.message}`,
  };
}

export function sourceTelegramDirecte(): Source {
  return {
    id: 'telegram',
    label: 'Telegram',
    async search(q: Query, _ctx: SearchContext): Promise<Candidate[]> {
      // L'INDEX TEL QU'IL EST, ET LE RAFRAICHISSEMENT A COTE — meme geste que l'`assurer()`
      // des index de sitemap. Sans lui l'instance figerait son catalogue le jour de son
      // installation. Cet appel rend la main tout de suite : la recherche n'attend jamais
      // Telegram.
      rafraichirIndexTelegram();
      const idx = indexMessages();
      const vus = new Set<string>();
      const out: Candidate[] = [];
      for (const forme of q.titres) {
        if (!forme) continue;
        for (const m of idx.chercher(forme.split(/\s+/))) {
          // L'IDENTITE, pas le nom : un canal renomme laisse des lignes sous l'ancien ET le
          // nouveau nom, avec le meme identifiant. Cle sur le nom = la release rendue deux fois.
          const cle = `${m.canalId}:${m.message}`;
          if (vus.has(cle)) continue;
          vus.add(cle);
          out.push(candidatDuMessage(m));
        }
      }
      return out;
    },
  };
}
