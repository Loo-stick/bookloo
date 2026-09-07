// Visionneuse Mangaloo, en SURCOUCHE.
//
// Elle ne possede pas la page : elle se pose par-dessus et se retire. C'est ce qui
// permet de fermer un tome et de retomber exactement sur sa ligne dans le tableau, au
// lieu de revenir sur une recherche vide — defaut constate a l'usage.
//
// Le lien debride ne parvient JAMAIS ici : chaque planche est une image servie par
// /api/lecture/<hash>/page/<n>, que le serveur extrait a la volee du CBZ distant.

(function () {
  /**
   * Va chercher le sommaire par le flux, en signalant l'avancee.
   *
   * Le decoupage des lignes vit dans `flux-sommaire.js` — teste sans navigateur. Ici il ne
   * reste que le reseau : ouvrir, lire les morceaux, et rendre la main sur 401.
   */
  async function preparerSommaire(url, surAvancee) {
    const reponse = await fetch(url, { headers: { Accept: 'application/x-ndjson' } });
    if (reponse.status === 401) { location.href = '/login.html'; throw new Error('connexion requise'); }
    if (!reponse.ok || !reponse.body) {
      // Le serveur refuse AVANT d'ouvrir le flux : il repond alors du JSON, pas du NDJSON.
      const brut = await reponse.text();
      let detail = '';
      try { detail = JSON.parse(brut).erreur || ''; } catch { /* pas du JSON */ }
      throw new Error(detail || `le serveur a repondu ${reponse.status} sans detail`);
    }
    const lecteur = reponse.body.getReader();
    const decodeur = new TextDecoder();
    const morceaux = (async function* () {
      for (;;) {
        const { done, value } = await lecteur.read();
        if (done) return;
        yield decodeur.decode(value, { stream: true });
      }
    })();
    return sommaireDuFlux(morceaux, surAvancee);
  }

  function el(balise, classe, texte) {
    const e = document.createElement(balise);
    if (classe) e.className = classe;
    if (texte !== undefined) e.textContent = texte;
    return e;
  }

  /**
   * Lit le cookie porteur du jeton CSRF.
   *
   * DUPLIQUE depuis `app.js` (fonction `jetonCsrf`), et c'est deliberé : ces deux
   * fichiers sont servis tels quels, sans assemblage. Dependre de l'ordre de chargement
   * de l'un pour que l'autre fonctionne serait un couplage invisible — et la page de la
   * bibliotheque ne charge pas `app.js`.
   */
  function jetonCsrfLocal() {
    const m = document.cookie.match(/(?:^|;\s*)mangaloo-csrf=([^;]*)/);
    return m ? decodeURIComponent(m[1]) : '';
  }

  /**
   * `oeuvre`, `tome` et `depart` sont FOURNIS par l'appelant, jamais retenus ici.
   *
   * La visionneuse est sans etat : c'est sa raison d'etre (sous-systeme A de la spec de
   * lecture). Elle sait afficher un CBZ distant, pas ce qu'il represente dans une
   * bibliotheque. Lui confier cette connaissance la rendrait dependante d'un sous-systeme
   * qu'elle doit pouvoir ignorer.
   */
  function ouvrir({ hash, service, fichier, titre, oeuvre, tome, reprise, titreOeuvre, mangadexId, couverture, famille, surFermeture, tomeSuivant, surTomeSuivant, tomes }) {
    const base = `/api/lecture/${encodeURIComponent(hash)}`;
    const suffixe = `?service=${encodeURIComponent(service)}&fichier=${encodeURIComponent(fichier)}`;
    const urlPage = (n) => `${base}/page/${n}${suffixe}`;

    const etat = {
      pages: [],
      courante: 0,
      mode: 'page-a-page',   // ou 'continu'
      sens: 'ltr',           // ou 'rtl' — un manga se lit de droite a gauche
      vues: new Set(),
      moitie: 0,          // la moitie affichee d'une double page coupee
      zoom: 1,
      pan: { x: 0, y: 0 },
      animation: true,    // la planche suit le doigt, puis finit sa course
      rognage: true,      // retirer les marges blanches
      decoupe: true,      // couper les doubles pages
      mesures: new Map(), // par planche : dimensions, boite utile, double ou non
    };

    // --- enregistrement de la position -------------------------------------
    //
    // Deux chemins, tous deux necessaires :
    //   - `fetch` temporise (~2 s) pendant la lecture : un envoi par tour de page serait
    //     bavard sans rien apporter de plus ;
    //   - `sendBeacon` a la fermeture, seul envoi qui survit a la disparition de
    //     l'onglet.
    //
    // `sendBeacon` NE PEUT PAS poser d'en-tete : le jeton CSRF voyage donc dans le corps,
    // ce que `exigerCsrf` accepte explicitement. Sans cela l'envoi partirait en 403 sans
    // qu'on le voie, la reponse d'une balise n'etant jamais lue.
    let minuterie = null;

    function corpsPosition() {
      // `titre` designe le FICHIER ; le titre de l'OEUVRE est une autre chose et doit le
      // rester — les confondre remplirait la bibliotheque de noms de .cbz.
      //
      // Il faut savoir identifier l'oeuvre, par son identite deja formee ou par son
      // titre : sans l'un des deux, on ne peut rien enregistrer sans risquer de creer une
      // oeuvre fantome.
      if (!tome || !etat.pages.length) return null;
      if (!oeuvre && !titreOeuvre) return null;
      return {
        oeuvre: oeuvre || '',
        mangadexId: mangadexId || undefined,
        titre: titreOeuvre || undefined,
        couverture: couverture || undefined,
        // LE RAYON, TRANSMIS PAR CELUI QUI OUVRE. Sans lui, une oeuvre entree en
        // lisant n'avait pas de famille : 1 favori sur 17 en portait une, et c'est ce
        // qui faisait dire « tome » a la bibliotheque sur un journal. Meme faute, meme
        // endroit et meme correctif que la release quelques lignes plus bas — celle-la
        // etait deja passee par « seul le bouton Suivre l'enregistrait ».
        famille: famille || undefined,
        // TRANSMISE, jamais deduite : la visionneuse ne sait pas ce qu'est un pack, elle
        // se contente de faire suivre ce que l'appelant lui a donne.
        tomes: Array.isArray(tomes) && tomes.length ? tomes : undefined,
        tome,
        planche: etat.courante,
        planches: etat.pages.length,
        // LA RELEASE D'OU L'ON LIT, retenue avec la position.
        //
        // Sans elle, lire une oeuvre l'ajoutait a la bibliotheque SANS chemin d'acces :
        // « Reprendre » repondait « aucune release memorisee » sur une oeuvre pourtant
        // lue la veille. Seul le bouton « Suivre » l'enregistrait — d'ou trois lignes
        // renseignees sur dix. Signale a l'usage.
        //
        // La SOURCE n'est pas envoyee : le serveur la retrouve dans sa memoire des liens.
        cleRelease: hash,
        titreRelease: titre || undefined,
        csrf: jetonCsrfLocal(),
      };
    }

    /**
     * `parBalise` distingue DEUX situations qui n'ont pas les memes contraintes.
     *
     * La page s'en va (onglet ferme, onglet masque) : plus rien ne peut etre attendu, on
     * tire une balise et on espere. C'est le seul envoi qui survit.
     *
     * La surcouche se ferme mais la PAGE RESTE : on peut attendre, et il FAUT attendre.
     * Une balise ne s'attend pas ; rafraichir la bibliotheque juste apres relisait la
     * position d'avant, et la carte restait a la planche 6 alors qu'on venait de lire
     * jusqu'a la 9. Rendre la promesse est donc ce qui rend l'affichage juste.
     */
    function envoyerPosition(parBalise) {
      const corps = corpsPosition();
      if (!corps) return Promise.resolve();
      try {
        if (parBalise && navigator.sendBeacon) {
          navigator.sendBeacon(
            '/api/bibliotheque/progression',
            new Blob([JSON.stringify(corps)], { type: 'application/json' }),
          );
          return Promise.resolve();
        }
        return fetch('/api/bibliotheque/progression', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF': corps.csrf },
          body: JSON.stringify(corps),
        }).catch(() => {});
      } catch {
        /* L'avancement est un confort : il ne fait JAMAIS tomber la lecture en cours. */
        return Promise.resolve();
      }
    }

    function noterPosition() {
      clearTimeout(minuterie);
      minuterie = setTimeout(() => envoyerPosition(false), 2000);
    }

    function auMasquage() {
      if (document.visibilityState === 'hidden') envoyerPosition(true);
    }
    document.addEventListener('visibilitychange', auMasquage);
    function auDepart() { envoyerPosition(true); }
    window.addEventListener('pagehide', auDepart);

    // --- ossature ---------------------------------------------------------
    const surcouche = el('div', 'visionneuse');
    surcouche.setAttribute('role', 'dialog');
    surcouche.setAttribute('aria-modal', 'true');
    surcouche.setAttribute('aria-label', `Lecture de ${titre || fichier}`);

    const scene = el('div', 'visionneuse-scene');
    const barre = el('div', 'lecteur-barre');
    const tranche = el('div', 'tranche-pages');
    tranche.setAttribute('role', 'group');
    tranche.setAttribute('aria-label', 'Planches');
    const infos = el('div', 'lecteur-infos');
    const compteur = el('span', 'compteur', '—');
    const nom = el('span', null, titre || fichier);
    const fin = el('span', 'fin');
    // DES ICONES, ET LE LIBELLE COMPLET DANS `aria-label`. Trois phrases alignees —
    // « Mode : page a page », « Sens : gauche a droite », « Fermer » — faisaient de la
    // barre un formulaire pose sous la planche. Un lecteur d'ecran, lui, entend toujours
    // la phrase entiere : c'est ce que `aria-label` porte, et `title` l'affiche a la
    // souris.
    const etiqueter = (b, libelle) => {
      b.title = libelle;
      b.setAttribute('aria-label', libelle);
    };
    const commande = (glyphe, libelle) => {
      const b = el('button', 'commande', glyphe);
      b.type = 'button';
      etiqueter(b, libelle);
      return b;
    };
    const bMode = commande('▤', 'Mode : page a page');
    const bSens = commande('⇄', 'Sens : gauche a droite');
    const bAjustement = commande('⤢', 'Ajustement : largeur');
    // DECLAREES ICI, avec les autres commandes, et non pres de leurs ecouteurs : `fin.append`
    // les utilise quelques lignes plus bas, et un `const` declare apres serait dans sa zone
    // morte — une `ReferenceError` a l'ouverture, que `tsc` ne voit pas dans un fichier .js.
    const bAnimation = commande('⟿', 'Tour de page : anime');
    const bRognage = commande('▢', 'Marges : retirees');
    const bDecoupe = commande('◫', 'Doubles pages : coupees');
    const bFermer = commande('✕', 'Fermer la lecture');
    // Enchainement vers le tome suivant. La visionneuse ne sait PAS ce qu'est un pack —
    // elle est sans etat, c'est sa raison d'etre. Elle recoit un libelle et un rappel,
    // et c'est l'appelant qui sait quoi ouvrir.
    const bSuivant = el('button', 'principal', tomeSuivant ? `Tome suivant : ${tomeSuivant.libelle}` : '');
    bSuivant.hidden = true;
    fin.append(bAnimation, bRognage, bDecoupe, bAjustement, bMode, bSens, bSuivant, bFermer);
    infos.append(compteur, nom, fin);
    barre.append(tranche, infos);
    // L'INDICATEUR RESTE QUAND LE MENU S'EFFACE. En cachant la barre, j'avais cache le
    // compteur avec elle : on ne savait plus ou l'on en etait sans la rappeler. Mihon
    // separe les deux — le menu se cache, le numero reste — et il a raison.
    const indicateur = el('div', 'indicateur-planche', '');
    surcouche.append(scene, indicateur, barre);

    // --- le chrome, qui s'efface ------------------------------------------
    //
    // LA PLANCHE OCCUPE TOUT L'ECRAN, ET LA BARRE PASSE PAR-DESSUS. Elle etait une
    // etagere en `flex: none` : elle volait en permanence une bande a l'oeuvre, ce qui est
    // exactement ce qu'un lecteur ne doit pas faire.
    //
    // Elle est visible A L'OUVERTURE — sinon rien n'apprend qu'elle existe — puis s'efface.
    // Un appui au CENTRE la rappelle ; les bords, eux, tournent les pages.
    // La mecanique vit dans `chrome-lecture.js`, partagee avec la liseuse PDF : l'avoir
    // recopiee la-bas sans poser la classe avait rendu sa barre invisible et incliquable.
    const { montrer: montrerChrome, basculer: basculerChrome } = installerChrome(surcouche, barre);

    // --- fermeture --------------------------------------------------------
    const defilementAvant = document.body.style.overflow;
    /** Retire la surcouche et enregistre, dans cet ordre. Previent qui on lui dit. */
    function retirer(prevenir) {
      return fermerEnEnregistrant(() => envoyerPosition(false), () => {
        clearTimeout(minuterie);
        document.removeEventListener('visibilitychange', auMasquage);
        document.removeEventListener('keydown', auClavier);
        window.removeEventListener('pagehide', auDepart);
        surcouche.remove();
        // Sans cela, la page dessous et la surcouche defileraient toutes les deux.
        document.body.style.overflow = defilementAvant;
      }, prevenir);
    }

    function fermer() {
      return retirer(surFermeture);
    }

    /**
     * Enchaine sur le tome suivant.
     *
     * On NE previent PAS `surFermeture` ici, et c'est deliberé : ce rappel rafraichit la
     * bibliotheque, ce qui reconstruit les cartes — donc detruirait celle d'ou part
     * l'enchainement, au moment precis ou elle sert. Le rafraichissement aura lieu a la
     * fermeture du tome suivant.
     */
    async function allerAuSuivant() {
      if (!tomeSuivant || typeof surTomeSuivant !== 'function') return;
      await retirer();
      surTomeSuivant(tomeSuivant.tome);
    }
    bSuivant.addEventListener('click', allerAuSuivant);
    bFermer.addEventListener('click', fermer);

    // --- rendu ------------------------------------------------------------
    function planche(n) {
      const img = el('img', 'planche');
      img.alt = `Planche ${n + 1}`;
      img.decoding = 'async';
      img.src = urlPage(n);
      img.addEventListener('load', () => { mesurer(img, n); if (n === etat.courante) poser(); });
      img.addEventListener('error', () => {
        // Une icone d'image cassee n'apprend rien et ne propose rien.
        const bloc = el('div', 'lecteur-erreur');
        bloc.append(el('div', null, `La planche ${n + 1} n'a pas pu etre chargee.`));
        const reessayer = el('button', 'discret', 'Reessayer');
        reessayer.addEventListener('click', () => bloc.replaceWith(planche(n)));
        bloc.append(reessayer);
        img.replaceWith(bloc);
      });
      return img;
    }

    /**
     * Precharge les planches suivantes : avec le Cache-Control pose par le serveur, le
     * tournage devient instantane.
     *
     * QUATRE, et pas deux. Une planche coute environ 290 ms entre le serveur et
     * l'hebergeur (mesure du 21/08/2026), auxquels s'ajoute le tunnel : de l'ordre d'une
     * demi-seconde vue du navigateur. A deux planches d'avance, une lecture suivie
     * rattrapait la precharge et on attendait de nouveau.
     *
     * Cette fonction est rappelee a CHAQUE affichage : c'est une fenetre glissante, pas
     * une rafale. Les trois planches suivantes etant deja dans le cache du navigateur
     * (`Cache-Control: private, max-age=3600` pose par le serveur), un tour de page ne
     * declenche qu'UNE requete reelle vers le debrideur.
     */
    const AVANCE = 4;
    function precharger(n) {
      for (let i = 1; i <= AVANCE; i++) {
        const s = n + i;
        if (s < etat.pages.length) new Image().src = urlPage(s);
      }
    }

    function majTranche() {
      for (const dos of tranche.children) {
        const n = Number(dos.dataset.page);
        dos.setAttribute('aria-current', n === etat.courante ? 'true' : 'false');
        dos.dataset.vue = etat.vues.has(n) ? 'oui' : 'non';
      }
      compteur.textContent = `${etat.courante + 1} / ${etat.pages.length}`;
    }

    /**
     * Ce qu'on apprend d'une planche au moment ou elle arrive : ses dimensions, sa boite
     * utile, et si c'est une double page.
     *
     * LA BOITE SE CALCULE SUR UNE VIGNETTE de 160 px. Scanner dix millions de pixels par
     * planche ferait ramer le navigateur, et deux cents pixels de large suffisent
     * largement a trouver une marge.
     */
    function mesurer(img, n) {
      const nat = { l: img.naturalWidth, h: img.naturalHeight };
      if (!nat.l || !nat.h) return;
      let boite = null;
      try {
        const L = 160;
        const H = Math.max(1, Math.round((L * nat.h) / nat.l));
        const c = document.createElement('canvas');
        c.width = L; c.height = H;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, L, H);
        const d = ctx.getImageData(0, 0, L, H).data;
        boite = boiteUtile((x, y) => {
          const i = (y * L + x) * 4;
          return (d[i] + d[i + 1] + d[i + 2]) / 3;
        }, L, H);
      } catch {
        // Une planche qu'on ne peut pas inspecter s'affiche entiere : c'est le
        // comportement d'avant, et il n'a jamais rien casse.
        boite = null;
      }
      etat.mesures.set(n, { nat, boite, large: estDoublePage(nat.l, nat.h) });
    }

    const estCoupee = (n) => etat.decoupe && Boolean(etat.mesures.get(n)?.large);
    // En lecture droite a gauche, la PREMIERE moitie qu'on lit est celle de droite.
    const moitieAffichee = () => (etat.sens === 'rtl' ? 1 - etat.moitie : etat.moitie);

    /** Applique la pose calculee par `poseDePlanche`. Page a page seulement. */
    function poser() {
      if (etat.mode !== 'page-a-page') return;
      const img = scene.querySelector('.planche');
      const m = etat.mesures.get(etat.courante);
      if (!img || !m) return;
      const r = scene.getBoundingClientRect();
      const p = poseDePlanche({
        nat: m.nat,
        cadre: { l: r.width, h: r.height },
        boite: etat.rognage ? m.boite : null,
        moitie: estCoupee(etat.courante) ? moitieAffichee() : null,
        ajustement: etat.ajustement,
        zoom: etat.zoom,
      });
      img.style.position = 'absolute';
      img.style.left = '0';
      img.style.top = '0';
      img.style.width = `${p.largeur}px`;
      img.style.height = `${p.hauteur}px`;
      img.style.maxWidth = 'none';
      img.style.maxHeight = 'none';
      img.style.transform = `translate(${p.dx + etat.pan.x}px, ${p.dy + etat.pan.y}px)`;
      img.style.clipPath =
        `inset(${p.clip.haut}% ${p.clip.droite}% ${p.clip.bas}% ${p.clip.gauche}%)`;
    }

    function bord(cote) {
      const b = el('button', `bord bord--${cote}`);
      b.type = 'button';
      if (cote === 'centre') {
        b.setAttribute('aria-label', 'Afficher ou masquer les commandes');
        b.addEventListener('click', basculerChrome);
        return b;
      }
      const avance = etat.sens === 'rtl' ? cote === 'gauche' : cote === 'droite';
      b.setAttribute('aria-label', avance ? 'Planche suivante' : 'Planche precedente');
      b.addEventListener('click', () => (avance ? suivante() : precedente()));
      return b;
    }

    function afficher(n, moitie = 0) {
      const avant = etat.courante;
      etat.courante = Math.max(0, Math.min(etat.pages.length - 1, n));
      etat.moitie = moitie;
      // CHANGER DE PLANCHE REMET LE ZOOM A PLAT. Garder un agrandissement d'une page a
      // l'autre laisse tomber sur un coin au hasard : les planches n'ont ni le meme
      // cadrage ni la meme taille.
      if (etat.courante !== avant) { etat.zoom = 1; etat.pan = { x: 0, y: 0 }; }
      etat.vues.add(etat.courante);
      if (etat.mode === 'page-a-page') {
        scene.replaceChildren(
          planche(etat.courante), bord('gauche'), bord('centre'), bord('droite'),
        );
        precharger(etat.courante);
      } else {
        const cible = scene.querySelector(`[data-page="${etat.courante}"]`);
        if (cible) cible.scrollIntoView({ behavior: 'auto', block: 'start' });
      }
      poser();
      indicateur.textContent = etat.pages.length
        ? `${etat.courante + 1} / ${etat.pages.length}${estCoupee(etat.courante) ? (etat.moitie === 0 ? ' ·' : ' ··') : ''}`
        : '';
      majTranche();
      noterPosition();
      // Le bouton n'apparait qu'a la derniere planche : proposer la suite avant la fin
      // encombrerait la barre pour rien.
      bSuivant.hidden = !tomeSuivant || etat.courante < etat.pages.length - 1;
    }

    // UNE DOUBLE PAGE SE LIT EN DEUX ECRANS, sans changer de numero de planche : la
    // reprise, la reglette et les positions deja enregistrees continuent de designer la
    // meme chose. Le calcul vit dans `planche-outils.js`, ou il est teste.
    const suivante = () => {
      const p = avancer({ page: etat.courante, moitie: etat.moitie }, etat.pages.length, estCoupee);
      afficher(p.page, p.moitie);
    };
    const precedente = () => {
      const p = reculer({ page: etat.courante, moitie: etat.moitie }, estCoupee);
      afficher(p.page, p.moitie);
    };

    function construireContinu() {
      // Chargement a l'approche : empiler 200 images d'un coup ferait ramer le
      // navigateur et tirerait 200 requetes au debrideur pour rien.
      scene.replaceChildren();
      const observateur = new IntersectionObserver((entrees) => {
        for (const e of entrees) {
          if (!e.isIntersecting) continue;
          const n = Number(e.target.dataset.page);
          if (!e.target.querySelector('img')) e.target.append(planche(n));
          etat.courante = n;
          etat.vues.add(n);
          majTranche();
        }
      }, { root: scene, rootMargin: '800px 0px' });

      for (let n = 0; n < etat.pages.length; n++) {
        const bloc = el('div');
        bloc.dataset.page = String(n);
        // Reserve la place pour que la barre de defilement ne saute pas a chaque image.
        bloc.style.minHeight = '60vh';
        scene.append(bloc);
        observateur.observe(bloc);
      }
    }

    function basculerMode() {
      etat.mode = etat.mode === 'continu' ? 'page-a-page' : 'continu';
      surcouche.classList.toggle('continu', etat.mode === 'continu');
      // LE LIBELLE VA DANS `title` ET `aria-label`, PAS DANS LE TEXTE. Le bouton porte une
      // icone depuis le 2026-09-01 : y ecrire une phrase la remplacerait, et la barre
      // redeviendrait un formulaire au premier changement de mode.
      etiqueter(bMode, etat.mode === 'continu' ? 'Mode : defilement continu' : 'Mode : page a page');
      if (etat.mode === 'continu') construireContinu();
      afficher(etat.courante);
    }

    function basculerSens() {
      etat.sens = etat.sens === 'rtl' ? 'ltr' : 'rtl';
      // La classe sert au CSS : la reglette doit s'inverser AVEC le sens de lecture,
      // sinon elle montre la progression a l'envers de ce qu'on lit.
      surcouche.classList.toggle('rtl', etat.sens === 'rtl');
      etiqueter(bSens, etat.sens === 'rtl' ? 'Sens : droite a gauche' : 'Sens : gauche a droite');
      if (etat.mode === 'page-a-page') afficher(etat.courante);
    }

    // --- le tour de page ----------------------------------------------------
    //
    // DEUX RAISONS DE NE PAS ANIMER, et elles ne se valent pas : la bascule est un gout,
    // `prefers-reduced-motion` est un besoin. Certaines personnes ont mal au coeur devant
    // un mouvement qu'elles n'ont pas demande ; on ne leur en impose pas.
    const sansMouvement = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    const anime = () => etat.animation && !sansMouvement?.matches;
    const DUREE_MS = 190;

    function transitionUneFois(img, apres) {
      let fait = false;
      const finir = () => {
        if (fait) return;
        fait = true;
        img.removeEventListener('transitionend', finir);
        apres();
      };
      img.addEventListener('transitionend', finir);
      // FILET DE SECURITE : `transitionend` ne part pas si rien ne bouge reellement —
      // une planche deja au bord, un onglet mis en arriere-plan. Sans lui, la lecture
      // resterait bloquee sur une page a demi sortie.
      setTimeout(finir, DUREE_MS + 80);
    }

    function revenirEnPlace() {
      const img = scene.querySelector('.planche');
      if (!img) { etat.pan.x = 0; return; }
      img.classList.add('glisse');
      etat.pan.x = 0;
      poser();
    }

    function tournerLaPage(quoi, largeur) {
      const aller = () => (quoi === 'suivante' ? suivante() : precedente());
      const img = scene.querySelector('.planche');
      if (!anime() || !img) { etat.pan.x = 0; aller(); return; }

      const { sortie, entree } = glissementDePage(quoi, etat.sens, largeur);
      img.classList.add('glisse');
      etat.pan.x = sortie;
      poser();

      transitionUneFois(img, () => {
        aller();                      // remet la position a zero et pose la nouvelle
        const neuf = scene.querySelector('.planche');
        if (!neuf) return;
        // Elle arrive du cote OPPOSE : sans cela elle pousserait la precedente devant
        // elle au lieu de la remplacer.
        neuf.classList.remove('glisse');
        etat.pan.x = entree;
        poser();
        requestAnimationFrame(() => requestAnimationFrame(() => {
          neuf.classList.add('glisse');
          etat.pan.x = 0;
          poser();
        }));
      });
    }

    bAnimation.addEventListener('click', () => {
      etat.animation = !etat.animation;
      etiqueter(bAnimation, etat.animation ? 'Tour de page : anime' : 'Tour de page : instantane');
      bAnimation.classList.toggle('commande-active', etat.animation);
      montrerChrome();
    });
    bAnimation.classList.toggle('commande-active', etat.animation);

    // --- le zoom ----------------------------------------------------------
    //
    // LE DOUBLE-TAP EST AU CENTRE, ET C'EST UN COMPROMIS ASSUME. Le lier a toute la scene
    // obligerait a retarder chaque tour de page de deux cents millisecondes, le temps de
    // savoir si un second tap arrive — sur une lecture suivie, cette latence se sent a
    // chaque planche. La zone centrale, elle, ne tourne aucune page : on peut y ecouter
    // sans rien retarder. Le pinch, lui, marche partout.
    const ZOOM_TAP = 2.5;
    function zoomer(z) {
      etat.zoom = Math.min(6, Math.max(1, z));
      if (etat.zoom === 1) etat.pan = { x: 0, y: 0 };
      poser();
    }
    scene.addEventListener('dblclick', (ev) => {
      if (!(ev.target instanceof HTMLElement) || !ev.target.classList.contains('bord--centre')) return;
      zoomer(etat.zoom > 1 ? 1 : ZOOM_TAP);
    });

    // Pinch et deplacement. Deux doigts agrandissent ; un doigt deplace, mais SEULEMENT
    // quand on est agrandi — sinon un glissement accidentel decalerait une planche qui
    // tient deja entiere a l'ecran.
    const doigts = new Map();
    let ecartInitial = 0;
    let zoomInitial = 1;
    let panDepart = null;
    // Le depart du glissement, pour savoir a la fin si c'etait un balayage.
    //
    // UN SEUL CHEMIN DE GESTE, ET C'EST LE POINT. Un balayage tactile existait deja ici,
    // en `touchstart`/`touchend`, avec la meme intention : « les zones de clic laterales
    // fonctionnent au toucher, mais elles obligent a viser un tiers d'ecran alors que le
    // geste attendu sur un telephone est le balayage ». Il a ete retire au profit de
    // celui-ci, pour deux raisons.
    //
    // La premiere est qu'il IGNORAIT LE ZOOM — ajoute le meme jour : deplacer une planche
    // agrandie aurait tourne la page en meme temps. La seconde est qu'un evenement
    // `pointer` couvre aussi la souris, donc le glisse au trackpad, sans code en plus.
    //
    // Sa lecon est reprise telle quelle : on ignore le multi-touche, et on exige un
    // deplacement franchement horizontal.
    let depart = null;
    // UN BALAYAGE QUI FINIT SUR UNE ZONE DE TAP DECLENCHERAIT AUSSI SON CLIC, et deux
    // pages tourneraient d'un seul geste. On avale donc le clic qui suit immediatement.
    let avalerLeClic = false;
    scene.addEventListener('click', (ev) => {
      if (!avalerLeClic) return;
      avalerLeClic = false;
      ev.stopPropagation();
      ev.preventDefault();
    }, true);
    scene.addEventListener('pointerdown', (ev) => {
      doigts.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (doigts.size === 2) {
        const [a, b] = [...doigts.values()];
        ecartInitial = Math.hypot(a.x - b.x, a.y - b.y);
        zoomInitial = etat.zoom;
      } else if (etat.zoom > 1) {
        panDepart = { x: ev.clientX, y: ev.clientY, pan: { ...etat.pan } };
      } else {
        depart = { x: ev.clientX, y: ev.clientY };
        // La planche va suivre le doigt : on coupe la transition, sinon elle courrait
        // derriere lui avec un temps de retard.
        scene.querySelector('.planche')?.classList.remove('glisse');
      }
    });
    scene.addEventListener('pointermove', (ev) => {
      if (!doigts.has(ev.pointerId)) return;
      doigts.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (doigts.size === 2 && ecartInitial > 0) {
        const [a, b] = [...doigts.values()];
        zoomer((zoomInitial * Math.hypot(a.x - b.x, a.y - b.y)) / ecartInitial);
        return;
      }
      // LA PLANCHE SUIT LE DOIGT. C'est ce qui distingue une page qu'on manipule d'un
      // changement qu'on commande — et c'est tout l'effet recherche.
      if (depart && doigts.size === 1 && etat.zoom === 1 && anime() && etat.mode === 'page-a-page') {
        etat.pan.x = ev.clientX - depart.x;
        poser();
        return;
      }
      if (panDepart && doigts.size === 1) {
        etat.pan = {
          x: panDepart.pan.x + (ev.clientX - panDepart.x),
          y: panDepart.pan.y + (ev.clientY - panDepart.y),
        };
        poser();
      }
    });
    scene.addEventListener('pointerup', (ev) => {
      // Un seul doigt, jamais pendant un pincement : deux doigts qui se levent l'un apres
      // l'autre laisseraient sinon passer un faux balayage.
      if (depart && doigts.size === 1) {
        const r = scene.getBoundingClientRect();
        const quoi = gesteDeBalayage({
          dx: ev.clientX - depart.x,
          dy: ev.clientY - depart.y,
          largeur: r.width,
          zoom: etat.zoom,
          mode: etat.mode,
          sens: etat.sens,
        });
        if (quoi) {
          avalerLeClic = true;
          tournerLaPage(quoi, r.width);
        } else if (etat.pan.x !== 0) {
          // Geste trop court : la planche revient en place, ce qui DIT que le geste a ete
          // vu et refuse. La ramener d'un coup laisserait croire a un raté d'affichage.
          revenirEnPlace();
        }
      }
      depart = null;
    });

    for (const fin3 of ['pointerup', 'pointercancel', 'pointerleave']) {
      scene.addEventListener(fin3, (ev) => {
        doigts.delete(ev.pointerId);
        if (doigts.size < 2) ecartInitial = 0;
        if (doigts.size === 0) { panDepart = null; depart = null; }
      });
    }

    // --- rognage et decoupe ------------------------------------------------
    function majBascules() {
      etiqueter(bRognage, etat.rognage ? 'Marges : retirees' : 'Marges : gardees');
      etiqueter(bDecoupe, etat.decoupe ? 'Doubles pages : coupees' : 'Doubles pages : entieres');
      bRognage.classList.toggle('commande-active', etat.rognage);
      bDecoupe.classList.toggle('commande-active', etat.decoupe);
    }
    bRognage.addEventListener('click', () => {
      etat.rognage = !etat.rognage;
      majBascules();
      // LE ROGNAGE SE DEVINE, DONC IL SE DEFAIT. Une planche au fond gris clair, un scan
      // avec un liser  : la boite utile peut se tromper, et il faut pouvoir revenir a la
      // planche entiere sans quitter la lecture.
      afficher(etat.courante, etat.moitie);
      montrerChrome();
    });
    bDecoupe.addEventListener('click', () => {
      etat.decoupe = !etat.decoupe;
      etat.moitie = 0;
      majBascules();
      afficher(etat.courante, 0);
      montrerChrome();
    });
    majBascules();

    // La pose depend de la taille du cadre : elle se refait quand la fenetre change.
    const surRedimension = () => poser();
    window.addEventListener('resize', surRedimension);

    bMode.addEventListener('click', basculerMode);
    bSens.addEventListener('click', basculerSens);

    // --- l'ajustement -----------------------------------------------------
    //
    // TROIS FACONS DE POSER UNE PLANCHE, et elles ne servent pas le meme usage. « Hauteur »
    // fait tenir la page entiere a l'ecran : c'est ce qu'on veut pour une planche de manga.
    // « Largeur » remplit l'ecran de bord a bord : c'est ce qu'il faut pour un webtoon ou
    // pour un scan etroit, ou tenir en hauteur ne laisserait qu'un timbre-poste.
    // « Originale » n'echelonne rien, et permet d'aller lire une case dense.
    const AJUSTEMENTS = ['hauteur', 'largeur', 'originale'];
    etat.ajustement = 'hauteur';
    function appliquerAjustement() {
      for (const a of AJUSTEMENTS) surcouche.classList.toggle(`ajust-${a}`, etat.ajustement === a);
      etiqueter(bAjustement, `Ajustement : ${etat.ajustement}`);
    }
    bAjustement.addEventListener('click', () => {
      etat.ajustement = AJUSTEMENTS[(AJUSTEMENTS.indexOf(etat.ajustement) + 1) % AJUSTEMENTS.length];
      appliquerAjustement();
      montrerChrome();
    });
    appliquerAjustement();

    // --- la reglette ------------------------------------------------------
    //
    // LA TRANCHE DEVIENT LA REGLETTE. Elle montrait deja QUELLES planches sont lues — un
    // segment par planche — ce qu'aucune reglette ordinaire ne dit. Il ne lui manquait que
    // de repondre au doigt. Poser un `<input type="range">` a cote aurait ajoute un second
    // indicateur de position disant la meme chose, en moins bien.
    //
    // La correspondance abscisse -> planche vit dans `reglette.js` : elle s'inverse en
    // lecture droite a gauche, et une erreur d'une planche n'y ferait aucun bruit.
    let glisse = false;
    function viser(ev) {
      const r = tranche.getBoundingClientRect();
      const n = planchePointee(ev.clientX - r.left, r.width, etat.pages.length, etat.sens === 'rtl');
      if (n !== etat.courante) afficher(n);
    }
    tranche.addEventListener('pointerdown', (ev) => {
      // Un clic sur un segment garde son comportement : c'est le meme geste, en plus court.
      glisse = true;
      tranche.setPointerCapture(ev.pointerId);
      viser(ev);
      montrerChrome(false);
    });
    tranche.addEventListener('pointermove', (ev) => { if (glisse) viser(ev); });
    for (const fin2 of ['pointerup', 'pointercancel']) {
      tranche.addEventListener(fin2, () => { glisse = false; montrerChrome(); });
    }

    function auClavier(e) {
      if (e.target instanceof HTMLInputElement) return;
      const avance = etat.sens === 'rtl' ? 'ArrowLeft' : 'ArrowRight';
      const recule = etat.sens === 'rtl' ? 'ArrowRight' : 'ArrowLeft';
      switch (e.key) {
        case avance: case ' ': case 'ArrowDown': suivante(); break;
        case recule: case 'ArrowUp': precedente(); break;
        case 'Home': afficher(0); break;
        case 'End': afficher(etat.pages.length - 1); break;
        case 'm': basculerMode(); break;
        case 'd': basculerSens(); break;
        case 'Escape': fermer(); break;
        default: return;
      }
      e.preventDefault();
    }
    document.addEventListener('keydown', auClavier);

    // --- demarrage --------------------------------------------------------
    document.body.style.overflow = 'hidden';
    document.body.append(surcouche);
    // L'ATTENTE SE VOIT, parce qu'elle peut etre longue. Un CBR n'a pas de repertoire
    // central : ses en-tetes sont entrelaces avec les donnees, et il faut les parcourir
    // un par un. Mesure du 2026-08-31 a travers la facade Telegram : 66 s pour 189
    // planches. Derriere un « ouverture de l archive… » fige, cela passe pour une panne.
    const attente = el('div', 'lecteur-erreur');
    const attenteTexte = el('div', null, 'ouverture de l archive…');
    const jauge = el('div', 'jauge');
    const jaugeBarre = el('div', 'jauge-barre');
    jauge.append(jaugeBarre);
    jauge.hidden = true;
    attente.append(attenteTexte, jauge);
    scene.replaceChildren(attente);

    (async () => {
      let sommaire;
      try {
        sommaire = await preparerSommaire(`${base}/sommaire/flux${suffixe}`, (p) => {
          jauge.hidden = false;
          jaugeBarre.style.width = `${Math.round(p.fraction * 100)}%`;
          attenteTexte.textContent = p.entrees > 0
            ? `preparation de l archive — ${Math.round(p.fraction * 100)} %, `
              + `${p.entrees} planche${p.entrees > 1 ? 's' : ''} trouvee${p.entrees > 1 ? 's' : ''}`
            : `preparation de l archive — ${Math.round(p.fraction * 100)} %`;
        });
      } catch (e) {
        const bloc = el('div', 'lecteur-erreur');
        bloc.append(el('div', null, e.message));
        const retour = el('button', 'discret', 'Fermer');
        retour.addEventListener('click', fermer);
        bloc.append(retour);
        scene.replaceChildren(bloc);
        return;
      }

      etat.pages = sommaire.pages || [];
      tranche.replaceChildren();
      for (let n = 0; n < etat.pages.length; n++) {
        const dos = el('button', 'dos-page');
        dos.type = 'button';
        dos.dataset.page = String(n);
        dos.setAttribute('aria-label', `Aller a la planche ${n + 1}`);
        dos.addEventListener('click', () => afficher(n));
        tranche.append(dos);
      }
      // Reprise. Bornee au nombre de planches REEL : une release de remplacement peut
      // etre plus courte que celle ou la position a ete prise, et reprendre sans borner
      // ouvrirait dans le vide, sans que rien n'explique pourquoi.
      const depart = Math.min(Math.max(Number(reprise) || 0, 0), etat.pages.length - 1);
      afficher(depart);
      if (depart > 0) {
        const mention = el('span', 'puce', `reprise a la planche ${depart + 1}`);
        const debut = el('button', 'discret', 'Repartir du debut');
        debut.addEventListener('click', () => { afficher(0); mention.remove(); debut.remove(); });
        infos.insertBefore(debut, fin);
        infos.insertBefore(mention, debut);
      }
    })();

    return { fermer };
  }

  window.Visionneuse = { ouvrir };

  // Point d'entree direct : lecture.html?hash=…&service=…&fichier=…
  // Un seul code, deux facons d'y entrer.
  if (document.body?.dataset.page === 'lecture') {
    const p = new URLSearchParams(location.search);
    ouvrir({
      hash: p.get('hash') || '',
      service: p.get('service') || '',
      fichier: p.get('fichier') || '',
      titre: p.get('titre') || p.get('fichier') || '',
      // Facultatifs : sans eux la visionneuse marche, elle n'enregistre simplement rien.
      // C'est ce qui la garde utilisable seule, hors de toute bibliotheque.
      oeuvre: p.get('oeuvre') || '',
      tome: p.get('tome') || '',
      reprise: Number(p.get('reprise') || 0),
    });
  }
})();
