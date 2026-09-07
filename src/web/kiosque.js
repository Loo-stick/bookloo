// Le kiosque : ce qui bouge dans un rayon.
//
// LE FLUX SE PEINT AU FIL DE L'EAU, section par section. Une source lente ne retient pas
// les autres — meme raison que sur la recherche et sur le kiosque de presse.

(function () {
  const elem = (t, c, x) => {
    const e = document.createElement(t);
    if (c) e.className = c;
    if (x !== undefined) e.textContent = x;
    return e;
  };

  const rayonsEl = document.getElementById('rayons');
  const sourcesEl = document.getElementById('sources');
  const corps = document.getElementById('corps');

  let rayonCourant = null;
  let fluxEnCours = null;

  /** L'heure d'une parution du jour, la date sinon. Ce qu'on veut savoir change avec l'age. */
  function quandLisible(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const memeJour = d.toDateString() === new Date().toDateString();
    return memeJour
      ? d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
  }

  function section(titre, note) {
    const bloc = elem('div', 'kiosque-section');
    const h = elem('h2', null, titre);
    if (note) h.append(elem('span', null, note));
    bloc.append(h);
    return bloc;
  }

  /**
   * Ou mene une entree.
   *
   * UNE OEUVRE MENE A SA FICHE, UNE RELEASE A LA RECHERCHE DE SON TITRE. `ddl:wawacity:123`
   * designe un depot, pas un titre de catalogue : l'envoyer a `/oeuvre.html` faisait
   * repondre « oeuvre introuvable », puisque aucun catalogue ne porte ce prefixe.
   *
   * La famille voyage avec l'entree pour que la recherche parte dans le bon rayon — sans
   * elle, la page retombe sur les mangas et cherche une BD chez les mangas.
   */
  function destination(e) {
    if (e.oeuvre) return `/oeuvre.html?id=${encodeURIComponent(e.oeuvre)}`;
    const famille = e.famille ? `&famille=${encodeURIComponent(e.famille)}` : '';
    return `/index.html?q=${encodeURIComponent(e.titre)}${famille}`;
  }

  /** Une tuile de tendance : la couverture porte le regard, le titre le confirme. */
  function tuile(e) {
    const a = elem('a', 'fiche');
    a.href = destination(e);
    if (e.couverture) {
      const img = elem('img');
      img.src = e.couverture;
      img.alt = '';
      img.loading = 'lazy';
      // AUCUN REFERENT, ET CE N'EST PAS UN DETAIL DE VIE PRIVEE.
      //
      // MangaDex sert une image de remplacement — « You can read this at mangadex.org »,
      // 600x642 — a toute requete portant un referent etranger. Mesure du 2026-09-02 sur
      // la meme adresse : sans referent 40 292 octets, la vraie couverture ; avec
      // le referent d'une instance servie en HTTPS, 59 480 octets, le placeholder.
      //
      // La page marchait deja par accident, grace a `Referrer-Policy: same-origin` pose
      // globalement. Le dire ICI rend la dependance visible : relacher cet en-tete un jour
      // aurait remplace toutes les couvertures par une pancarte, sans une seule erreur.
      img.referrerPolicy = 'no-referrer';
      a.append(img);
    } else {
      a.append(elem('div', 'sans-image'));
    }
    a.append(elem('b', null, e.titre));
    const bas = [e.etat, e.detail].filter(Boolean).join(' · ');
    if (bas) a.append(elem('small', null, bas));
    return a;
  }

  /** Une ligne de parution : quand, quoi, et chez qui. */
  function ligne(e) {
    const l = elem('div', 'kiosque-ligne');
    l.append(elem('div', 'kiosque-date', quandLisible(e.quand)));
    const t = elem('div', 'kiosque-titre');
    const a = elem('a', null, e.titre);
    a.href = destination(e);
    a.title = e.oeuvre ? 'Ouvrir la fiche' : 'Chercher ce titre chez vos sources';
    t.append(a);
    l.append(t);
    l.append(elem('div', 'kiosque-sites', [e.detail, e.source].filter(Boolean).join(' · ')));
    return l;
  }

  function pastilleSource(libelle, etat) {
    const classe = etat === 'repondu' ? 'etat etat--en-cache' : 'etat etat--inconnu';
    const mot = etat === 'repondu' ? 'a repondu' : 'n a pas repondu';
    return elem('span', classe, `${libelle} · ${mot}`);
  }

  async function peindre(rayon) {
    rayonCourant = rayon.id;
    if (fluxEnCours) fluxEnCours.abort();
    const controleur = new AbortController();
    fluxEnCours = controleur;

    sourcesEl.replaceChildren();
    corps.replaceChildren(elem('div', 'vide', 'chargement…'));

    // Les deux sections sont posees VIDES tout de suite : elles se remplissent dans
    // l'ordre ou les sources repondent, et l'ecran ne saute pas.
    const secT = section('Tendances', '');
    const grille = elem('div', 'tendances');
    secT.append(grille);
    const secN = section('Vient de sortir', '');
    // Sans date par defaut : la premiere entree datee rouvre la colonne.
    const liste = elem('div', 'kiosque kiosque--sans-date');
    secN.append(liste);

    let quelqueChose = false;
    const vues = new Set();
    const sourcesVues = new Set();
    const absentes = new Map();

    try {
      const r = await fetch(`/api/kiosque/flux?rayon=${encodeURIComponent(rayon.id)}`,
        { credentials: 'same-origin', signal: controleur.signal });
      if (!r.ok) throw new Error(`erreur ${r.status}`);
      const lecteur = r.body.getReader();
      const decodeur = new TextDecoder();
      let reste = '';

      for (;;) {
        const { value, done } = await lecteur.read();
        if (done) break;
        if (rayonCourant !== rayon.id) return;
        reste += decodeur.decode(value, { stream: true });
        const morceaux = reste.split('\n');
        reste = morceaux.pop();
        for (const brut of morceaux) {
          if (!brut.trim()) continue;
          let m;
          try { m = JSON.parse(brut); } catch { continue; }

          if (m.type === 'section-absente') {
            // ELLE S'AFFICHE AVEC SA RAISON, a sa place dans l'ordre. Retirer la section
            // sans rien dire laissait un ecran qu'on lit comme une panne.
            absentes.set(m.section, m.motif);
            continue;
          }
          if (m.type === 'rayon-non-servi') {
            corps.replaceChildren(elem('div', 'vide',
              'Aucune source ne couvre ce rayon pour l instant. Ce n est pas une panne : '
              + 'aucun site mesure ne rend ses tendances ni ses dernieres sorties.'));
            return;
          }
          if (m.type === 'erreur') throw new Error(m.erreur);
          if (m.type === 'fin') {
            const secA = section('A paraitre', '');
            secA.append(elem('div', 'vide', m.motifAParaitre));
            corps.append(secA);
            continue;
          }
          if (m.type !== 'section') continue;

          // UNE PASTILLE PAR SOURCE, pas par section : MangaDex sert les deux, et il
          // s'affichait deux fois — ce qui se lit comme deux sources.
          if (!sourcesVues.has(m.source)) {
            sourcesVues.add(m.source);
            sourcesEl.append(pastilleSource(m.libelle, m.etat));
          }
          if (!quelqueChose && m.entrees.length) {
            corps.replaceChildren(secT, secN);
            quelqueChose = true;
          }
          for (const e of m.entrees) {
            if (vues.has(e.id)) continue;
            vues.add(e.id);
            (m.section === 'tendances' ? grille : liste).append(
              m.section === 'tendances' ? tuile(e) : ligne(e),
            );
            // La colonne des dates ne se reserve que si QUELQU'UN la remplit : les sites
            // en lien direct ne datent pas leurs depots, et la place restait vide.
            if (m.section === 'nouveautes' && e.quand) liste.classList.remove('kiosque--sans-date');
          }
        }
      }
      // AUCUNE ENTREE N'EST UN FAIT, PAS UNE PANNE : les pastilles disent qui a repondu.
      // ON PEINT MEME SANS ENTREE, quand une section a une raison a donner : c'est
      // justement le cas ou l'ecran vide serait le plus trompeur.
      if (!quelqueChose && absentes.size) {
        corps.replaceChildren(secT, secN);
        quelqueChose = true;
      }
      if (!quelqueChose) {
        corps.replaceChildren(elem('div', 'vide',
          'Les sources ont repondu, mais rien a montrer pour ce rayon en ce moment.'));
      } else {
        // Une section sans contenu porte sa raison, ou disparait si elle n'en a pas.
        for (const [sec, bloc, grilleOuListe] of [['tendances', secT, grille], ['nouveautes', secN, liste]]) {
          if (grilleOuListe.children.length) continue;
          const motif = absentes.get(sec);
          if (motif) bloc.append(elem('div', 'vide', motif));
          else bloc.remove();
        }
      }
    } catch (e) {
      if (e.name === 'AbortError') return;
      corps.replaceChildren(elem('div', 'vide', `kiosque indisponible : ${e.message}`));
    }
  }

  (async () => {
    let rayons = [];
    try {
      const r = await fetch('/api/kiosque/rayons', { credentials: 'same-origin' });
      if (r.status === 401) { location.href = '/login.html'; return; }
      ({ rayons } = await r.json());
    } catch {
      corps.replaceChildren(elem('div', 'vide', 'kiosque indisponible.'));
      return;
    }

    // TOUS LES RAYONS SONT MONTRES, servis ou non. Cacher un rayon vide ferait croire
    // qu'il n'existe pas ; le montrer sans le marquer ferait croire qu'il est en panne.
    for (const [i, rayon] of rayons.entries()) {
      const b = elem('button', null, rayon.libelle);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(i === 0));
      if (!rayon.servi) b.title = 'aucune source ne couvre encore ce rayon';
      b.addEventListener('click', () => {
        for (const autre of rayonsEl.children) autre.setAttribute('aria-pressed', 'false');
        b.setAttribute('aria-pressed', 'true');
        peindre(rayon);
      });
      rayonsEl.append(b);
    }
    if (rayons.length) peindre(rayons[0]);
  })();
}());
