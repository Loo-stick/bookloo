// Le journal des versions.
//
// Il vient du CHANGELOG.md EMBARQUE dans l'image, pas de GitHub : aucun appel sortant, et
// il reste lisible sans reseau. Il montre donc ce que CETTE version connaissait — ce qui
// est exact, et le lien vers les notes completes est en tete du document.

(() => {
  const cible = document.getElementById('journal');

  const deco = document.getElementById('deconnexion');
  if (deco) {
    deco.addEventListener('click', async (e) => {
      e.preventDefault();
      await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
      location.href = '/login.html';
    });
  }

  fetch('/CHANGELOG.md', { credentials: 'same-origin' })
    .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`erreur ${r.status}`))))
    .then((texte) => {
      // `rendreJournal` echappe le document ENTIER avant d'introduire la moindre balise :
      // c'est ce qui autorise `innerHTML` ici sans ouvrir de porte.
      cible.innerHTML = rendreJournal(texte);
    })
    .catch((e) => {
      const d = document.createElement('div');
      d.className = 'vide';
      d.textContent = `journal indisponible : ${e.message}`;
      cible.replaceChildren(d);
    });
})();
