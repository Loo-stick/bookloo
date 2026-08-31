// Le journal des traces.
//
// Il ne redemande que la SUITE : la route rend un `seq`, on le lui repasse. Redemander tout
// a chaque rafraichissement afficherait des doublons et grossirait sans fin.

(() => {
  const zone = document.getElementById('journal');
  const filtres = document.getElementById('filtres');
  const lignes = [];
  let dernierSeq = 0;
  const masques = { niveau: new Set(), source: new Set() };

  const el = (balise, classe, texte) => {
    const e = document.createElement(balise);
    if (classe) e.className = classe;
    // TEXTE, JAMAIS HTML : une trace porte le motif renvoye par un service tiers, et une
    // page authentifiee n'a pas a laisser entrer du balisage etranger.
    if (texte !== undefined) e.textContent = texte;
    return e;
  };

  const retenue = (l) =>
    (masques.niveau.size === 0 || masques.niveau.has(l.niveau))
    && (masques.source.size === 0 || masques.source.has(l.source));

  function peindre() {
    const vues = lignes.filter(retenue);
    zone.replaceChildren();
    if (!vues.length) {
      zone.append(el('div', 'vide', 'aucune trace — lancez une recherche, puis rafraichissez.'));
      return;
    }
    // LA PLUS RECENTE EN HAUT : on ouvre cette page pour voir ce qui vient de se passer.
    for (const l of vues.slice(-500).reverse()) {
      const d = el('div', `trace trace--${l.niveau}`);
      d.append(el('span', 'trace-heure', new Date(l.ts).toLocaleTimeString('fr-FR')));
      d.append(el('span', 'trace-source', l.source));
      d.append(el('span', 'trace-message', l.message));
      zone.append(d);
    }
  }

  function majFiltres() {
    filtres.replaceChildren();
    for (const [axe, valeurs] of [
      ['niveau', ['error', 'warn', 'info']],
      ['source', [...new Set(lignes.map((l) => l.source))].sort()],
    ]) {
      for (const v of valeurs) {
        const actif = masques[axe].has(v);
        const b = el('button', actif ? 'discret filtre-actif' : 'discret', v);
        b.type = 'button';
        b.setAttribute('aria-pressed', String(actif));
        b.addEventListener('click', () => {
          if (masques[axe].has(v)) masques[axe].delete(v);
          else masques[axe].add(v);
          majFiltres();
          peindre();
        });
        filtres.append(b);
      }
    }
    const r = el('button', 'principal', 'Rafraichir');
    r.type = 'button';
    r.addEventListener('click', charger);
    filtres.append(r);

    // DIRE CE QU'ON MONTRE. « je vois pas ce que je filtre » : la surbrillance dit quels
    // boutons sont coches, ce compteur dit ce que ca donne.
    const vues = lignes.filter(retenue).length;
    filtres.append(el('span', 'tranche-legende',
      vues === lignes.length
        ? `${lignes.length} ligne(s)`
        : `${vues} ligne(s) sur ${lignes.length}`));
  }

  async function charger() {
    try {
      const r = await fetch(`/api/logs?depuis=${dernierSeq}`, { credentials: 'same-origin' });
      if (r.status === 403) {
        zone.replaceChildren(el('div', 'vide', 'journal reserve a l administration.'));
        return;
      }
      if (!r.ok) throw new Error(`erreur ${r.status}`);
      const corps = await r.json();
      lignes.push(...(corps.lignes || []));
      dernierSeq = corps.seq;
      majFiltres();
      peindre();
    } catch (e) {
      zone.replaceChildren(el('div', 'vide', `journal indisponible : ${e.message}`));
    }
  }

  const deco = document.getElementById('deconnexion');
  if (deco) {
    deco.addEventListener('click', async (e) => {
      e.preventDefault();
      await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' }).catch(() => {});
      location.href = '/login.html';
    });
  }

  charger();
})();
