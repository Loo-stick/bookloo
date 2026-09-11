// Masque les entrees de navigation reservees a l'administration.
//
// Le serveur les refuse deja (`exigerAdmin`), mais proposer un geste qu'on refusera ensuite
// est une promesse qu'on ne tient pas. Le masquage est un CONFORT D'INTERFACE, jamais la
// garantie : celle-ci reste cote serveur, et elle y reste seule.

(() => {
  const reservees = document.querySelectorAll('nav [data-role="admin"]');
  if (!reservees.length) return;
  // Cachees par defaut, montrees si le role le permet : l'inverse les ferait clignoter chez
  // un utilisateur ordinaire, le temps que la reponse arrive.
  for (const e of reservees) e.hidden = true;

  fetch('/api/moi', { credentials: 'same-origin' })
    .then((r) => (r.ok ? r.json() : null))
    .then((moi) => {
      if (moi?.role !== 'admin') return;
      for (const e of reservees) e.hidden = false;
    })
    .catch(() => {
      /* Sans reponse, on laisse cache : une entree qui menerait a un 403 n'aide personne. */
    });
})();
