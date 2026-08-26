// Visionneuse Mangaloo, en SURCOUCHE.
//
// Elle ne possede pas la page : elle se pose par-dessus et se retire. C'est ce qui
// permet de fermer un tome et de retomber exactement sur sa ligne dans le tableau, au
// lieu de revenir sur une recherche vide — defaut constate a l'usage.
//
// Le lien debride ne parvient JAMAIS ici : chaque planche est une image servie par
// /api/lecture/<hash>/page/<n>, que le serveur extrait a la volee du CBZ distant.

(function () {
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
  function ouvrir({ hash, service, fichier, titre, oeuvre, tome, reprise, titreOeuvre, mangadexId, couverture, surFermeture, tomeSuivant, surTomeSuivant, tomes }) {
    const base = `/api/lecture/${encodeURIComponent(hash)}`;
    const suffixe = `?service=${encodeURIComponent(service)}&fichier=${encodeURIComponent(fichier)}`;
    const urlPage = (n) => `${base}/page/${n}${suffixe}`;

    const etat = {
      pages: [],
      courante: 0,
      mode: 'page-a-page',   // ou 'continu'
      sens: 'ltr',           // ou 'rtl' — un manga se lit de droite a gauche
      vues: new Set(),
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
        // TRANSMISE, jamais deduite : la visionneuse ne sait pas ce qu'est un pack, elle
        // se contente de faire suivre ce que l'appelant lui a donne.
        tomes: Array.isArray(tomes) && tomes.length ? tomes : undefined,
        tome,
        planche: etat.courante,
        planches: etat.pages.length,
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
    window.addEventListener('pagehide', () => envoyerPosition(true));

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
    const bMode = el('button', 'discret', 'Mode : page a page');
    const bSens = el('button', 'discret', 'Sens : gauche a droite');
    const bFermer = el('button', 'discret', 'Fermer');
    // Enchainement vers le tome suivant. La visionneuse ne sait PAS ce qu'est un pack —
    // elle est sans etat, c'est sa raison d'etre. Elle recoit un libelle et un rappel,
    // et c'est l'appelant qui sait quoi ouvrir.
    const bSuivant = el('button', 'principal', tomeSuivant ? `Tome suivant : ${tomeSuivant.libelle}` : '');
    bSuivant.hidden = true;
    fin.append(bMode, bSens, bSuivant, bFermer);
    infos.append(compteur, nom, fin);
    barre.append(tranche, infos);
    surcouche.append(scene, barre);

    // --- fermeture --------------------------------------------------------
    const defilementAvant = document.body.style.overflow;
    /** Retire la surcouche et enregistre. Ne previent personne : les appelants s'en chargent. */
    async function retirer() {
      clearTimeout(minuterie);
      document.removeEventListener('visibilitychange', auMasquage);
      document.removeEventListener('keydown', auClavier);
      surcouche.remove();
      // Sans cela, la page dessous et la surcouche defileraient toutes les deux.
      document.body.style.overflow = defilementAvant;

      // La page reste : on ATTEND l'enregistrement. Sans cette attente, l'appelant
      // rafraichirait sur la position d'avant.
      await envoyerPosition(false);
    }

    async function fermer() {
      await retirer();
      if (typeof surFermeture === 'function') surFermeture();
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

    function bord(cote) {
      const b = el('button', `bord bord--${cote}`);
      b.type = 'button';
      const avance = etat.sens === 'rtl' ? cote === 'gauche' : cote === 'droite';
      b.setAttribute('aria-label', avance ? 'Planche suivante' : 'Planche precedente');
      b.addEventListener('click', () => (avance ? suivante() : precedente()));
      return b;
    }

    function afficher(n) {
      etat.courante = Math.max(0, Math.min(etat.pages.length - 1, n));
      etat.vues.add(etat.courante);
      if (etat.mode === 'page-a-page') {
        scene.replaceChildren(planche(etat.courante), bord('gauche'), bord('droite'));
        precharger(etat.courante);
      } else {
        const cible = scene.querySelector(`[data-page="${etat.courante}"]`);
        if (cible) cible.scrollIntoView({ behavior: 'auto', block: 'start' });
      }
      majTranche();
      noterPosition();
      // Le bouton n'apparait qu'a la derniere planche : proposer la suite avant la fin
      // encombrerait la barre pour rien.
      bSuivant.hidden = !tomeSuivant || etat.courante < etat.pages.length - 1;
    }

    const suivante = () => afficher(etat.courante + 1);
    const precedente = () => afficher(etat.courante - 1);

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
      bMode.textContent = etat.mode === 'continu' ? 'Mode : defilement continu' : 'Mode : page a page';
      if (etat.mode === 'continu') construireContinu();
      afficher(etat.courante);
    }

    function basculerSens() {
      etat.sens = etat.sens === 'rtl' ? 'ltr' : 'rtl';
      bSens.textContent = etat.sens === 'rtl' ? 'Sens : droite a gauche' : 'Sens : gauche a droite';
      if (etat.mode === 'page-a-page') afficher(etat.courante);
    }

    bMode.addEventListener('click', basculerMode);
    bSens.addEventListener('click', basculerSens);

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
    /**
     * Glissement du doigt pour tourner la planche.
     *
     * Les zones de clic laterales fonctionnent au toucher, mais elles obligent a viser
     * un tiers d'ecran alors que le geste attendu sur un telephone est le balayage. Le
     * sens suit celui de la lecture : dans un manga (droite a gauche), on fait glisser
     * VERS la droite pour avancer, comme on tourne une page de papier.
     *
     * Deux garde-fous, tous deux issus de l'usage reel : on ignore le multi-touche (un
     * pincement pour agrandir une planche n'est pas un changement de page), et on exige
     * que le deplacement soit franchement horizontal, sinon un defilement vertical un
     * peu oblique ferait sauter une planche.
     */
    let depart = null;
    scene.addEventListener('touchstart', (e) => {
      depart = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
    }, { passive: true });

    scene.addEventListener('touchend', (e) => {
      const debut = depart;
      depart = null;
      if (!debut || etat.mode !== 'page-a-page' || e.changedTouches.length !== 1) return;
      const dx = e.changedTouches[0].clientX - debut.x;
      const dy = e.changedTouches[0].clientY - debut.y;
      if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      (etat.sens === 'rtl' ? dx > 0 : dx < 0) ? suivante() : precedente();
    }, { passive: true });

    document.addEventListener('keydown', auClavier);

    // --- demarrage --------------------------------------------------------
    document.body.style.overflow = 'hidden';
    document.body.append(surcouche);
    scene.replaceChildren(el('div', 'lecteur-erreur', 'ouverture de l archive…'));

    (async () => {
      let sommaire;
      try {
        const reponse = await fetch(`${base}/sommaire${suffixe}`);
        if (reponse.status === 401) { location.href = '/login.html'; return; }

        // On lit du TEXTE puis on tente de l'analyser. Un proxy qui expire renvoie une
        // page HTML, et `reponse.json()` jetait alors « JSON.parse: unexpected
        // character » — un message qui n'apprend rien et n'oriente vers rien.
        const brut = await reponse.text();
        try {
          sommaire = JSON.parse(brut);
        } catch {
          throw new Error(
            reponse.ok
              ? 'reponse inattendue du serveur (ce n est pas du JSON)'
              : `le serveur a repondu ${reponse.status} sans detail — reessayez dans un moment`,
          );
        }
        if (!reponse.ok) throw new Error(sommaire.erreur || `erreur ${reponse.status}`);
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
