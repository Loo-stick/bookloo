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

  /** Cette oeuvre se lit-elle comme un LIVRE ? On le sait par ses positions deja prises. */
  const estOuvrageAttendu = (entree) => (entree.positions || []).some((p) => estOuvrage(p.tome));

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
  /**
   * La release principale, sous la forme que `tomes-releases.js` attend.
   *
   * Le raccourci de l'oeuvre EST cette release-la : les appoints ne font que combler ce
   * qu'elle ne porte pas.
   */
  function principaleDe(entree) {
    return {
      cleRelease: entree.cleRelease,
      titreRelease: entree.titreRelease,
      source: entree.source,
      tomes: entree.tomes || [],
    };
  }

  /** Les cases de la grille. La regle vit dans `tomes-releases.js`, ou elle est testee. */
  function tomesAAfficher(entree) {
    return tomesDeLaGrille(
      principaleDe(entree), entree.appoints || [], entree.positions, entree.dernierTome,
    );
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
  // La regle vit dans `reprise.js`, testee pour de vrai. Elle etait ecrite ici et avait
  // diverge de `libelleTome` : un dos de livre s'affichait « epub:fe91e485debb7… ».
  const etiquette = (id) => etiquetteTome(id);

  /**
   * La grille numerotee. Elle sert a CHOISIR.
   *
   * C'est ce que les dos de tomes faisaient mal : pour atteindre le tome 20 il fallait
   * compter des traits de sept pixels. Un numero lisible et une cible tactile reglent le
   * probleme que la jolie etagere posait.
   */
  function grilleTomes(entree, surClic, surManquant) {
    const g = elem('div', 'tomes-grille');
    const parTome = new Map(entree.positions.map((p) => [p.tome, p]));

    for (const tomeId of tomesAAfficher(entree)) {
      const p = parTome.get(tomeId);
      const b = elem('button', 'pastille-tome', etiquette(tomeId));
      b.type = 'button';
      // QUATRE ETATS, PAS TROIS. « jamais ouvert » et « qu'aucune release ne sert » ne
      // veulent pas dire la meme chose : l'un est un tome qui attend, l'autre un trou.
      const servi = releaseDuTome(tomeId, principaleDe(entree), entree.appoints || []);
      // Un fichier sans numero porte son nom : il lui faut de la place, et un numero
      // invente serait un mensonge.
      if (!tomeId.startsWith('t')) b.classList.add('nommee');
      b.dataset.etat = !servi ? 'manquant' : !p ? 'neuf' : estLu(p) ? 'lu' : 'en-cours';

      const quoi = libelleTome(tomeId);
      b.setAttribute(
        'aria-label',
        !servi ? `${quoi}, manquant — chercher une release`
          : !p ? `${quoi}, jamais ouvert`
            : estLu(p) ? `${quoi}, lu`
              : `${quoi}, ${libellePosition(p)}`,
      );
      b.title = b.getAttribute('aria-label');
      // Un tome manquant reste une CIBLE : c'est par lui qu'on va chercher la release qui
      // le comblera. Le griser sans le rendre cliquable en ferait un cul-de-sac de plus.
      b.addEventListener('click', () => {
        if (!servi) { surManquant(tomeId); return; }
        surClic(tomeId, p ? p.planche : 0);
      });
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
  /** « 1,2 Go », « 340 Mo ». Les tailles sont ce qui departage deux releases du meme titre. */
  function poids(octets) {
    const n = Number(octets);
    if (!Number.isFinite(n) || n <= 0) return '—';
    if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} Go`;
    return `${Math.round(n / 1024 ** 2)} Mo`;
  }

  /**
   * Choisir la release memorisee, SANS quitter la bibliotheque.
   *
   * Avant, ce bouton renvoyait sur la page de recherche : on perdait l'etagere et il
   * fallait revenir a la main.
   *
   * POURQUOI LA RECHERCHE LIBRE plutot que le flux d'oeuvre. L'identite stockee ici n'est
   * pas celle qu'attend ce flux : `identiteOeuvre` prefixe par « md: » quoi qu'il arrive,
   * d'ou des « md:cv:27781 », et les entrees anciennes portent parfois l'uuid nu. La
   * reconstruire serait deviner. Le titre marche pour toutes les entrees, et c'est deja
   * ce que faisait le bouton.
   */
  /**
   * Le panneau des releases, pour DEUX gestes.
   *
   * « Changer de release » remplace le raccourci de l'oeuvre. « Prendre ce tome ailleurs »
   * attache un appoint pour un tome precis. Le panneau, lui, est le meme : ses reglages —
   * Knaben ecarte, incertaines repliees, pas de bouton de cache sur ce qui ne passe pas par
   * un debrideur — ont ete gagnes a l'usage, et un second panneau finirait par en diverger.
   *
   * @param cible `null` pour le raccourci, ou l'identite du tome a combler.
   */
  async function panneauReleases(entree, rafraichir, cible) {
    const p = window.Panneau.ouvrir({
      titre: entree.titre,
      // Une fois le panneau ouvert, plus rien ne rappelle d'ou l'on vient : sans ce
      // sous-titre on ne sait plus si l'on remplace le raccourci ou si l'on comble un trou.
      sousTitre: cible
        ? `Prendre ${libelleTome(cible)} ailleurs`
        : 'Choisir la release memorisee',
    });
    const zone = elem('div');
    p.corps.append(zone);

    const famille = entree.famille || (await demanderFamille(zone));
    if (!famille) return;

    const etat = elem('div', 'vide', 'recherche en cours…');
    // FILTRER PAR SOURCE, comme sur la page de recherche : meme classe, meme
    // « aria-pressed », donc un seul geste a apprendre. Le filtre MASQUE, il ne reordonne
    // pas — le rang reste celui que le serveur a calcule.
    const pastilles = elem('div', 'sources');
    const filtreSources = new Set();
    /** Chaque ligne posee, avec le candidat qui l'a produite : le filtre travaille sur ca. */
    const posees = [];

    /** Redessine les pastilles : une par source vue, avec son compte. */
    function majPastilles() {
      const n = compterParSource(posees.map((x) => x.c));
      pastilles.replaceChildren();
      for (const [src, combien] of [...n].sort((a2, b2) => b2[1] - a2[1])) {
        const actif = filtreSources.has(src);
        const b = elem('button', `source--repondu${actif ? ' filtre-actif' : ''}`,
          `${src} : ${combien}`);
        b.type = 'button';
        b.setAttribute('aria-pressed', String(actif));
        b.addEventListener('click', () => {
          if (filtreSources.has(src)) filtreSources.delete(src);
          else filtreSources.add(src);
          majPastilles();
          appliquerFiltre();
        });
        pastilles.append(b);
      }
    }

    /**
     * Masque ce que le filtre ecarte, DANS LES DEUX RESERVOIRS.
     *
     * Le repli des incertaines porte alors le compte de ce qu'il contient VRAIMENT :
     * annoncer « 45 incertaines » sur deux lignes visibles serait un mensonge de plus.
     */
    function appliquerFiltre() {
      let visiblesIncertaines = 0;
      for (const x of posees) {
        const passe = retenue(x.c, filtreSources);
        x.ligne.hidden = !passe;
        if (passe && !x.certain) visiblesIncertaines += 1;
      }
      blocIncertaines.hidden = visiblesIncertaines === 0;
      resumeIncertaines.textContent =
        `${visiblesIncertaines} correspondance(s) incertaine(s) — deplier`;
    }
    const liste = elem('table', 'tomes tomes--releases');
    // LES INCERTAINES A PART, ET REPLIEES — comme sur la page de recherche. Elles ne
    // disparaissent pas : sur « Old Boy », le rapprochement en ecarte trente-huit qui ne
    // partageaient que le mot « boy », et parfois l'une d'elles est la bonne.
    const listeIncertaines = elem('table', 'tomes tomes--releases');
    const blocIncertaines = elem('details');
    const resumeIncertaines = elem('summary', null, '');
    blocIncertaines.append(resumeIncertaines, listeIncertaines);
    blocIncertaines.hidden = true;
    // Le tableau DEFILE plutot que de casser : six colonnes et quatre boutons ne tiennent
    // pas sur un telephone, et retrecir les boutons jusqu'a l'illisible serait pire.
    const cadre = elem('div', 'defilable');
    cadre.append(liste);
    const cadreIncertaines = elem('div', 'defilable');
    cadreIncertaines.append(blocIncertaines);
    zone.replaceChildren(etat, pastilles, cadre, cadreIncertaines);

    const trouvees = [];
    let incertaines = 0;
    const lignes = new Map();

    try {
      // ON CHERCHE LE TITRE, TOUJOURS. Ajouter « tome 105 » a la requete cassait deux
      // choses a la fois — mesure du 2026-08-28 : le rapprochement notait
      // « One.Piece.T105… » a 0,275 au lieu de 0,90, donc zero correspondance certaine ;
      // et les sources ne trouvaient plus le fichier Telegram « One Piece 105 (2023) »,
      // qui ne porte pas le mot « tome ». Le tri par tome se fait A L'AFFICHAGE, sur la
      // plage que le serveur calcule deja pour chaque candidat.
      const numeroCherche = cible ? numeroDeTomeId(cible) : null;
      const url = `/api/recherche-libre/flux?q=${encodeURIComponent(entree.titre)}`
        + `&famille=${encodeURIComponent(famille)}`;
      const r = await fetch(url, { credentials: 'same-origin' });
      if (!r.ok) throw new Error(`erreur ${r.status}`);
      const lecteur = r.body.getReader();
      const decodeur = new TextDecoder();
      let reste = '';
      // NDJSON : une ligne, un message. On peint au fil de l'eau, comme la recherche.
      for (;;) {
        const { value, done } = await lecteur.read();
        if (done) break;
        reste += decodeur.decode(value, { stream: true });
        const morceaux = reste.split('\n');
        reste = morceaux.pop();
        for (const ligne of morceaux) {
          if (!ligne.trim()) continue;
          let msg;
          try { msg = JSON.parse(ligne); } catch { continue; }
          if (msg.type === 'erreur') throw new Error(msg.erreur);
          if (msg.type !== 'source') continue;
          for (const c of msg.ajouts || []) {
            if (!c.hash && !c.identite) continue;
            // KNABEN EST ECARTE DE CE PANNEAU. Son index public melange tout : sur
            // « Old Boy » il a remonte du spam sans le moindre rapport. Ailleurs il
            // reste utile — ici la question est « quelle release pour CETTE oeuvre »,
            // et il n'y repond pas.
            if (c.source === 'knaben') continue;
            // ECARTER CE QUI NE PEUT PAS SERVIR LE TOME CHERCHE. Le serveur a deja
            // analyse le titre de chaque candidat : « Tome 112 » et « tome 80 a 100 » ne
            // rendront jamais le 105. Une plage ILLISIBLE ne fait rien ecarter — masquer
            // ce qu'on n'a pas su lire ferait disparaitre des releases valables.
            if (couvreLeTome(c.tomes, numeroCherche) === false) continue;
            const ligne = ligneRelease(c, entree, p, rafraichir, lignes, cible);
            posees.push({ c, ligne, certain: c.certain !== false });
            if (c.certain === false) {
              incertaines++;
              listeIncertaines.append(ligne);
            } else {
              trouvees.push(c);
              liste.append(ligne);
            }
          }
          majPastilles();
          appliquerFiltre();
          etat.textContent = `${trouvees.length} release(s)…`;
        }
      }
    } catch (e) {
      etat.replaceChildren(elem('div', 'message message--erreur', e.message));
      return;
    }

    if (trouvees.length === 0) {
      etat.textContent = incertaines > 0
        ? `aucune correspondance certaine — ${incertaines} incertaine(s) a deplier.`
        : 'aucune release trouvee pour ce titre.';
      if (incertaines === 0) return;
    }
    etat.textContent = `${trouvees.length} release(s). « Verifier » interroge AllDebrid, `
      + 'ce qui depose le magnet une seconde sur votre compte.';
    const motService = elem('div');
    zone.append(motService);
    await peindreCache(trouvees, lignes, motService);
  }

  /** Le rayon, demande UNE FOIS pour les oeuvres suivies avant que la colonne existe. */
  async function demanderFamille(zone) {
    let familles = [];
    try { ({ familles } = await api('/api/familles')); } catch { familles = []; }
    if (familles.length === 0) return null;
    return new Promise((resoudre) => {
      const bloc = elem('div');
      bloc.append(elem('div', 'vide',
        'Dans quel rayon chercher ? Il decide des categories interrogees, et il '
        + "n'etait pas enregistre quand cette oeuvre a ete suivie."));
      for (const f of familles) {
        const b = elem('button', 'discret', f.libelle);
        b.addEventListener('click', () => resoudre(f.id));
        bloc.append(b);
      }
      zone.replaceChildren(bloc);
    });
  }

  /** Remplacer la release principale de l'oeuvre. */
  function changerRelease(entree, rafraichir) {
    return panneauReleases(entree, rafraichir, null);
  }

  /** Aller chercher ailleurs un tome que la release principale ne porte pas. */
  function chercherPourTome(entree, tomeId, rafraichir) {
    return panneauReleases(entree, rafraichir, tomeId);
  }

  /**
   * Attacher cette release en APPOINT pour un tome, puis refermer.
   *
   * Distinct de `poserRaccourci`, et il doit le rester : les confondre ferait qu'aller
   * chercher le tome 3 changerait la source des tomes 1 et 2.
   */
  async function poserAppoint(c, cle, entree, cible, p, rafraichir, tdEtat, bouton) {
    bouton.disabled = true;
    try {
      // `tomeCible` SEULEMENT si la release ne se numerote pas elle-meme. Une release qui
      // porte deja « t3 » comblera aussi les autres trous qu'elle couvre ; la contraindre a
      // un seul tome ferait refaire la manip cinq fois sur une serie trouee.
      // `c.tomes` est une PLAGE, pas un tableau : un `Array.isArray` la rejetait toujours,
      // et l'appoint se serait donc contraint a un seul tome — l'inverse de ce qui est
      // voulu, ou il comble aussi les autres trous qu'il couvre.
      const tomes = tomesDeLaPlage(c.tomes);

      // REMPLACER, PAS EMPILER. `releaseDuTome` retient le PREMIER appoint ajoute qui
      // couvre le tome : sans ce detachement, la nouvelle release passerait derriere
      // l'ancienne et l'ecran resterait identique. Un bouton qui ne fait rien est pire
      // qu'un bouton absent.
      //
      // La regle generale ne bouge pas — entre deux appoints, le premier ajoute gagne.
      // C'est ce GESTE-CI qui remplace, parce que c'est ce qu'il annonce.
      const deja = releaseDuTome(cible, principaleDe(entree), entree.appoints || []);
      if (deja && deja.appoint && deja.cle !== cle) {
        await api('/api/bibliotheque/appoint', {
          method: 'DELETE',
          body: JSON.stringify({ oeuvre: entree.oeuvre, cleRelease: deja.cle }),
        });
      }

      await api('/api/bibliotheque/appoint', {
        method: 'POST',
        body: JSON.stringify({
          oeuvre: entree.oeuvre,
          cleRelease: cle,
          titreRelease: c.titre,
          source: c.source,
          tomes,
          tomeCible: tomes.includes(cible) ? null : cible,
        }),
      });
      p.fermer();
      rafraichir();
    } catch (e) {
      bouton.disabled = false;
      tdEtat.replaceChildren(elem('span', 'etat etat--inconnu', e.message.slice(0, 40)));
    }
  }

  /** Poser cette release comme raccourci de l'oeuvre, puis refermer. */
  async function poserRaccourci(c, cle, entree, p, rafraichir, tdEtat, bouton) {
    bouton.disabled = true;
    try {
      await api('/api/bibliotheque/raccourci', {
        method: 'POST',
        body: JSON.stringify({
          oeuvre: entree.oeuvre,
          cleRelease: cle,
          titreRelease: c.titre,
          source: c.source,
          // CE QUE LA RELEASE ANNONCE. `c.tomes` est une PLAGE — { debut, fin } tiree du
          // titre par le serveur — et non une liste de fichiers. Sans cette conversion, la
          // bibliotheque ignorait tout du contenu d'un pack : « One Piece [1 a 100] »
          // n'affichait que les tomes deja lus.
          tomes: tomesDeLaPlage(c.tomes),
        }),
      });
      p.fermer();
      rafraichir();
    } catch (e) {
      bouton.disabled = false;
      tdEtat.replaceChildren(elem('span', 'etat etat--inconnu', e.message.slice(0, 40)));
    }
  }

  /** Une ligne : ce qui distingue deux releases, et les gestes qu'elle permet. */
  function ligneRelease(c, entree, p, rafraichir, lignes, cible) {
    const cle = c.hash || c.identite;
    const tr = elem('tr');
    const tdNom = elem('td', 'col-nom', c.titre);
    tdNom.title = c.titre;
    tr.append(tdNom);
    tr.append(elem('td', null, c.source));
    tr.append(elem('td', 'col-taille', poids(c.taille)));
    tr.append(elem('td', null, c.seeders !== undefined ? `${c.seeders} src` : '—'));

    const tdEtat = elem('td');
    // CE QUE CETTE RELEASE EST, plutot qu'un « non verifie » trompeur. Telegram et
    // Z-Library servent leurs octets eux-memes ; un lien direct depend de son hebergeur.
    // Aucun des trois n'a de cache de debrideur, donc aucune verification a proposer.
    const natureHorsDebrideur = !c.hash && (
      cle.startsWith('tg:') ? 'servi par Telegram'
        : cle.startsWith('zl:') ? 'servi par Z-Library'
          : cle.startsWith('ddl:') ? 'lien direct — depend de l hebergeur'
            : 'sans empreinte — non verifiable');
    tdEtat.append(elem('span', 'etat etat--inconnu', natureHorsDebrideur || 'non verifie'));
    tr.append(tdEtat);

    const tdActions = elem('td', 'col-actions actions-compactes');
    if (natureHorsDebrideur) {
      // Rien a verifier ni a deposer : on ne garde que le choix, qui reste valable.
      const choisirSeul = elem('button', 'principal', cible ? 'Prendre ce tome ici' : 'Choisir');
      choisirSeul.addEventListener('click', () => (cible
        ? poserAppoint(c, cle, entree, cible, p, rafraichir, tdEtat, choisirSeul)
        : poserRaccourci(c, cle, entree, p, rafraichir, tdEtat, choisirSeul)));
      tdActions.append(choisirSeul);
      lignes.set(cle, { tdEtat, offrirDepot: () => {} });
      tr.append(tdActions);
      return tr;
    }
    const verifier = elem('button', 'discret', '? AD');
    verifier.title = 'Verifier chez AllDebrid. Cela depose le magnet une seconde sur '
      + 'votre compte, puis le retire : c est le seul moyen de savoir chez eux.';
    verifier.setAttribute('aria-label', 'Verifier la disponibilite chez AllDebrid');
    verifier.addEventListener('click', async () => {
      verifier.disabled = true;
      tdEtat.replaceChildren(elem('span', 'etat etat--inconnu', 'depot en cours…'));
      try {
        const r = await api('/api/debrid/verifier', {
          method: 'POST',
          body: JSON.stringify({ hash: cle, service: 'alldebrid' }),
        });
        tdEtat.replaceChildren(elem('span',
          `etat etat--${r.etat === 'en-cache' ? 'en-cache' : 'absent'}`,
          r.etat === 'en-cache' ? 'en cache' : 'pas en cache'));
        // Absence SUE : on peut proposer le depot. « inconnu » ne le permettrait pas.
        if (r.etat === 'absent') offrirDepot('alldebrid');
        // Le depot de verification a-t-il ete retire ? Le serveur le DIT, on le repete :
        // c'est le compte de l'utilisateur qui est touche.
        if (r.message) tdEtat.title = r.message;
      } catch (e) {
        tdEtat.replaceChildren(elem('span', 'etat etat--inconnu', e.message.slice(0, 40)));
      } finally {
        verifier.disabled = false;
      }
    });
    tdActions.append(verifier);

    const choisir = elem('button', 'principal', cible ? 'Prendre ce tome ici' : 'Choisir');
    choisir.addEventListener('click', () => (cible
      ? poserAppoint(c, cle, entree, cible, p, rafraichir, tdEtat, choisir)
      : poserRaccourci(c, cle, entree, p, rafraichir, tdEtat, choisir)));
    tdActions.append(choisir);

    const deposes = new Set();
    /**
     * Proposer le depot, et SEULEMENT quand on sait que c'est absent.
     *
     * « inconnu » n'est pas « absent » : offrir un depot sur un etat qu'on ignore
     * ferait telecharger une release peut-etre deja disponible. C'est la regle du
     * projet, et elle vaut aussi pour un bouton.
     */
    function offrirDepot(nom) {
      if (deposes.has(nom)) return;
      deposes.add(nom);
      const b = elem('button', 'discret', `↓ ${nom === 'alldebrid' ? 'AD' : 'TB'}`);
      b.setAttribute('aria-label', `Deposer cette release chez ${nom}`);
      b.title = nom === 'alldebrid'
        ? 'Le depot RESTE sur votre compte AllDebrid, contrairement a la verification. '
          + 'La release entiere est telechargee, pas une selection.'
        : 'TorBox telecharge la release entiere de son cote. Comptez quelques minutes.';
      b.addEventListener('click', async () => {
        b.disabled = true;
        tdEtat.replaceChildren(elem('span', 'etat etat--inconnu', 'depot en cours…'));
        try {
          const r = await api('/api/debrid/deposer', {
            method: 'POST',
            body: JSON.stringify({ hash: cle, service: nom }),
          });
          // ON NE PRETEND PAS QUE C'EST PRET : un torrent non cache met des minutes a
          // descendre. On dit ce qui est vrai — il est sur le compte.
          tdEtat.replaceChildren(elem('span', 'etat etat--inconnu',
            `depose chez ${r.service} — telechargement en cours`));
          if (!r.avecTorrent) {
            tdEtat.title = 'Depose par empreinte seule : sans le .torrent du tracker, '
              + 'un torrent prive peut rester inerte.';
          }
          b.remove();
        } catch (e) {
          b.disabled = false;
          tdEtat.replaceChildren(elem('span', 'etat etat--inconnu', e.message.slice(0, 40)));
        }
      });
      tdActions.append(b);
    }

    lignes.set(cle, { tdEtat, offrirDepot });
    tr.append(tdActions);
    return tr;
  }

  /**
   * Les etats de cache, en UNE requete pour toutes les releases.
   *
   * TorBox repond par une consultation en lecture seule, donc gratuite. AllDebrid ne peut
   * etre renseigne ici que par une verification anterieure : chez lui, savoir impose de
   * deposer. D'ou le bouton par ligne, plutot qu'un depot de vingt magnets.
   */
  async function peindreCache(trouvees, lignes, motService) {
    const hashes = trouvees.map((c) => c.hash).filter(Boolean);
    if (hashes.length === 0) return;
    let reponse;
    try {
      reponse = await api('/api/etats-cache', { method: 'POST', body: JSON.stringify({ hashes }) });
    } catch (e) {
      // UN ECHEC NE DOIT PAS SE TAIRE. Sans ce message, toute la colonne restait « non
      // verifie » sans qu'on sache si c'etait une absence de reponse ou une absence de
      // cle — et l'utilisateur cherchait la panne du mauvais cote.
      motService.replaceChildren(elem('div', 'message message--erreur',
        `Etats de cache indisponibles : ${e.message}. Les colonnes restent vides.`));
      return;
    }

    // TorBox est le seul renseigne d'office ici. Quand il ne repond pas, le DIRE : sa
    // colonne vide n'est pas un « pas en cache ».
    const tb = reponse.etats && reponse.etats.services ? reponse.etats.services.torbox : undefined;
    if (tb === 'echec') {
      motService.replaceChildren(elem('div', 'message message--erreur',
        "TorBox n'a pas repondu : sa colonne est incomplete. Ce n'est pas un « pas en "
        + 'cache », mais une panne de leur cote — reessayez dans un moment.'));
    } else if (tb === 'cle-absente') {
      motService.replaceChildren(elem('div', 'message',
        'Aucune cle TorBox enregistree : seul AllDebrid peut etre verifie, au bouton.'));
    }
    const etatsTb = (reponse.etats && reponse.etats.torbox) || {};
    for (const [cle, ligne] of lignes) {
      const service = serviceEnCache(reponse, cle);
      if (service) {
        ligne.tdEtat.replaceChildren(elem('span', 'etat etat--en-cache', `en cache · ${service}`));
        continue;
      }
      if (!allDebridResteAVerifier(reponse, cle)) {
        ligne.tdEtat.replaceChildren(elem('span', 'etat etat--absent', 'pas en cache'));
        ligne.offrirDepot('alldebrid');
      }
      // TorBox repond gratuitement : son absence est SUE des ce lot, sans rien deposer.
      // On ne l'offre que sur « absent » — un « inconnu » veut dire qu'on ne sait pas.
      if (etatsTb[cle] === 'absent') ligne.offrirDepot('torbox');
    }
  }

  /**
   * `entree` et `rafraichir` sont FACULTATIFS : ils ne servent qu'a proposer le panneau
   * de choix quand la release n'est plus en cache. Les appelants qui ne les passent pas
   * n'ont simplement pas ce bouton.
   */
  async function trouverService(cle, sortie, titreOeuvre, entree, rafraichir) {
    // Une identite Telegram ou Z-Library n'est pas une release de debrideur : ils
    // servent leurs octets eux-memes. Demander leur cache rendait « verification
    // impossible : aucun hash a verifier », ce qui ne dit rien a personne.
    if (!estCleDebrideur(cle)) {
      sortie.replaceChildren(elem('div', 'message',
        'Cette release ne passe pas par un debrideur : elle est servie directement par sa '
        + 'source. Il n y a pas de cache a verifier.'));
      return null;
    }
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
      // On reste dans la bibliotheque : le panneau de choix existe depuis le 2026-08-26,
      // et renvoyer sur la page de recherche faisait perdre l'etagere.
      if (entree && rafraichir) {
        const b = elem('button', 'discret', 'Choisir une autre release');
        b.addEventListener('click', () => changerRelease(entree, rafraichir));
        sortie.append(b);
      }
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
    // LA DECISION VIT DANS `reprise.js`, testee pour de vrai. La recalculer ici la
    // ferait diverger — c'est exactement ce qui a produit le defaut du Talisman.
    const voie = commentRouvrir(tomeId, entree);

    if (estEcoute(tomeId)) {
      sortie.replaceChildren(elem('div', 'vide', 'ouverture du livre audio…'));
      const service = await trouverService(voie.cle, sortie, entree.titre);
      if (!service) return;
      sortie.replaceChildren();
      window.Ecoute.ouvrir({ ...commun, service });
      return;
    }

    if (voie.voie === 'liseuse') {
      sortie.replaceChildren();
      window.Liseuse.ouvrir(commun);
      return;
    }

    // Release de tracker : il faut le service et le fichier precis, qu'on redemande au
    // debrideur — l'URL du .torrent porte la passkey et ne survit pas a une recherche.
    // `voie.cle` et NON `entree.cleRelease` : le raccourci du favori peut pointer vers une
    // autre source que celle d'ou la position a ete enregistree.
    const cle = voie.cle;
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

  /** Ouvre le panneau des releases : la reponse quand c'est la release qui ne repond plus. */
  function boutonChangerRelease(entree, rafraichir) {
    const b = elem('button', 'discret', 'Changer de release');
    b.addEventListener('click', () => changerRelease(entree, rafraichir));
    return b;
  }

  /**
   * Que proposer quand un tome refuse de s'ouvrir.
   *
   * SI C'EST UN APPOINT QUI COINCE, c'est ce tome-la qu'il faut resservir, pas l'oeuvre
   * entiere. Renvoyer vers la recherche generale — ce que faisait le bouton — n'aidait pas :
   * « comment je peux juste changer la release de CE tome ? », signale a l'usage.
   *
   * Sinon c'est la release principale qui est en cause, et on retombe sur le geste large.
   */
  function sortieDeSecours(entree, tomeId, rafraichir) {
    const servi = releaseDuTome(tomeId, principaleDe(entree), entree.appoints || []);
    if (servi && servi.appoint) {
      const b = elem('button', 'discret', 'Chercher une autre release pour ce tome');
      b.addEventListener('click', () => chercherPourTome(entree, tomeId, rafraichir));
      return b;
    }
    return boutonChangerRelease(entree, rafraichir);
  }

  /** Renvoie vers la recherche, ou vit le parcours complet : choisir son hebergeur, telecharger. */
  function versLaRecherche(entree) {
    const b = elem('button', 'discret', 'Ouvrir depuis la recherche');
    b.addEventListener('click', () => { location.href = `/?q=${encodeURIComponent(entree.titre)}`; });
    return b;
  }

  /**
   * Ouvre une release en LIEN DIRECT depuis l'etagere.
   *
   * Elle n'a pas d'etat de cache a verifier : on sonde ses hebergeurs, on nomme le
   * debrideur qui sait les debloquer, et le serveur choisit l'hebergeur exact — puis le
   * rechoisit tout seul si le lien meurt en cours de lecture.
   *
   * On ne propose PAS de choisir soi-meme son hebergeur ici : « Reprendre » est un geste
   * qui reprend. Le parcours complet reste dans la recherche, et le bouton y renvoie
   * chaque fois que l'ouverture directe ne peut pas aboutir.
   */
  async function ouvrirLienDirect(entree, tomeId, reprise, sortie, surFermeture) {
    const cle = entree.cleRelease;
    sortie.replaceChildren(elem('div', 'vide', 'sondage des hebergeurs…'));

    let structure;
    try {
      structure = await api(`/api/release/${encodeURIComponent(cle)}/fichiers`);
    } catch (e) {
      sortie.replaceChildren(elem('div', 'message', e.message));
      sortie.append(versLaRecherche(entree));
      return;
    }

    const choix = hebergementUtilisable(structure);
    if (!choix) {
      // Dit AVANT l'attente d'une ouverture qu'on sait perdue. Un hebergeur mort ou non
      // pris en charge n'est pas une panne : c'est un fait sur cette release.
      sortie.replaceChildren(elem('div', 'message',
        'Aucun hebergeur de cette release n est joignable par vos debrideurs.'));
      sortie.append(sortieDeSecours(entree, tomeId, surFermeture));
      return;
    }

    // Sur Wawacity la moitie des releases sont des RAR, que la visionneuse ne lit pas, et
    // le titre ne permet pas de le deviner. On le dit plutot que d'ouvrir sur une erreur.
    //
    // ET ON PROPOSE CE QUI SERT. Un RAR se telecharge depuis la recherche ; une release
    // qu'on n'a pas su atteindre demande d'en changer — y renvoyer vers la recherche
    // ferait buter sur exactement le meme mur.
    const archive = structure.archive || {};
    const issue = issueArchive(archive);
    if (issue !== 'lire') {
      sortie.replaceChildren(elem('div', 'message',
        archive.motif || 'Cette archive ne se lit pas en ligne.'));
      sortie.append(issue === 'telecharger'
        ? versLaRecherche(entree)
        : sortieDeSecours(entree, tomeId, surFermeture));
      return;
    }

    // LE MEME NOM DE TOME QUE LA RECHERCHE. Elle ouvre sous `f:<nom du fichier>` ; deux
    // noms differents pour un meme fichier feraient deux lignes de progression, donc
    // « 1 / 2 tomes lu » pour un seul album.
    const nom = choix.nomFichier || entree.titreRelease || entree.titre;
    sortie.replaceChildren();
    window.Visionneuse.ouvrir({
      hash: cle,
      service: choix.service,
      fichier: nom,
      titre: nom,
      oeuvre: entree.oeuvre,
      tome: String(tomeId).startsWith('f:') ? tomeId : `f:${nom}`,
      reprise: reprise || 0,
      titreOeuvre: entree.titre,
      couverture: entree.couverture || undefined,
      surFermeture,
    });
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
    // LE TOME COMMANDE SA RELEASE. Un appoint sert un tome que la principale n'a pas :
    // y aller avec la cle de la principale rouvrirait le mauvais fichier, ou repondrait
    // « ce tome n'est pas dans la release memorisee » sur un tome parfaitement servi.
    const servi = releaseDuTome(tomeId, principaleDe(entree), entree.appoints || []);
    const cle = servi ? servi.cle : entree.cleRelease;
    // CE QUE L'AIGUILLAGE DOIT LIRE. `entree` porte le raccourci de l'OEUVRE ; un tome
    // servi par un appoint n'en depend pas. Lui passer l'entree faisait lire le hash du
    // pack sur un tome Telegram, conclure « debrideur », et repondre « cette release ne
    // passe pas par un debrideur » sur un fichier parfaitement lisible.
    const releaseServante = { ...entree, cleRelease: cle, source: servi ? servi.source : entree.source };
    if (!cle) {
      sortie.replaceChildren(elem('div', 'vide',
        'Aucune release memorisee pour cette oeuvre. Cherchez-en une, elle deviendra le raccourci.'));
      return;
    }

    // Un lien direct n'a pas d'etat de cache : sa disponibilite depend de l'hebergeur,
    // et se sonde. L'etagere REFUSAIT d'ouvrir et renvoyait vers la recherche — « je
    // viens de changer la release de Manhole vers wawacity, bah c'est pas cool ».
    // Choisir une release veut dire « je lis celle-ci desormais » : elle doit s'ouvrir
    // d'ou on l'a choisie.
    if (estLienDirect(cle)) {
      await ouvrirLienDirect(entree, tomeId, reprise, sortie, surFermeture);
      return;
    }

    // TELEGRAM ET Z-LIBRARY SERVENT LEURS OCTETS EUX-MEMES : ni depot, ni cache, ni
    // liste de fichiers a demander. Le tome porte deja le nom du fichier, c'est tout ce
    // que la visionneuse reclame. Sans cette branche, on tombait sur la verification de
    // cache et sur un « aucun hash a verifier » incomprehensible.
    const voie = commentRouvrir(tomeId, releaseServante);
    if (voie.voie === 'visionneuse') {
      sortie.replaceChildren();
      window.Visionneuse.ouvrir({
        hash: voie.cle,
        service: voie.service,
        fichier: (servi && servi.titre) || entree.titreRelease || entree.titre,
        titre: (servi && servi.titre) || entree.titreRelease || entree.titre,
        oeuvre: entree.oeuvre,
        tome: tomeId,
        reprise: reprise || 0,
        titreOeuvre: entree.titre,
        couverture: entree.couverture || undefined,
        surFermeture,
      });
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
        // CE QUI MANQUE ICI, C'EST CE QU'ELLE CONTIENT. Le message seul etait un
        // cul-de-sac : il disait que le tome n'y est pas, sans dire ce qu'il y a, ni ou
        // aller. Or la liste vient d'etre obtenue — la montrer ne coute rien et repond a
        // la seule question qui se pose, « alors quoi ? ».
        //
        // L'ecart entre ce que l'etagere affiche et ce que la release porte vient de ce
        // que la grille se fie a la plage annoncee par le TITRE tant qu'aucun inventaire
        // reel n'a ete obtenu. Le titre peut mentir, ou nommer ses fichiers autrement.
        const dispo = (structure.fichiers || []).filter((x) => x.estBd);
        sortie.replaceChildren(elem('div', 'message',
          `${libelleTome(tomeId)} n est pas dans cette release. Votre progression est conservee.`));

        if (dispo.length) {
          sortie.append(elem('div', 'tranche-legende',
            `Elle contient ${dispo.length} fichier(s) :`));
          const g = elem('div', 'tomes-grille');
          for (const x of dispo) {
            const b = elem('button', 'pastille-tome', etiquette(x.tomeId));
            b.type = 'button';
            if (!x.tomeId.startsWith('t')) b.classList.add('nommee');
            b.title = x.chemin;
            // On rappelle `ouvrirTome`, pas `surClic` : celui-ci vit dans `carte()` et
            // n'existe pas ici. Une portee fausse ne se voit pas a la relecture.
            b.addEventListener('click', () => ouvrirTome(entree, x.tomeId, 0, sortie, surFermeture));
            g.append(b);
          }
          sortie.append(g);
        } else if (structure.motifArchive) {
          // LA RAISON VIENT DU SERVEUR. Une archive qu'on n'a pas su ouvrir n'est pas une
          // release sans tomes : le dire autrement envoie chercher le defaut au mauvais
          // endroit, ce qui a deja coute deux diagnostics faux.
          sortie.append(elem('div', 'tranche-legende',
            `Cette release est une archive que la visionneuse n a pas su ouvrir : `
            + `${structure.motifArchive}.`));
        } else if ((structure.fichiers || []).length) {
          // LA RELEASE EST UNE ARCHIVE, PAS UNE COLLECTION DE TOMES. Mesure du 2026-08-28 :
          // « One.Piece.[T01.T105]…CHROMATIQUE » est UN fichier .zip de 15,3 Go, et non
          // cent cinq .cbz. `EXT_BD` ne reconnait que cbz/cbr/cb7/pdf/epub, donc aucun tome
          // — et la grille promettait pourtant cent cinq tomes, parce qu'elle se fiait a la
          // plage annoncee par le titre faute d'inventaire.
          const gros = structure.fichiers
            .slice().sort((a, b) => (b.taille || 0) - (a.taille || 0))[0];
          sortie.append(elem('div', 'tranche-legende',
            `Cette release est une archive unique — ${gros.chemin.split('/').pop()} `
            + `(${poids(gros.taille)}) — et non des tomes separes. La visionneuse lit des `
            + 'CBZ, pas une archive qui en contient. Choisissez une release dont les tomes '
            + 'sont des fichiers distincts.'));
        } else {
          // Aucun fichier DU TOUT : le debrideur n'a rien rendu. C'est une panne de son
          // cote, pas une propriete de la release.
          sortie.append(elem('div', 'tranche-legende',
            `${service} n a rendu aucun fichier pour cette release.`));
        }
        sortie.append(boutonChangerRelease(entree, surFermeture));
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

    // Un livre lu depuis deux sources n'est pas deux tomes, et c'est la release CHOISIE
    // qu'on garde — pas la plus avancee. La regle vit dans `reprise.js`, ou elle est
    // testee sur les valeurs de production qui l'ont fait tomber.
    entree = { ...entree, positions: fusionnerParNature(entree.positions, entree.cleRelease) };

    const { barre, lus, total } = barreAvancement(entree);
    droite.append(barre);

    // LE RACCOURCI COMMANDE. Choisir une release veut dire « je lis celle-ci desormais » :
    // c'est elle que « Reprendre » ouvre, et l'on y reprend la ou l'on en etait DANS CE
    // FICHIER. La regle vit dans `reprise.js`, ou elle est testee sur de vrais cas.
    //
    // Elle etait inverse jusqu'au 2026-08-27 — la position commandait, et lire
    // reenregistrait le raccourci dessus : un choix fait a la main etait efface au
    // premier « Reprendre ». « Du coup je peux pas changer de release ? ».
    const cible = positionAReprendre(entree.positions, entree);
    const morceaux = [`${lus} / ${total} tome${total > 1 ? 's' : ''} lu${lus > 1 ? 's' : ''}`];
    if (cible && !estLu(cible)) {
      morceaux.push(`en cours ${libelleTome(cible.tome)}, ${libellePosition(cible)}`);
    }
    const affichee = releaseAffichee(cible ? cible.tome : null, entree);
    if (affichee.source) morceaux.push(affichee.source);
    droite.append(elem('div', 'resume', morceaux.join(' · ')));

    if (affichee.titre) {
      const rel = elem('div', 'resume titres', affichee.titre);
      rel.title = affichee.titre;
      rel.classList.add('release-memorisee');
      droite.append(rel);
    }

    const actions = elem('div', 'puces actions');
    // OU COMMENCER QUAND LA RELEASE CHOISIE N'A JAMAIS ETE OUVERTE. Retomber sur « t1 »
    // n'aurait aucun sens pour un livre : c'est son identite qui fait son tome.
    const depart = cible ? cible.tome
      : entree.cleRelease && estOuvrageAttendu(entree) ? `epub:${entree.cleRelease}`
        : 't1';
    const reprendre = elem('button', 'principal',
      cible ? `Reprendre ${libelleTome(cible.tome)}` : 'Commencer');
    reprendre.addEventListener('click', () => surClic(depart, cible ? cible.planche : 0));
    actions.append(reprendre);

    // Pas de release memorisee — cas des oeuvres entrees automatiquement en lisant :
    // il n'y a ni titre a montrer ni cache a tester.
    // UNE EMPREINTE, PAS N'IMPORTE QUELLE CLE. Signale a l'usage : le bouton
    // s'affichait sur une oeuvre servie par Telegram, qui n'a aucun cache de debrideur.
    // C'est la meme faute que celle corrigee dans le panneau une heure plus tot, que je
    // n'avais pas reportee ici.
    if (estEmpreinte(entree.cleRelease)) {
      const tester = elem('button', 'discret', 'Verifier le cache');
      tester.title = 'TorBox repond par une consultation gratuite. AllDebrid n en a pas : '
        + 'il depose l EMPREINTE une seconde puis la retire. Aucun .torrent, donc aucun '
        + 'passage chez le tracker.';
      tester.addEventListener('click', async () => {
        tester.disabled = true;
        const service = await trouverService(
          entree.cleRelease, sortie, entree.titre, entree, rafraichir,
        );
        if (service) {
          sortie.replaceChildren(elem('span', 'etat etat--en-cache', `en cache · ${service}`));
        }
        tester.disabled = false;
      });
      actions.append(tester);
    }

    const changer = elem('button', 'discret', 'Changer de release');
    changer.addEventListener('click', () => changerRelease(entree, rafraichir));
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
      const grille = grilleTomes(entree, surClic,
        (tomeId) => chercherPourTome(entree, tomeId, rafraichir));
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

    // LES APPOINTS, VISIBLES ET RETIRABLES. Sans retrait, une mauvaise release reste collee
    // pour toujours. Replie par defaut, et ABSENT quand il n'y en a pas : la grande
    // majorite des oeuvres n'en aura jamais, et un repli vide serait du bruit.
    const appoints = entree.appoints || [];
    if (appoints.length > 0) {
      const blocA = elem('details');
      blocA.append(elem('summary', null, `Releases d appoint (${appoints.length})`));
      const table = elem('table', 'tomes');
      for (const a of appoints) {
        const tr = elem('tr');
        const nom = a.titreRelease || a.cleRelease;
        const tdNom = elem('td', 'col-nom', nom);
        tdNom.title = nom;
        tr.append(tdNom);
        tr.append(elem('td', null, a.source || '—'));
        // Ce qu'elle sert REELLEMENT, `tomeCible` compris : c'est la seule facon de savoir
        // laquelle retirer quand deux releases se ressemblent.
        tr.append(elem('td', null, tomesServis(a).map(libelleTome).join(', ') || '—'));

        const tdA = elem('td', 'col-actions');
        const retirer = elem('button', 'discret', 'Retirer');
        retirer.addEventListener('click', async () => {
          retirer.disabled = true;
          try {
            await api('/api/bibliotheque/appoint', {
              method: 'DELETE',
              body: JSON.stringify({ oeuvre: entree.oeuvre, cleRelease: a.cleRelease }),
            });
            rafraichir();
          } catch (e) {
            retirer.disabled = false;
            tdA.append(elem('span', 'etat etat--inconnu', e.message.slice(0, 40)));
          }
        });
        tdA.append(retirer);
        tr.append(tdA);
        table.append(tr);
      }
      // Quatre colonnes ne tiennent pas sur un telephone : la table DEFILE plutot que de
      // casser, comme celle des releases.
      const cadre = elem('div', 'defilable');
      cadre.append(table);
      blocA.append(cadre);
      droite.append(blocA);
    }

    droite.append(sortie);
    bloc.append(droite);
    return bloc;
  }

  // Les oeuvres dont on a DEJA demande le total dans cette page. Sans cette memoire, une
  // serie que le catalogue ne sait pas borner serait redemandee a chaque rafraichissement,
  // et chaque retrait d'appoint relancerait dix requetes.
  const totauxDemandes = new Set();

  /**
   * Retrouve le dernier tome des oeuvres qui n'en ont pas, APRES l'affichage.
   *
   * Le total voyage normalement dans le corps de `suivre`, envoye par le client qui a la
   * fiche en main. Les oeuvres suivies avant que ce champ existe n'en ont donc pas, et leur
   * grille s'arrete au plus grand tome deja lu — quarante-trois cases pour un pack qui en
   * annonce cent. Signale a l'usage.
   *
   * En arriere-plan et sans bloquer : l'etagere est deja peinte, et un total n'est qu'une
   * borne. On ne redessine qu'a la fin, et seulement si quelque chose a ete trouve.
   */
  async function completerLesTotaux(oeuvres, rafraichir) {
    const aCompleter = oeuvres.filter((o) => o.dernierTome == null && !totauxDemandes.has(o.oeuvre));
    if (!aCompleter.length) return;
    let trouve = false;
    for (const o of aCompleter) {
      totauxDemandes.add(o.oeuvre);
      try {
        const r = await api('/api/bibliotheque/dernier-tome', {
          method: 'POST',
          body: JSON.stringify({ oeuvre: o.oeuvre }),
        });
        if (r.dernierTome) trouve = true;
      } catch {
        // Une borne d'affichage manquante ne vaut pas un message : la grille s'arrete
        // simplement au plus grand tome connu, ce qu'elle sait deja faire.
      }
    }
    if (trouve) rafraichir();
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
      completerLesTotaux(oeuvres, charger);
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
