// Ecoute d'un livre audio, en surimpression.
//
// Meme forme que la liseuse EPUB — une barre, une zone, un pied, un sommaire en surcouche
// — mais ce qui defile ici, c'est le temps, pas le texte.
//
// LES CONTROLES SONT CEUX DU NAVIGATEUR. Une balise `<audio controls>` apporte lecture,
// pause, deplacement, volume et vitesse, deja accessibles au clavier et deja traduits.
// Les redessiner aurait coute une demi-journee pour reproduire moins bien.
//
// LE DEPLACEMENT DANS LA PISTE MARCHE PARCE QUE LE RELAIS REND LES PLAGES. Le navigateur
// demande `Range: bytes=...` tout seul ; le serveur transmet et rend le 206. Sans ca,
// sauter a la trente-cinquieme minute rapatrierait les trente-quatre premieres.

(function () {
  function el(balise, classe, texte) {
    const n = document.createElement(balise);
    if (classe) n.className = classe;
    if (texte !== undefined) n.textContent = texte;
    return n;
  }

  /**
   * LE NOM DU COOKIE EST « mangaloo-csrf », PAS « csrf ».
   *
   * DEFAUT REEL, signale a l'usage : cette fonction cherchait `csrf=`. L'ancrage exige un
   * DEBUT de cookie, donc « mangaloo-csrf=... » ne correspondait pas et le jeton valait la
   * chaine vide. Le serveur rejetait chaque envoi de position en 403 — et comme
   * l'avancement est volontairement enveloppe d'un `catch` muet, le lecteur marchait
   * parfaitement pendant que RIEN ne s'enregistrait.
   */
  function jetonCsrfLocal() {
    const m = document.cookie.match(/(?:^|;\s*)mangaloo-csrf=([^;]*)/);
    return m ? decodeURIComponent(m[1]) : '';
  }

  async function json(url) {
    const r = await fetch(url, { credentials: 'same-origin' });
    const corps = await r.json().catch(() => null);
    if (!r.ok) throw new Error(corps?.erreur || `erreur ${r.status}`);
    return corps;
  }

  /** « 3 h 04 min » pour une duree en secondes, « 4 min 12 » en dessous d'une heure. */
  function horloge(secondes) {
    if (!Number.isFinite(secondes) || secondes < 0) return '—';
    const s = Math.floor(secondes % 60);
    const m = Math.floor(secondes / 60) % 60;
    const h = Math.floor(secondes / 3600);
    const deux = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${deux(m)}:${deux(s)}` : `${m}:${deux(s)}`;
  }

  /** Les vitesses proposees. Au-dela de 2x, une voix humaine cesse d'etre suivie. */
  const VITESSES = [1, 1.25, 1.5, 1.75, 2];
  const CLE_VITESSE = 'mangaloo.ecoute.vitesse';

  /**
   * La vitesse retenue d'une fois sur l'autre.
   *
   * PREMIER ET SEUL USAGE DE `localStorage` DANS CE PROJET. Il se justifie ici : un livre
   * audio dure dix-sept heures et se reprend sur plusieurs jours — refixer 1,5x a chaque
   * ouverture annulerait tout l'interet du reglage. Le stockage peut echouer (navigation
   * privee, site bloque), et l'ecoute ne doit JAMAIS en dependre : d'ou le `try`.
   */
  function vitesseRetenue() {
    try {
      const v = Number(localStorage.getItem(CLE_VITESSE));
      return VITESSES.includes(v) ? v : 1;
    } catch {
      return 1;
    }
  }

  function retenirVitesse(v) {
    try {
      localStorage.setItem(CLE_VITESSE, String(v));
    } catch {
      /* Un reglage de confort ne fait pas tomber une lecture. */
    }
  }

  function ouvrir({ identite, titre, oeuvre, titreOeuvre, couverture, reprise, surFermeture,
    service }) {
    const parametres = new URLSearchParams();
    if (service) parametres.set('service', service);
    const suffixe = parametres.toString() ? `?${parametres}` : '';
    const base = `/api/audio/${encodeURIComponent(identite)}`;

    const fond = el('div', 'liseuse');
    const barre = el('header', 'liseuse-barre');
    const nom = el('div', 'liseuse-titre', titre || 'Livre audio');
    const position = el('div', 'liseuse-position', '');
    const sommaire = el('button', 'discret', 'Chapitres');
    const fermer = el('button', 'discret', 'Fermer');

    // UN SELECT ET NON UN BOUTON QUI DEFILE : il annonce la valeur courante sans qu'on
    // ait a cliquer pour la decouvrir, et un lecteur d'ecran l'enonce. L'etiquette est
    // cachee a l'oeil mais presente — un select nu n'est annonce que « liste ».
    const etiquetteVitesse = el('label', 'visuellement-cache', 'Vitesse de lecture');
    etiquetteVitesse.setAttribute('for', 'ecoute-vitesse');
    const vitesse = document.createElement('select');
    vitesse.id = 'ecoute-vitesse';
    vitesse.className = 'discret ecoute-vitesse';
    let vitesseCourante = vitesseRetenue();
    for (const v of VITESSES) {
      const o = document.createElement('option');
      o.value = String(v);
      o.textContent = `${String(v).replace('.', ',')}x`;
      if (v === vitesseCourante) o.selected = true;
      vitesse.append(o);
    }

    barre.append(nom, position, etiquetteVitesse, vitesse, sommaire, fermer);

    const zone = el('div', 'liseuse-zone');
    const scene = el('article', 'ecoute-scene');
    const titrePiste = el('h2', 'ecoute-piste', '');
    const son = document.createElement('audio');
    son.className = 'ecoute-son';
    son.controls = true;
    // `metadata` et pas `auto` : precharger tout un chapitre de soixante Mo avant la
    // premiere pression sur « lecture » tirerait des octets que personne n'ecoutera.
    son.preload = 'metadata';
    const message = el('div', 'ecoute-message', '');
    scene.append(titrePiste, son, message);

    const listeSommaire = el('nav', 'liseuse-sommaire');
    listeSommaire.hidden = true;
    zone.append(listeSommaire, scene);

    const pied = el('div', 'liseuse-pied');
    const precedent = el('button', 'discret', '← Chapitre precedent');
    const suivant = el('button', 'principal', 'Chapitre suivant →');
    pied.append(precedent, suivant);

    fond.append(barre, zone, pied);
    document.body.append(fond);
    document.body.classList.add('sans-defilement-page');

    let chapitres = [];
    let courant = 0;
    let dernierPourcent = 0;
    // Position a rejoindre des que la duree du chapitre sera connue. `<audio>` refuse
    // `currentTime` tant que les metadonnees ne sont pas la.
    let pourcentAReprendre = 0;

    function corpsPosition() {
      if (!oeuvre && !titreOeuvre) return null;
      return {
        oeuvre: oeuvre || '',
        titre: titreOeuvre || titre || '',
        couverture: couverture || undefined,
        tome: `audio:${identite}`,
        // L'index du chapitre, PAS son numero — meme convention que partout ailleurs,
        // ou `bornerPlanche` plafonne a `planches - 1`.
        planche: courant,
        planches: Math.max(1, chapitres.length),
        pourcent: dernierPourcent,
        // LA RELEASE D'OU L'ON LIT, retenue avec la position.
        //
        // Sans elle, lire une oeuvre l'ajoutait a la bibliotheque SANS chemin d'acces :
        // « Reprendre » repondait « aucune release memorisee » sur une oeuvre pourtant
        // lue la veille. Seul le bouton « Suivre » l'enregistrait — d'ou trois lignes
        // renseignees sur dix. Signale a l'usage.
        //
        // La SOURCE n'est pas envoyee : le serveur la retrouve dans sa memoire des liens.
        cleRelease: identite,
        titreRelease: titre || undefined,
        csrf: jetonCsrfLocal(),
      };
    }

    function envoyerPosition(parBalise) {
      const corps = corpsPosition();
      if (!corps) return Promise.resolve();
      try {
        if (parBalise && navigator.sendBeacon) {
          navigator.sendBeacon('/api/bibliotheque/progression',
            new Blob([JSON.stringify(corps)], { type: 'application/json' }));
          return Promise.resolve();
        }
        return fetch('/api/bibliotheque/progression', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-CSRF': corps.csrf },
          body: JSON.stringify(corps),
          // UN ECHEC NE DOIT PAS TOMBER DANS LE SILENCE. Il ne fait pas tomber l'ecoute
          // — c'est la regle — mais il se voit dans la console. Un 403 avale pendant des
          // heures, c'est ce qui a rendu ce defaut invisible.
        }).then((r) => {
          if (!r.ok) console.warn('avancement non enregistre :', r.status);
        }).catch((e) => console.warn('avancement non envoye :', e.message));
      } catch {
        /* L'avancement est un confort : il ne fait JAMAIS tomber l'ecoute en cours. */
        return Promise.resolve();
      }
    }

    function majPosition() {
      const c = chapitres[courant];
      const total = Number.isFinite(son.duration) ? son.duration : NaN;
      const oe = `${courant + 1}/${Math.max(1, chapitres.length)}`;
      position.textContent = Number.isFinite(total)
        ? `${oe} · ${horloge(son.currentTime)} / ${horloge(total)}`
        : oe;
      titrePiste.textContent = c ? c.titre : '';
    }

    // `timeupdate` se declenche environ quatre fois par seconde : on n'enregistre
    // qu'apres une pause, sinon chaque ecoute inonderait le serveur.
    let minuteur = null;
    son.addEventListener('timeupdate', () => {
      if (Number.isFinite(son.duration) && son.duration > 0) {
        dernierPourcent = Math.round((son.currentTime / son.duration) * 100);
      }
      majPosition();
      clearTimeout(minuteur);
      minuteur = setTimeout(() => envoyerPosition(false), 4000);
    });

    /**
     * Applique la vitesse a la piste en cours.
     *
     * A REJOUER A CHAQUE CHANGEMENT DE SOURCE. Plusieurs navigateurs remettent
     * `playbackRate` a 1 quand `src` change : sans ce rappel, la vitesse choisie tenait
     * jusqu'au chapitre suivant puis retombait, sans le moindre signe.
     *
     * `preservesPitch` garde la hauteur de la voix. Sans lui, 1,5x fait parler le
     * narrateur comme un dessin anime. Les navigateurs le mettent a vrai par defaut
     * aujourd'hui, mais Safari a longtemps demande le prefixe : on pose les deux.
     */
    function appliquerVitesse() {
      son.preservesPitch = true;
      son.webkitPreservesPitch = true;
      son.playbackRate = vitesseCourante;
    }

    vitesse.addEventListener('change', () => {
      const v = Number(vitesse.value);
      vitesseCourante = VITESSES.includes(v) ? v : 1;
      retenirVitesse(vitesseCourante);
      appliquerVitesse();
    });

    son.addEventListener('loadedmetadata', () => {
      appliquerVitesse();
      if (pourcentAReprendre > 0 && Number.isFinite(son.duration)) {
        son.currentTime = (son.duration * pourcentAReprendre) / 100;
        pourcentAReprendre = 0;
      }
      majPosition();
    });

    son.addEventListener('error', () => {
      message.textContent = 'cette piste n a pas pu etre ouverte';
    });

    // UN LIVRE AUDIO S'ECOUTE D'AFFILEE. S'arreter a la fin de chaque chapitre pour
    // reclamer un clic serait le seul endroit du site ou l'on interrompt quelqu'un sans
    // raison.
    son.addEventListener('ended', () => {
      if (courant < chapitres.length - 1) afficher(courant + 1, 0, true);
      else envoyerPosition(false);
    });

    function afficher(n, pourcentDepart, enchainer) {
      courant = Math.max(0, Math.min(n, chapitres.length - 1));
      message.textContent = '';
      precedent.disabled = courant === 0;
      suivant.disabled = courant >= chapitres.length - 1;
      pourcentAReprendre = pourcentDepart || 0;
      dernierPourcent = pourcentAReprendre;
      son.src = `${base}/piste/${courant}${suffixe}`;
      majPosition();
      // On ne lance la lecture que sur une action deja consentie — enchainement de
      // chapitre. A l'ouverture, le navigateur la refuserait de toute facon.
      if (enchainer) son.play().catch(() => {});
      envoyerPosition(false);
    }

    precedent.addEventListener('click', () => afficher(courant - 1, 0, true));
    suivant.addEventListener('click', () => afficher(courant + 1, 0, true));
    sommaire.addEventListener('click', () => { listeSommaire.hidden = !listeSommaire.hidden; });

    function partir() {
      fermerEnEnregistrant(() => envoyerPosition(false), () => {
        clearTimeout(minuteur);
        document.removeEventListener('keydown', surTouche);
        document.removeEventListener('visibilitychange', auMasquage);
        window.removeEventListener('pagehide', auDepart);
        son.pause();
        // Vider la source coupe le tirage d'octets : sans ca, le navigateur continue de
        // remplir son tampon apres la fermeture.
        son.removeAttribute('src');
        son.load();
        fond.remove();
        document.body.classList.remove('sans-defilement-page');
      }, surFermeture);
    }
    fermer.addEventListener('click', partir);

    function surTouche(ev) {
      // Les fleches appartiennent aux controles du navigateur des qu'ils ont le focus :
      // elles y deplacent la tete de lecture, ce qui est ce qu'on attend.
      if (ev.target === son) return;
      if (ev.key === 'Escape') { partir(); return; }
      if (ev.key === 'ArrowRight' && !suivant.disabled) afficher(courant + 1, 0, true);
      if (ev.key === 'ArrowLeft' && !precedent.disabled) afficher(courant - 1, 0, true);
    }
    // Fermer l'onglet n'appelle pas « partir() » : sans ce filet, la lecture en cours
    // se perdait. La balise, elle, survit au depart de la page.
    function auMasquage() {
      if (document.visibilityState === 'hidden') envoyerPosition(true);
    }
    function auDepart() { envoyerPosition(true); }
    document.addEventListener('visibilitychange', auMasquage);
    window.addEventListener('pagehide', auDepart);
    document.addEventListener('keydown', surTouche);

    (async () => {
      message.textContent = 'ouverture…';
      try {
        const s = await json(`${base}/sommaire${suffixe}`);
        chapitres = s.chapitres || [];
        if (!chapitres.length) throw new Error('aucun chapitre dans cette release');
        if (s.titre) nom.textContent = s.titre;
        listeSommaire.replaceChildren(...chapitres.map((c) => {
          const b = el('button', 'discret', c.titre);
          b.addEventListener('click', () => { listeSommaire.hidden = true; afficher(c.n, 0, true); });
          return b;
        }));
        afficher(reprise?.chapitre ?? 0, reprise?.pourcent ?? 0, false);
      } catch (e) {
        // Le refus du M4B arrive ici, avec sa raison : « ses chapitres ne sont pas encore
        // lus ici ; le fichier reste telechargeable ».
        message.textContent = e.message;
      }
    })();
  }

  window.Ecoute = { ouvrir };
}());
