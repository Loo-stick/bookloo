// Interrogation parallele des sources, sous budget dur.
//
// TROIS ETATS DISTINCTS, ET C'EST LE POINT DE CE FICHIER.
//
// « Vide » et « en echec » ne veulent pas dire la meme chose, et les confondre coute
// cher des deux cotes : cote cache, memoriser un echec comme « 0 resultat » rend un
// tracker mort pour tout le monde pendant la duree du TTL ; cote interface,
// l'utilisateur ne peut plus distinguer « cette oeuvre n'existe pas ici » de « C411
// etait couche ». On ajoute donc « cle absente », qui n'est ni l'un ni l'autre : la
// source n'a jamais ete interrogee.
//
// Le budget est DUR. Une source lente ne doit jamais retenir les autres : au-dela du
// budget, elle est abandonnee et signalee comme telle.

import { tracer } from './journal';
import type { Query, ResultatSource, SearchContext, Source } from '../sources/types';

/**
 * Interroge UNE source et rend son etat.
 *
 * Extraite pour que le fan-out groupe et le flux au fil de l'eau partagent exactement
 * les memes regles d'etat. Les recopier ailleurs, c'est se garantir qu'elles divergeront.
 */
export async function interrogerSource(
  source: Source,
  q: Query,
  ctx: SearchContext,
  signal: AbortSignal,
): Promise<ResultatSource> {
  // Sans cle, la source n'est pas appelee du tout : une requete sans passkey rend un
  // refus, et un refus mis en cache empoisonnerait le tracker pour tout le monde.
  // Une source PUBLIQUE (Nyaa, Knaben) n'a pas de cle requise et passe toujours.
  if (source.cleRequise && !ctx.cles[source.cleRequise]) {
    return { source: source.id, label: source.label, etat: 'cle-absente', candidats: [] };
  }
  try {
    // `famille` DOIT etre transmise. Elle ne l'etait pas : le contexte etait reconstruit
    // avec `cles` et `signal` seulement, et tout le systeme de categories par famille —
    // celui qui distingue un livre d'un manga chez le meme tracker — n'a jamais pris
    // effet. Mesure du 2026-08-25 sur Tr4ker, requete « Holly » :
    //     avec famille : 6 resultats, 5 epub et 1 pdf
    //     sans famille : 76 resultats, dont 12 enregistrements audio et 8 bandes dessinees
    // C'est de la que venaient les livres audio et les CBZ dans une recherche de livres.
    const candidats = await source.search(q, { cles: ctx.cles, famille: ctx.famille, signal });
    // Une source abandonnee au budget rend souvent une liste VIDE plutot que de
    // jeter : axios, coupe par le signal, remonte null et le connecteur renvoie [].
    // Sans ce test, l'interface annoncerait « vide » — c'est-a-dire « cette oeuvre
    // n'existe pas sur ce tracker » — pour une source qu'on n'a pas laissee finir.
    if (candidats.length === 0 && signal.aborted) {
      return { source: source.id, label: source.label, etat: 'echec', candidats: [] };
    }
    return {
      source: source.id,
      label: source.label,
      etat: candidats.length > 0 ? 'repondu' : 'vide',
      candidats,
    };
  } catch (e) {
    tracer('Fanout', `${source.label}: ${(e as Error).message}`);
    return { source: source.id, label: source.label, etat: 'echec', candidats: [] };
  }
}

export async function fanout(
  sources: Source[],
  q: Query,
  ctx: SearchContext,
  budgetMs: number,
): Promise<ResultatSource[]> {
  const controleur = new AbortController();
  // Le signal de l'appelant (client parti, requete annulee) se propage au notre.
  ctx.signal?.addEventListener('abort', () => controleur.abort(), { once: true });
  const minuteur = setTimeout(() => controleur.abort(), budgetMs);

  const contexteInterne: SearchContext = { cles: ctx.cles, signal: controleur.signal };

  const travaux = sources.map((source) => interrogerSource(source, q, contexteInterne, controleur.signal));

  try {
    return await Promise.all(travaux);
  } finally {
    clearTimeout(minuteur);
  }
}
