// La vitrine : cinq portes, et ce que chacune sait faire.
//
// Chaque boite annonce ce qu'elle offre REELLEMENT — par catalogue ou par recherche
// libre, et sur combien de sources. Promettre une fiche la ou il n'y en a pas serait
// decevoir au premier clic.

(function () {
  const elem = (t, c, x) => {
    const e = document.createElement(t);
    if (c) e.className = c;
    if (x !== undefined) e.textContent = x;
    return e;
  };

  function boite(f) {
    const a = elem('a', 'famille');
    // Le motif est choisi par la feuille de style, d'apres cet attribut : le script ne
    // decide pas de l'apparence, il dit seulement de quelle famille il s'agit.
    a.dataset.famille = f.id;
    a.href = `/index.html?famille=${encodeURIComponent(f.id)}`;
    a.append(elem('span', 'famille-nom', f.libelle));
    a.append(elem('span', 'famille-detail', f.catalogues.length > 0
      ? `${f.sources} source(s) · fiches`
      : `${f.sources} source(s) · recherche libre`));
    if (!f.lisibleEnLigne) {
      // Meme regle que le CBR : on dit ce qu'on ne sait pas faire, plutot que de le
      // laisser decouvrir au bout du parcours.
      a.append(elem('span', 'puce', 'pas de lecture en ligne'));
    }
    return a;
  }

  (async () => {
    const cible = document.getElementById('familles');
    try {
      const r = await fetch('/api/familles');
      if (r.status === 401) { location.href = '/login.html'; return; }
      const brut = await r.text();
      if (!r.ok) throw new Error(brut.slice(0, 200));
      const { familles } = JSON.parse(brut);
      if (!familles.length) {
        // Un ecran vide est une invitation a agir, pas un constat.
        cible.replaceChildren(elem('div', 'vide',
          'Aucune source configuree. Renseignez vos cles dans Mon compte.'));
        return;
      }
      cible.replaceChildren(...familles.map(boite));
    } catch (e) {
      cible.replaceChildren(elem('div', 'vide', `vitrine indisponible : ${e.message}`));
    }
  })();

  const deco = document.getElementById('deconnexion');
  if (deco) {
    deco.addEventListener('click', async (e) => {
      e.preventDefault();
      const m = document.cookie.match(/(?:^|;\s*)mangaloo-csrf=([^;]+)/);
      await fetch('/api/logout', {
        method: 'POST',
        headers: { 'X-CSRF': m ? decodeURIComponent(m[1]) : '' },
      }).catch(() => {});
      location.href = '/login.html';
    });
  }
})();
