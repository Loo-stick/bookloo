// Les sessions Z-Library retenues, PAR UTILISATEUR et EN MEMOIRE SEULEMENT.
//
// Pas en base : ce serait un second secret a proteger, avec sa propre duree de vie, alors
// qu'une reconnexion coute un aller-retour. Retenir evite simplement de se reconnecter a
// chaque telechargement.
//
// POURQUOI CE MODULE EXISTE. La table vivait dans `routes/zlibrary.ts`, et seul ce
// fichier pouvait l'oublier. `routes/compte.ts` enregistrait de nouveaux identifiants
// sans que rien ne previenne : l'ancienne session continuait de servir jusqu'a ce que
// Z-Library la refuse. L'utilisateur corrigeait un mot de passe faux et voyait la meme
// erreur — sans aucun moyen de comprendre que sa correction avait bien ete prise.

const sessions = new Map<number, unknown>();

/** Les cles dont le changement rend une session obsolete. */
export const CLES_DE_SESSION = ['zlib_email', 'zlib_mdp'] as const;

export function retenir(userId: number, session: unknown): void {
  sessions.set(userId, session);
}

export function retenue<T>(userId: number): T | undefined {
  return sessions.get(userId) as T | undefined;
}

/** Oublie la session d'un utilisateur : le serveur l'a refusee, ou ses cles ont change. */
export function oublier(userId: number): void {
  sessions.delete(userId);
}

/**
 * Ces cles-la viennent-elles d'etre modifiees ?
 *
 * Prend la liste des cles REELLEMENT ecrites : un PUT qui ne touche pas Z-Library ne doit
 * pas faire payer une reconnexion, et un PUT qui la touche doit toujours la faire payer —
 * y compris quand la valeur est effacee, cas ou la session en memoire survivrait a des
 * identifiants qui n'existent plus.
 */
export function changementInvalideSession(modifiees: readonly string[]): boolean {
  return modifiees.some((n) => (CLES_DE_SESSION as readonly string[]).includes(n));
}
