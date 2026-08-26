// La bibliotheque : ce qu'on suit, et ou l'on en est.
//
// Le rendu tient en une idee, L'ETAGERE. Un dos par tome, rempli a la hauteur de la
// progression. C'est la meme grammaire que la tranche de la visionneuse, remontee d'un
// cran — la-bas un dos est une planche, ici un dos est un tome. Elle montre exactement ce
// que la base contient, sans phrase a dechiffrer.
//
// La visionneuse etant une SURCOUCHE, reprendre un tome ne quitte pas cette page : on
// revient sur sa ligne en fermant, au lieu de retomber sur une liste rechargee.

(function () {
  const elem = (balise, classe, texte) => {
    const e = document.createElement(balise);
    if (classe) e.className = classe;
    if (texte !== undefined) e.textContent = texte;
    return e;
  };

  function jetonCsrf() {
    const m = document.cookie.match(/(?:^|;\s*)mangaloo-csrf=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  }

  async function api(chemin, options = {}) {
    const r = await fetch(chemin, {
      ...options,
      headers: { 'Content-Type': 'application/json', 'X-CSRF': jetonCsrf(), ...(options.headers || {}) },
    });
    if (r.status === 401) { location.href = '/login.html'; throw new Error('connexion requise'); }
    // On lit le TEXTE puis on analyse : une page d'erreur du proxy n'est pas du JSON, et
    // « unexpected character » ne dit rien a personne.
    const brut = await r.text();
    let corps = {};
    try { corps = brut ? JSON.parse(brut) : {}; } catch { corps = { erreur: brut.slice(0, 200) }; }
    if (!r.ok) throw new Error(corps.erreur || `erreur ${r.status}`);
    return corps;
  }

  const numeroDeTome = (id) => {
    const m = /^t(\d+)$/.exec(id);
    return m ? Number(m[1]) : null;
  };

  const estLu = (p) => p.planche >= p.planches - 1;

  /**
   * UN LIVRE N'EST PAS UN TOME. Sa position est enregistree sous `epub:<identite>`, ou
   * l'identite dit a quelle source le reprendre. Affichee telle quelle, elle donnait
   * « en cours epub:7ff757289ae1b6a81bc30e8eaf0ab4cefa5c4178 » — signale a l'usage.
   */
  const estLivre = (id) => String(id || '').startsWith('epub:');
  /** Un livre AUDIO : meme logique de chapitres, autre surface pour le rouvrir. */
  const estEcoute = (id) => String(id || '').startsWith('audio:');
  /** Ce qui compte des CHAPITRES plutot que des planches — les deux formes de livre. */
  const estOuvrage = (id) => estLivre(id) || estEcoute(id);
  // Le premier deux-points separe le prefixe ; ceux d'apres appartiennent a l'identite
  // elle-meme (« zl: », « tg: »). D'ou `indexOf` et non une longueur en dur, qui aurait
  // ampute « audio: » d'un caractere.
  const identiteDuLivre = (id) => String(id).slice(String(id).indexOf(':') + 1);

  const libelleTome = (id) => {
    if (estEcoute(id)) return 'le livre audio';
    if (estLivre(id)) return 'le livre';
    return id.startsWith('t') ? `Tome ${id.slice(1)}` : id.replace(/^f:/, '');
  };

  /**
   * Ou en est-on ? Un CBZ compte des PLANCHES, un livre des CHAPITRES — et un chapitre
   * etant un flux continu, il faut dire ou on en est DEDANS.
   */
  const libellePosition = (p) => {
    if (!estOuvrage(p.tome)) return `planche ${p.planche + 1}/${p.planches}`;
    const dedans = typeof p.pourcent === 'number' ? ` · ${p.pourcent} %` : '';
    return `chapitre ${p.planche + 1}/${p.planches}${dedans}`;
  };

  /**
   * Les tomes a dessiner, dans l'ordre.
   *
   * La liste memorisee de la release fait autorite : c'est elle qui contient le pack
   * ENTIER. On y ajoute les tomes ou l'on a une position sans qu'ils y figurent — cas
   * d'une release remplacee par une autre, plus courte : sa progression existe toujours et
   * la taire reviendrait a la perdre de vue.
   */
  function tomesAAfficher(entree) {
    const connus = Array.isArray(entree.tomes) ? entree.tomes.slice() : [];
    const vus = new Set(connus);
    for (const p of entree.positions) if (!vus.has(p.tome)) { connus.push(p.tome); vus.add(p.tome); }
    if (connus.length) return connus;
    return entree.positions.map((p) => p.tome);
  }

  /**
   * L'etagere.
   *
   * On ne connait QUE les tomes deja ouverts : la bibliotheque ne sait pas combien de
   * tomes compte une oeuvre, et pretendre le savoir afficherait des trous faux. On dessine
   * donc de 1 au plus grand tome atteint — ce qui est vrai, et suffit a se reperer.
   */
  /**
   * La barre d'avancement. Elle MONTRE, elle ne se clique pas.
   *
   * Le tome en cours compte pour sa propre fraction : il n'est pas fini, et le compter
   * entier mentirait dans le sens le plus agacant — celui qui fait croire qu'on a lu ce
   * qu'on n'a pas lu.
   */
  function barreAvancement(entree) {
    const tomes = tomesAAfficher(entree);
    const total = tomes.length || 1;
    const parTome = new Map(entree.positions.map((p) => [p.tome, p]));

    let lus = 0;
    let partiel = 0;
    for (const t of tomes) {
      const p = parTome.get(t);
      if (!p) continue;
      if (estLu(p)) lus++;
      else if (p.planches > 0) partiel += p.planche / p.planches;
    }

    const barre = elem('div', 'avancement');
    barre.setAttribute('role', 'img');
    barre.setAttribute('aria-label', `${lus} tome${lus > 1 ? 's' : ''} lu${lus > 1 ? 's' : ''} sur ${total}`);
    const partLue = elem('div', 'lu');
    partLue.style.width = `${(lus / total) * 100}%`;
    const partEnCours = elem('div', 'encours');
    partEnCours.style.width = `${(partiel / total) * 100}%`;
    barre.append(partLue, partEnCours);
    return { barre, lus, total };
  }

  /** Etiquette courte d'une pastille : le NUMERO, qui est ce qu'on cherche. */
  const etiquette = (id) => (id.startsWith('t') ? id.slice(1) : id.replace(/^f:/, ''));

  /**
   * La grille numerotee. Elle sert a CHOISIR.
   *
   * C'est ce que les dos de tomes faisaient mal : pour atteindre le tome 20 il fallait
   * compter des traits de sept pixels. Un numero lisible et une cible tactile reglent le
   * probleme que la jolie etagere posait.
   */
  function grilleTomes(entree, surClic) {
    const g = elem('div', 'tomes-grille');
    const parTome = new Map(entree.positions.map((p) => [p.tome, p]));

    for (const tomeId of tomesAAfficher(entree)) {
      const p = parTome.get(tomeId);
      const b = elem('button', 'pastille-tome', etiquette(tomeId));
      b.type = 'button';
      // Un fichier sans numero porte son nom : il lui faut de la place, et un numero
      // invente serait un mensonge.
      if (!tomeId.startsWith('t')) b.classList.add('nommee');
      b.dataset.etat = !p ? 'neuf' : estLu(p) ? 'lu' : 'en-cours';

      const quoi = libelleTome(tomeId);
      b.setAttribute(
        'aria-label',
        !p ? `${quoi}, jamais ouvert`
          : estLu(p) ? `${quoi}, lu`
            : `${quoi}, ${libellePosition(p)}`,
      );
      b.title = b.getAttribute('aria-label');
      b.addEventListener('click', () => surClic(tomeId, p ? p.planche : 0));
      g.append(b);
    }
    return g;
  }

  /**
   * Le debrideur qui detient cette release, ou `null` — auquel cas le message est deja
   * affiche.
   *
   * Extraite pour servir DEUX surfaces : la visionneuse et la liseuse. Un livre de
   * tracker a exactement les memes besoins qu'un CBZ — savoir chez qui il est en cache
   * avant de tenter quoi que ce soit.
   */
  async function trouverService(cle, sortie, titreOeuvre) {
    sortie.replaceChildren(elem('div', 'vide', 'verification du cache…'));

    let reponse;
    try {
      reponse = await api('/api/etats-cache', { method: 'POST', body: JSON.stringify({ hashes: [cle] }) });
    } catch (e) {
      sortie.replaceChildren(elem('div', 'vide', `verification impossible : ${e.message}`));
      return null;
    }

    let service = serviceEnCache(reponse, cle);

    // AllDebrid n'est JAMAIS renseigne par /api/etats-cache : chez lui, il n'existe aucune
    // consultation en lecture seule — savoir impose de deposer le magnet une seconde.
    // Sans cette etape, une release presente uniquement sur AllDebrid etait annoncee
    // « plus en cache » alors qu'elle y etait : le symptome rapporte.
    //
    // On le fait parce que « Reprendre » EST le geste explicite, et on le dit pendant que
    // ca se passe plutot que de le faire en silence.
    if (!service && allDebridResteAVerifier(reponse, cle)) {
      sortie.replaceChildren(elem('div', 'vide',
        'verification chez AllDebrid (depose le magnet une seconde)…'));
      try {
        const r = await api('/api/debrid/verifier', {
          method: 'POST',
          body: JSON.stringify({ hash: cle, service: 'alldebrid' }),
        });
        if (r.etat === 'en-cache') service = 'alldebrid';
      } catch (e) {
        sortie.replaceChildren(elem('div', 'vide', `verification AllDebrid impossible : ${e.message}`));
        return null;
      }
    }

    if (!service) {
      // On le DIT, et on ne tente rien de plus. Le favori ne meurt pas pour autant : il a
      // perdu son chemin d'acces, pas sa progression.
      sortie.replaceChildren(elem('div', 'message',
        'Cette release n est en cache ni chez TorBox ni chez AllDebrid. Rien n a ete conserve chez le debrideur.'));
      const b = elem('button', 'discret', 'Retrouver une release');
      b.addEventListener('click', () => { location.href = `/?q=${encodeURIComponent(titreOeuvre)}`; });
      sortie.append(b);
      return null;
    }
    return service;

  }

  /**
   * Reprend un LIVRE.
   *
   * Trois provenances, et l'identite les distingue a elle seule :
   *   `zl:<id>:<hash>` — Z-Library, rapatrie et mis en cache par le serveur
   *   `tg:<canal>:<message>` — Telegram, lu par plages d'octets
   *   quarante hexadecimaux — une release de tracker, qu'il faut rouvrir chez un
   *   debrideur pour retrouver le fichier .epub qu'elle contient.
   *
   * Les deux premieres se rouvrent sans rien demander a personne. La troisieme passe par
   * le meme chemin qu'un CBZ, parce qu'elle a les memes besoins.
   */
  async function ouvrirLivre(entree, tomeId, reprise, sortie, surFermeture) {
    const identite = identiteDuLivre(tomeId);
    const position = entree.positions.find((p) => p.tome === tomeId);
    const commun = {
      identite,
      titre: entree.titre,
      oeuvre: entree.oeuvre,
      titreOeuvre: entree.titre,
      couverture: entree.couverture || undefined,
      reprise: { chapitre: reprise || 0, pourcent: position?.pourcent ?? 0 },
      surFermeture,
    };

    // UN LIVRE AUDIO EST TOUJOURS UNE RELEASE DE TRACKER : Telegram n'en sert aucun
    // (zero fichier sonore dans son index, compte le 2026-08-26) et Z-Library non plus.
    // Il lui faut donc un debrideur, mais pas de nom de fichier : la surface d'ecoute
    // ouvre la release entiere et en tire son sommaire.
    if (estEcoute(tomeId)) {
      sortie.replaceChildren(elem('div', 'vide', 'ouverture du livre audio…'));
      const service = await trouverService(identite, sortie, entree.titre);
      if (!service) return;
      sortie.replaceChildren();
      window.Ecoute.ouvrir({ ...commun, service });
      return;
    }

    if (identite.startsWith('zl:') || identite.startsWith('tg:')) {
      sortie.replaceChildren();
      window.Liseuse.ouvrir(commun);
      return;
    }

    // Release de tracker : il faut le service et le fichier precis, qu'on redemande au
    // debrideur — l'URL du .torrent porte la passkey et ne survit pas a une recherche.
    const cle = entree.cleRelease || identite;
    sortie.replaceChildren(elem('div', 'vide', 'ouverture du livre…'));
    try {
      const service = await trouverService(cle, sortie, entree.titre);
      if (!service) return;
      const structure = await api(
        `/api/bibliotheque/fichiers?cle=${encodeURIComponent(cle)}`
          + `&service=${encodeURIComponent(service)}&oeuvre=${encodeURIComponent(entree.oeuvre)}`,
      );
      const f = (structure.fichiers || []).find((x) => /\.epub$/i.test(x.chemin));
      if (!f) {
        sortie.replaceChildren(elem('div', 'message',
          'Cette release ne contient plus de fichier epub. Votre progression est conservee.'));
        return;
      }
      sortie.replaceChildren();
      window.Liseuse.ouvrir({ ...commun, service, fichier: f.chemin });
    } catch (e) {
      sortie.replaceChildren(elem('div', 'vide', `ouverture impossible : ${e.message}`));
    }
  }

  /**
   * Ouvre un tome depuis un favori.
   *
   * L'ORDRE EST LA GARANTIE : on verifie l'etat de cache AVANT toute ouverture. La
   * contrainte permanente du projet est qu'aucune lecture ne declenche un telechargement
   * chez le debrideur — un raccourci absent ne doit donc rien tenter du tout.
   */
  async function ouvrirTome(entree, tomeId, reprise, sortie, surFermeture) {
    // UN LIVRE S'OUVRE DANS LA LISEUSE, et son chemin d'acces est DANS son identite.
    // Il ne depend donc pas du raccourci de release — d'ou « Aucune release memorisee »
    // sur un livre parfaitement reouvrable, signale a l'usage.
    if (estOuvrage(tomeId)) {
      await ouvrirLivre(entree, tomeId, reprise, sortie, surFermeture);
      return;
    }
    const cle = entree.cleRelease;
    if (!cle) {
      sortie.replaceChildren(elem('div', 'vide',
        'Aucune release memorisee pour cette oeuvre. Cherchez-en une, elle deviendra le raccourci.'));
      return;
    }

    // Un lien direct ne vit pas dans le cache d'un debrideur : sa disponibilite depend de
    // l'hebergeur et se decouvre en ouvrant la fiche. Le passer a /api/etats-cache le
    // ferait rejeter par le filtre a quarante hexadecimaux. Le parcours complet — sonder
    // les hebergeurs, en choisir un — vit dans la page de recherche ; on y renvoie plutot
    // que d'en refaire une moitie ici.
    if (estLienDirect(cle)) {
      sortie.replaceChildren(elem('div', 'message',
        'Cette release est un lien direct : sa disponibilite depend de l hebergeur, pas du cache. Ouvrez-la depuis la recherche.'));
      const b = elem('button', 'discret', 'Ouvrir depuis la recherche');
      b.addEventListener('click', () => { location.href = `/?q=${encodeURIComponent(entree.titre)}`; });
      sortie.append(b);
      return;
    }

    const service = await trouverService(cle, sortie, entree.titre);
    if (!service) return;

    sortie.replaceChildren(elem('div', 'vide', 'ouverture du tome…'));
    try {
      // On demande la liste AU DEBRIDEUR, pas au `.torrent`. L'URL du .torrent porte la
      // passkey : elle ne vit qu'en memoire, remplie par une recherche. Depuis la
      // bibliotheque il n'y en a pas eu, et cette route repondait « release inconnue :
      // relancez la recherche » — ce qui annulait la promesse meme d'un favori.
      const structure = await api(
        `/api/bibliotheque/fichiers?cle=${encodeURIComponent(cle)}`
          + `&service=${encodeURIComponent(service)}&oeuvre=${encodeURIComponent(entree.oeuvre)}`,
      );
      const f = (structure.fichiers || []).find((x) => x.tomeId === tomeId);
      if (!f) {
        // Cas prevu : une release de remplacement peut ne pas contenir ce tome.
        sortie.replaceChildren(elem('div', 'message',
          'Ce tome n est pas dans la release memorisee. Votre progression est conservee.'));
        return;
      }
      // Le tome suivant se lit dans la liste QU'ON VIENT D'OBTENIR : elle fait autorite
      // sur ce que la release contient reellement, plus que ce qu'on avait memorise.
      const ordre = (structure.fichiers || []).filter((x) => x.estBd).map((x) => x.tomeId);
      const i = ordre.indexOf(tomeId);
      const suivant = i >= 0 && i + 1 < ordre.length ? ordre[i + 1] : null;

      sortie.replaceChildren();
      window.Visionneuse.ouvrir({
        hash: cle,
        service,
        fichier: f.chemin,
        titre: f.chemin.split('/').pop(),
        oeuvre: entree.oeuvre,
        tome: tomeId,
        reprise,
        titreOeuvre: entree.titre,
        couverture: entree.couverture || undefined,
        // La carte affiche des positions chargees une fois : sans ce rappel, elle resterait
        // sur celles d'avant la lecture, et il faudrait recharger la page pour les voir.
        surFermeture,
        tomeSuivant: suivant ? { tome: suivant, libelle: libelleTome(suivant) } : null,
        // On repart de la planche 1 : c'est un tome qu'on n'a pas encore ouvert.
        surTomeSuivant: (t) => ouvrirTome(entree, t, 0, sortie, surFermeture),
      });
    } catch (e) {
      sortie.replaceChildren(elem('div', 'vide', `ouverture impossible : ${e.message}`));
    }
  }

  function carte(entree, rafraichir) {
    const bloc = elem('div', 'oeuvre-suivie');

    if (entree.couverture) {
      const img = elem('img', 'couverture');
      img.src = entree.couverture;
      img.alt = '';
      img.loading = 'lazy';
      bloc.append(img);
    } else {
      bloc.append(elem('div', 'dos-livre', entree.titre));
    }

    const droite = elem('div');
    droite.append(elem('div', 'nom', entree.titre));

    const sortie = elem('div');
    const surClic = (tomeId, planche) => ouvrirTome(entree, tomeId, planche, sortie, rafraichir);

    // UN LIVRE LU DEPUIS DEUX SOURCES N'EST PAS DEUX TOMES. Chaque source a son identite,
    // donc sa ligne de progression — d'ou « 1 / 2 tomes lu » pour un seul livre, signale a
    // l'usage. On ne garde que la lecture la plus avancee : c'est la meme oeuvre, et les
    // positions ne sont de toute facon pas comparables d'une edition a l'autre.
    // PAR NATURE, ET PAS TOUS ENSEMBLE. Deux epub du meme livre sont deux sources d'une
    // meme lecture ; un epub et sa version ecoutee sont deux lectures differentes, et
    // fondre les deux en ferait disparaitre une de l'etagere.
    for (const meme of [estLivre, estEcoute]) {
      const memes = entree.positions.filter((p) => meme(p.tome));
      if (memes.length <= 1) continue;
      const garde = memes.reduce((a, b) =>
        (b.planche / (b.planches || 1) > a.planche / (a.planches || 1) ? b : a));
      entree = { ...entree, positions: entree.positions.filter((p) => !meme(p.tome) || p === garde) };
    }

    const { barre, lus, total } = barreAvancement(entree);
    droite.append(barre);

    const enCours = entree.positions.find((p) => !estLu(p));
    const morceaux = [`${lus} / ${total} tome${total > 1 ? 's' : ''} lu${lus > 1 ? 's' : ''}`];
    if (enCours) {
      morceaux.push(`en cours ${libelleTome(enCours.tome)}, ${libellePosition(enCours)}`);
    }
    if (entree.source) morceaux.push(entree.source);
    droite.append(elem('div', 'resume', morceaux.join(' · ')));

    const actions = elem('div', 'puces actions');
    const cible = enCours || entree.positions[0];
    const reprendre = elem('button', 'principal',
      cible ? `Reprendre ${libelleTome(cible.tome)}` : 'Commencer');
    reprendre.addEventListener('click', () => surClic(cible ? cible.tome : 't1', cible ? cible.planche : 0));
    actions.append(reprendre);

    const changer = elem('button', 'discret', 'Changer de release');
    changer.addEventListener('click', () => { location.href = `/?q=${encodeURIComponent(entree.titre)}`; });
    actions.append(changer);

    const oublier = elem('button', 'discret', 'Ne plus suivre');
    oublier.addEventListener('click', async () => {
      oublier.disabled = true;
      try {
        await api('/api/bibliotheque/oublier', { method: 'POST', body: JSON.stringify({ oeuvre: entree.oeuvre }) });
        rafraichir();
      } catch (e) {
        oublier.disabled = false;
        sortie.replaceChildren(elem('div', 'vide', `impossible : ${e.message}`));
      }
    });
    actions.append(oublier);
    droite.append(actions);

    // Repliee par defaut : le geste courant est « Reprendre », et une biblioteque de
    // plusieurs oeuvres deviendrait interminable si chacune deroulait ses cent tomes.
    const tomes = tomesAAfficher(entree);
    if (tomes.length) {
      const details = elem('details');
      details.append(elem('summary', null, `Tous les tomes (${tomes.length})`));
      const grille = grilleTomes(entree, surClic);
      details.append(grille);
      // A l'ouverture, on amene le tome en cours sous les yeux : sur une longue serie, la
      // grille s'ouvrirait sinon sur le tome 1, qui n'est pas ce qu'on cherche.
      details.addEventListener('toggle', () => {
        if (!details.open) return;
        const courant = grille.querySelector('[data-etat="en-cours"]');
        if (courant) grille.scrollTop = Math.max(0, courant.offsetTop - grille.clientHeight / 2);
      });
      droite.append(details);
    }

    droite.append(sortie);
    bloc.append(droite);
    return bloc;
  }

  async function charger() {
    const liste = document.getElementById('liste');
    try {
      const { oeuvres } = await api('/api/bibliotheque');
      if (!oeuvres.length) {
        // Un ecran vide est une invitation a agir, pas un constat.
        liste.replaceChildren(elem('div', 'vide',
          'Ta bibliotheque est vide. Ouvre un tome, ou suis une oeuvre depuis une recherche.'));
        return;
      }
      liste.replaceChildren(...oeuvres.map((o) => carte(o, charger)));
    } catch (e) {
      liste.replaceChildren(elem('div', 'vide', `bibliotheque indisponible : ${e.message}`));
    }
  }

  const deco = document.getElementById('deconnexion');
  if (deco) {
    deco.addEventListener('click', async (e) => {
      e.preventDefault();
      await api('/api/logout', { method: 'POST' }).catch(() => {});
      location.href = '/login.html';
    });
  }

  charger();
})();
