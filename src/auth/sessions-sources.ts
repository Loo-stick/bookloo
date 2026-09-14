// Les sessions de sources retenues, PAR SOURCE ET PAR UTILISATEUR, en memoire seulement.
//
// Pas en base : ce serait un second secret a proteger, avec sa propre duree de vie, alors
// qu'une reconnexion coute un aller-retour. Retenir evite simplement de se reconnecter a
// chaque appel.
//
// POURQUOI CE MODULE A DEMENAGE. Il vivait sous `sources/zlibrary/`, et ne connaissait que
// Z-Library. Zone-ebook demande exactement la meme chose — se connecter, retenir, oublier
// quand les identifiants changent — et en ecrire une copie aurait donne deux tables qui
// divergent. C'est la faute que ce projet a deja payee trois fois : la table des sites
// DDL, l'etiquette de tome, le choix de surface de lecture.
//
// AVANT LUI, LA TABLE VIVAIT DANS `routes/zlibrary.ts` et seul ce fichier pouvait
// l'oublier : `routes/compte.ts` enregistrait de nouveaux identifiants sans que rien ne
// previenne, l'ancienne session servait jusqu'a ce que le site la refuse, et corriger un
// mot de passe faux affichait la meme erreur qu'avant.

/** Les sources qui gardent une session ouverte. */
export type SourceAvecSession = 'zlibrary' | 'zone-ebook';

/**
 * Les cles dont le changement rend une session obsolete, PAR SOURCE.
 *
 * Une seule table : ajouter une source sans y declarer ses cles laisserait sa session
 * survivre a des identifiants qui n'existent plus.
 */
export const CLES_DE_SESSION: Record<SourceAvecSession, readonly string[]> = {
  zlibrary: ['zlib_email', 'zlib_mdp'],
  'zone-ebook': ['zone_login', 'zone_mdp'],
};

const sessions = new Map<string, unknown>();

const cle = (source: SourceAvecSession, userId: number) => `${source}:${userId}`;

export function retenir(source: SourceAvecSession, userId: number, session: unknown): void {
  sessions.set(cle(source, userId), session);
}

export function retenue<T>(source: SourceAvecSession, userId: number): T | undefined {
  return sessions.get(cle(source, userId)) as T | undefined;
}

/** Oublie une session : le serveur l'a refusee, ou les cles ont change. */
export function oublier(source: SourceAvecSession, userId: number): void {
  sessions.delete(cle(source, userId));
}

/**
 * Oublie TOUTES les sessions d'un utilisateur — a sa suppression.
 *
 * Parcourir les sources plutot que la table : on veut retirer ce qui existe pour cet
 * utilisateur, y compris la source ajoutee demain et que ce fichier ne connait pas encore.
 */
export function oublierTout(userId: number): void {
  for (const source of Object.keys(CLES_DE_SESSION) as SourceAvecSession[]) {
    oublier(source, userId);
  }
}

/**
 * Quelles sources ces cles-la viennent-elles d'invalider ?
 *
 * Prend la liste des cles REELLEMENT ecrites : un PUT qui ne touche pas une source ne doit
 * pas lui faire payer une reconnexion, et un PUT qui la touche doit toujours la lui faire
 * payer — y compris quand la valeur est effacee.
 */
export function sourcesInvalidees(modifiees: readonly string[]): SourceAvecSession[] {
  return (Object.keys(CLES_DE_SESSION) as SourceAvecSession[])
    .filter((s) => modifiees.some((n) => CLES_DE_SESSION[s].includes(n)));
}
