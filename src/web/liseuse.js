// Liseuse EPUB, en SURCOUCHE — comme la visionneuse, et pour la meme raison : fermer un
// livre doit ramener exactement sur la ligne qu'on lisait, pas sur une recherche vide.
//
// C'EST UNE AUTRE SURFACE QUE LA VISIONNEUSE, et ce n'est pas un doublon. Celle-ci
// affiche des PLANCHES : des images numerotees, une par ecran, ou la position est un
// entier. Un chapitre de livre est un flux continu de texte : la position y est un
// pourcentage, la navigation se fait au chapitre, et la lisibilite tient a la longueur de
// ligne et a l'interlignage — des questions qui n'existent pas pour une planche.
//
// Le contenu arrive DEJA NETTOYE par le serveur (`nettoyerChapitre`) : ni script, ni
// gestionnaire d'evenement, ni feuille de style du livre. Ce fichier ne fait donc
// qu'afficher, et n'a aucune decision de securite a prendre — c'est voulu, la decision
// est prise une fois, du cote ou elle se teste.

(function () {
  function el(balise, classe, texte) {
    const e = document.createElement(balise);
    if (classe) e.className = classe;
    if (texte !== undefined) e.textContent = texte;
    return e;
  }

  function jetonCsrfLocal() {
    const m = document.cookie.match(/(?:^|;\s*)mangaloo-csrf=([^;]*)/);
    return m ? decodeURIComponent(m[1]) : '';
  }

  async function json(url) {
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    const corps = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(corps.erreur || `erreur ${r.status}`);
    return corps;
  }

  function ouvrir({ identite, titre, oeuvre, titreOeuvre, couverture, famille, reprise, surFermeture,
    service, fichier }) {
    // `service` et `fichier` ne servent QUE pour une release de tracker : le serveur en a
    // besoin pour deposer chez le debrideur et retrouver le bon fichier dans la release.
    // Telegram et Z-Library n'en ont pas — leur identite suffit.
    const parametres = new URLSearchParams();
    if (service) parametres.set('service', service);
    if (fichier) parametres.set('fichier', fichier);
    const suffixe = parametres.toString() ? `?${parametres}` : '';
    const base = `/api/epub/${encodeURIComponent(identite)}`;
    const fond = el('div', 'liseuse');
    const barre = el('header', 'liseuse-barre');
    const nom = el('div', 'liseuse-titre', titre || 'Livre');
    const position = el('div', 'liseuse-position', '');
    const sommaire = el('button', 'discret', 'Sommaire');
    const fermer = el('button', 'discret', 'Fermer');
    barre.append(nom, position, sommaire, fermer);

    const page = el('article', 'liseuse-page');
    const pied = el('div', 'liseuse-pied');
    const precedent = el('button', 'discret', '← Chapitre precedent');
    const suivant = el('button', 'principal', 'Chapitre suivant →');
    pied.append(precedent, suivant);

    const listeSommaire = el('nav', 'liseuse-sommaire');
    listeSommaire.hidden = true;

    // Le sommaire est pose DANS la zone de lecture, en surcouche : hors du flux, il ne
    // retrecit pas la colonne et ne fausse donc pas le pourcentage enregistre.
    const zone = el('div', 'liseuse-zone');
    zone.append(listeSommaire, page);
    fond.append(barre, zone, pied);
    document.body.append(fond);
    document.body.classList.add('sans-defilement-page');

    let chapitres = [];
    let courant = 0;
    let dernierPourcent = 0;
    // Chapitres deja rapatries, par index. Le serveur garde le livre ouvert trente
    // minutes : un chapitre precharge ne coute plus qu'une requete de plage.
    const enAvance = new Map();

    /** La position, envoyee au serveur. Un livre n'a pas de planches : le CHAPITRE en
     *  tient lieu, et le pourcentage dit ou on en est dedans. */
    function corpsPosition() {
      if (!oeuvre && !titreOeuvre) return null;
      return {
        oeuvre: oeuvre || '',
        titre: titreOeuvre || titre || '',
        couverture: couverture || undefined,
        tome: `epub:${identite}`,
        // LE RAYON, TRANSMIS PAR CELUI QUI OUVRE. Sans lui, une oeuvre entree en
        // lisant n'avait pas de famille : 1 favori sur 17 en portait une, et c'est ce
        // qui faisait dire « tome » a la bibliotheque sur un journal. Meme faute, meme
        // endroit et meme correctif que la release quelques lignes plus bas — celle-la
        // etait deja passee par « seul le bouton Suivre l'enregistrait ».
        famille: famille || undefined,
        // L'index du chapitre, PAS son numero. Les planches sont comptees a partir de
        // zero partout ailleurs, et `bornerPlanche` plafonne a `planches - 1` : un
        // « + 1 » decalait l'affichage d'un cran et ecrasait le dernier chapitre.
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
        }).catch(() => {});
      } catch {
        /* L'avancement est un confort : il ne fait JAMAIS tomber la lecture en cours. */
        return Promise.resolve();
      }
    }

    // Le defilement se produit des dizaines de fois par seconde : on n'envoie qu'apres
    // une pause, sinon chaque lecture inonderait le serveur.
    let minuteur = null;
    function surDefilement() {
      const h = page.scrollHeight - page.clientHeight;
      dernierPourcent = h > 0 ? Math.round((page.scrollTop / h) * 100) : 0;
      majPosition();
      clearTimeout(minuteur);
      minuteur = setTimeout(() => envoyerPosition(false), 1200);
    }
    page.addEventListener('scroll', surDefilement, { passive: true });

    function majPosition() {
      const t = chapitres[courant]?.titre;
      position.textContent = chapitres.length
        ? `${t ? `${t} · ` : ''}${courant + 1} / ${chapitres.length} · ${dernierPourcent} %`
        : '';
    }

    /**
     * Demande un chapitre, sans le peindre.
     *
     * MEMOIRE BORNEE : on ne garde que le chapitre courant et ses voisins. Un livre de
     * 105 chapitres tout entier en memoire ne servirait a personne — on ne lit que dans
     * un sens, et rarement plus d'un chapitre d'avance.
     */
    function demander(n) {
      if (n < 0 || n >= chapitres.length) return null;
      if (!enAvance.has(n)) {
        enAvance.set(n, json(`${base}/chapitre/${n}${suffixe}`).catch(() => null));
      }
      for (const k of [...enAvance.keys()]) {
        if (Math.abs(k - courant) > 2) enAvance.delete(k);
      }
      return enAvance.get(n);
    }

    /**
     * L'ATTENTE SE DIT, ET ELLE SE COMPTE.
     *
     * Le serveur rapatrie le livre ENTIER avant de pouvoir en rendre le sommaire : sur un
     * epub de plusieurs dizaines de Mo cela demande de dix secondes a une minute, et la
     * page restait BLANCHE pendant tout ce temps. Rien ne distinguait « ca travaille » de
     * « c'est casse » — « c'est long et rien ne me dit qu'il est en train de se passer
     * quelque chose », signale a l'usage.
     *
     * UN COMPTEUR, PAS UN POURCENTAGE : on ne connait pas la taille du fichier avant de
     * l'avoir recu, et une barre qui avance au hasard ment. Les secondes, elles, sont
     * vraies. Elles n'apparaissent qu'apres trois secondes : sur un chapitre deja
     * precharge, l'affichage est instantane et un compteur ne ferait que clignoter.
     */
    function patienter(quoi) {
      const ligne = el('div', 'message patiente', quoi);
      const compte = el('span', 'patiente-temps', '');
      ligne.append(compte);
      page.replaceChildren(ligne);
      const depart = Date.now();
      const tic = setInterval(() => {
        const secondes = Math.round((Date.now() - depart) / 1000);
        compte.textContent = secondes >= 3 ? ` ${secondes} s` : '';
        // Dire la duree ATTENDUE une seule fois, quand elle commence a inquieter.
        if (secondes === 15) {
          ligne.append(el('div', 'vide', 'Un gros livre demande parfois une minute.'));
        }
      }, 1000);
      return () => clearInterval(tic);
    }

    async function afficher(n, pourcentDepart) {
      courant = Math.max(0, Math.min(n, chapitres.length - 1));
      const finAttente = patienter('chargement du chapitre…');
      precedent.disabled = courant === 0;
      suivant.disabled = courant >= chapitres.length - 1;
      try {
        const r = await demander(courant);
        finAttente();
        if (!r) throw new Error('chapitre indisponible');
        // Le HTML vient du serveur, deja debarrasse de tout ce qui execute.
        // Les images d'un chapitre passent par la meme route, qui a besoin des memes
        // parametres pour retrouver la release.
        page.innerHTML = suffixe
          ? r.html.replace(/(\/ressource\?f=[^"']*)/g, (u) => `${u}&${parametres}`)
          : r.html;
        page.scrollTop = 0;
        if (pourcentDepart > 0) {
          // Apres la peinture : avant, `scrollHeight` vaut encore zero.
          requestAnimationFrame(() => {
            const h = page.scrollHeight - page.clientHeight;
            page.scrollTop = h > 0 ? (h * pourcentDepart) / 100 : 0;
            surDefilement();
          });
        } else {
          dernierPourcent = 0;
          majPosition();
          envoyerPosition(false);
        }
        // LE SUIVANT, PENDANT QUE LE LECTEUR LIT CELUI-CI. C'est le seul moment ou une
        // requete ne coute rien : personne n'attend.
        demander(courant + 1);
      } catch (e) {
        finAttente();
        page.replaceChildren(el('div', 'message message--erreur', e.message));
      }
    }

    precedent.addEventListener('click', () => afficher(courant - 1, 0));
    suivant.addEventListener('click', () => afficher(courant + 1, 0));
    sommaire.addEventListener('click', () => { listeSommaire.hidden = !listeSommaire.hidden; });

    function partir() {
      fermerEnEnregistrant(() => envoyerPosition(false), () => {
        clearTimeout(minuteur);
        document.removeEventListener('keydown', surTouche);
        document.removeEventListener('visibilitychange', auMasquage);
        window.removeEventListener('pagehide', auDepart);
        fond.remove();
        document.body.classList.remove('sans-defilement-page');
      }, surFermeture);
    }
    fermer.addEventListener('click', partir);

    function surTouche(ev) {
      if (ev.key === 'Escape') { partir(); return; }
      if (ev.key === 'ArrowRight' && !suivant.disabled) afficher(courant + 1, 0);
      if (ev.key === 'ArrowLeft' && !precedent.disabled) afficher(courant - 1, 0);
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
      // Le sommaire est la LONGUE attente : c'est lui qui declenche le rapatriement.
      const finAttente = patienter('ouverture du livre… le fichier est rapatrie en entier avant sa premiere page');
      try {
        const s = await json(`${base}/sommaire${suffixe}`);
        finAttente();
        chapitres = s.chapitres || [];
        if (s.titre) nom.textContent = s.auteur ? `${s.titre} — ${s.auteur}` : s.titre;
        listeSommaire.replaceChildren(...chapitres.map((c) => {
          const b = el('button', 'discret', c.titre);
          b.addEventListener('click', () => { listeSommaire.hidden = true; afficher(c.index, 0); });
          return b;
        }));
        await afficher(reprise?.chapitre ?? 0, reprise?.pourcent ?? 0);
      } catch (e) {
        finAttente();
        page.replaceChildren(el('div', 'message message--erreur', e.message));
      }
    })();
  }

  window.Liseuse = { ouvrir };
}());
