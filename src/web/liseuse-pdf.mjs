// La liseuse PDF : la troisieme surface de lecture, apres la visionneuse et la liseuse EPUB.
//
// POURQUOI UNE DE PLUS. Un PDF n'est ni une archive de planches numerotees ni un flux de
// texte reflowable : c'est une suite de pages a dessiner, chacune a sa taille. La
// visionneuse afficherait une liste vide, la liseuse EPUB un fichier illisible.
//
// LE RENDU EST ICI, DANS LE NAVIGATEUR. Le serveur ne fait que relayer des octets par
// plages. Rasteriser cote serveur demanderait une bibliotheque native et de la memoire a
// chaque page, sur une machine qui a deja gele deux fois pour cette raison.
//
// pdf.js est un module ES : ce fichier en est un aussi, charge par `type="module"`.

import { getDocument, GlobalWorkerOptions } from '/pdfjs.mjs';

// Le worker DOIT venir de la meme version que le moteur : ils partagent un protocole
// interne qui n'est pas stable d'une version a l'autre.
GlobalWorkerOptions.workerSrc = '/pdfjs-worker.mjs';

const el = (balise, classe, texte) => {
  const e = document.createElement(balise);
  if (classe) e.className = classe;
  if (texte !== undefined) e.textContent = texte;
  return e;
};

function ouvrir({ hash, service, fichier, titre, oeuvre, titreOeuvre, couverture, famille, tome, reprise,
  surFermeture }) {
  // LA CLASSE EST CELLE DE LA VISIONNEUSE, ET C'EST DELIBERE. J'en avais invente une —
  // « surcouche-lecture » — qui n'existait dans aucune feuille de style : le div partait
  // sans position ni fond, ajoute en fin de page, donc INVISIBLE. Cliquer « Lire » ne
  // faisait alors « rien », sans la moindre erreur. Signale a l'usage.
  //
  // Les deux surfaces plein ecran doivent de toute facon se ressembler : le depot le dit
  // deja pour la liseuse EPUB — « deux surcouches qui ne se ressembleraient pas »
  // desorienteraient.
  const surcouche = el('div', 'visionneuse');
  const barre = el('div', 'lecteur-barre');
  const scene = el('div', 'liseuse-pdf-scene');
  const toile = el('canvas', 'liseuse-pdf-page');
  const etat = {
    doc: null,
    // La reprise arrive en index de planche, comme partout ailleurs ; pdf.js compte les
    // pages a partir de 1.
    page: Math.max(1, (Number(reprise) || 0) + 1),
    zoom: 1,
    rendant: false,
    ajustement: 'hauteur',
  };

  const jetonCsrf = () => {
    const m = document.cookie.match(/(?:^|;\s*)mangaloo-csrf=([^;]*)/);
    return m ? decodeURIComponent(m[1]) : '';
  };

  /**
   * La position, envoyee au serveur.
   *
   * SANS ELLE, LIRE N ENTRE PAS DANS LA BIBLIOTHEQUE. La visionneuse, la liseuse EPUB et
   * l'ecoute enregistrent toutes leur avancement ; celle-ci ne le faisait pas, et un
   * numero lu n'apparaissait nulle part ensuite. Signale a l'usage sur un Journal de
   * Spirou lu en entier.
   *
   * LE TOME EST CELUI DE L'APPELANT, jamais une identite inventee ici. Un PDF et un CBZ
   * de la meme release sont deux FICHIERS de cette release : leur donner deux identites
   * differentes ferait compter le meme tome deux fois sur l'etagere.
   */
  function corpsPosition() {
    if (!oeuvre && !titreOeuvre) return null;
    if (!etat.doc) return null;
    return {
      oeuvre: oeuvre || '',
      titre: titreOeuvre || titre || '',
      couverture: couverture || undefined,
      // LE RAYON, TRANSMIS COMME PAR LES TROIS AUTRES SURFACES. Il avait ete oublie ICI
      // seulement : un PDF de presse entrait donc toujours sans famille, et la
      // bibliotheque continuait d'afficher « tome » sur un journal apres le correctif.
      // Quatre lecteurs, trois corriges — la quatrieme est un module, et mon relever des
      // appels ne cherchait que `Liseuse|Visionneuse|Ecoute`.
      famille: famille || undefined,
      tome: tome || `f:${fichier || titre || ''}`,
      // L'index de la page, pas son numero : les planches sont comptees a partir de zero
      // partout ailleurs.
      planche: etat.page - 1,
      planches: Math.max(1, etat.doc.numPages),
      cleRelease: hash,
      titreRelease: titre || undefined,
      csrf: jetonCsrf(),
    };
  }

  /**
   * RENDRE LA PROMESSE, parce que la fermeture l'ATTEND.
   *
   * Elle ne rendait rien : l'etagere se rafraichissait pendant que la position partait
   * encore, relisait celle d'AVANT la lecture, et le numero qu'on venait de lire
   * n'apparaissait qu'apres un rechargement de page. Meme regle que dans les trois autres
   * surfaces, ou elle est ecrite depuis le 2026-08-27.
   */
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
    }
  }

  // Temporise : un envoi par tour de page serait bavard sans rien apporter de plus.
  let minuteurPosition = null;
  function noterPosition() {
    clearTimeout(minuteurPosition);
    minuteurPosition = setTimeout(() => envoyerPosition(false), 2000);
  }
  const AJUSTEMENTS = ['hauteur', 'largeur', 'originale'];

  const titreEl = el('span', 'liseuse-titre', titre || fichier || 'document');
  const compteur = el('span', 'liseuse-compteur', '…');
  const precedent = el('button', 'discret', '‹');
  const suivant = el('button', 'discret', '›');
  const moins = el('button', 'discret', '−');
  const plus = el('button', 'discret', '+');
  const fermer = el('button', 'discret', 'Fermer');

  const bAjustement = el('button', 'discret', '⤢');
  bAjustement.type = 'button';
  barre.append(titreEl, precedent, compteur, suivant, moins, plus, bAjustement, fermer);
  scene.append(toile);

  // LES MEMES GESTES QUE LA VISIONNEUSE. Un PDF se lit comme un album : on tape les bords,
  // on glisse, et l'appui au centre rappelle les commandes. Les avoir seulement sur une
  // des deux surfaces obligeait a changer d'habitude selon le format du fichier.
  const bord = (cote) => {
    const b = el('button', `bord bord--${cote}`);
    b.type = 'button';
    if (cote === 'centre') {
      b.setAttribute('aria-label', 'Afficher ou masquer les commandes');
      b.addEventListener('click', () => basculerChrome());
    } else {
      const avance = cote === 'droite';
      b.setAttribute('aria-label', avance ? 'Page suivante' : 'Page precedente');
      b.addEventListener('click', () => aller(etat.page + (avance ? 1 : -1)));
    }
    return b;
  };
  scene.append(bord('gauche'), bord('centre'), bord('droite'));

  // L'INDICATEUR RESTE QUAND LE MENU S'EFFACE, comme dans la visionneuse.
  const indicateur = el('div', 'indicateur-planche', '');
  surcouche.append(scene, indicateur, barre);
  const { montrer: montrerChrome, basculer: basculerChrome } = installerChrome(surcouche, barre);

  function retirer() {
    clearTimeout(minuteurPosition);
    window.removeEventListener('pagehide', auDepart);
    document.body.style.overflow = '';
    document.removeEventListener('keydown', auClavier);
    surcouche.remove();
    if (etat.doc) etat.doc.destroy();
  }

  /**
   * Fermer la surcouche alors que la PAGE RESTE.
   *
   * On peut attendre l'enregistrement, et il FAUT l'attendre : sans cela l'etagere se
   * rafraichissait sur la position d'avant, et il fallait recharger la page pour voir le
   * numero apparaitre. « j'ai du recharger la page pour le voir apparaitre apres
   * fermeture », signale a l'usage.
   *
   * `sendBeacon` reste pour `pagehide` — c'est le seul envoi qui survive a la disparition
   * de l'onglet, mais il ne s'attend pas.
   */
  function partir() {
    return fermerEnEnregistrant(() => envoyerPosition(false), retirer, surFermeture);
  }

  async function dessiner() {
    // UN SEUL RENDU A LA FOIS. pdf.js jette « Cannot use the same canvas during multiple
    // render() operations » si l'on enchaine, et l'utilisateur qui maintient la fleche
    // enchaine tres vite.
    if (!etat.doc || etat.rendant) return;
    etat.rendant = true;
    try {
      const page = await etat.doc.getPage(etat.page);
      // L'AJUSTEMENT SE CALCULE SUR LA PAGE, pas une fois pour toutes : un PDF melange les
      // formats — une double page, une couverture, un encart a l'italienne — et une
      // echelle figee les afficherait tantot minuscules, tantot debordantes.
      const brut = page.getViewport({ scale: 1 });
      const cadre = scene.getBoundingClientRect();
      let base = 1;
      if (etat.ajustement === 'largeur') base = (cadre.width - 32) / brut.width;
      else if (etat.ajustement === 'hauteur') {
        base = Math.min((cadre.width - 32) / brut.width, (cadre.height - 32) / brut.height);
      }
      const vue = page.getViewport({
        scale: Math.max(0.1, base * etat.zoom) * (window.devicePixelRatio || 1),
      });
      toile.width = Math.floor(vue.width);
      toile.height = Math.floor(vue.height);
      toile.style.width = `${Math.floor(vue.width / (window.devicePixelRatio || 1))}px`;
      await page.render({ canvasContext: toile.getContext('2d'), viewport: vue }).promise;
      compteur.textContent = `${etat.page} / ${etat.doc.numPages}`;
      indicateur.textContent = `${etat.page} / ${etat.doc.numPages}`;
      noterPosition();
    } catch (e) {
      compteur.textContent = e.message;
    } finally {
      etat.rendant = false;
    }
  }

  function aller(n) {
    if (!etat.doc) return;
    const cible = Math.min(Math.max(1, n), etat.doc.numPages);
    if (cible === etat.page) return;
    etat.page = cible;
    dessiner();
  }

  function auClavier(ev) {
    if (ev.key === 'Escape') { partir(); return; }
    if (ev.key === 'ArrowRight' || ev.key === 'PageDown') aller(etat.page + 1);
    if (ev.key === 'ArrowLeft' || ev.key === 'PageUp') aller(etat.page - 1);
  }

  precedent.addEventListener('click', () => aller(etat.page - 1));
  suivant.addEventListener('click', () => aller(etat.page + 1));
  moins.addEventListener('click', () => { etat.zoom = Math.max(0.5, etat.zoom - 0.25); dessiner(); montrerChrome(); });
  plus.addEventListener('click', () => { etat.zoom = Math.min(4, etat.zoom + 0.25); dessiner(); montrerChrome(); });
  bAjustement.addEventListener('click', () => {
    etat.ajustement = AJUSTEMENTS[(AJUSTEMENTS.indexOf(etat.ajustement) + 1) % AJUSTEMENTS.length];
    bAjustement.title = `Ajustement : ${etat.ajustement}`;
    bAjustement.setAttribute('aria-label', `Ajustement : ${etat.ajustement}`);
    dessiner();
    montrerChrome();
  });

  // LE BALAYAGE, PAR LE MEME MODULE QUE LA VISIONNEUSE. La decision — sens de lecture,
  // seuil relatif a la largeur, dominance horizontale, zoom qui deplace au lieu de tourner
  // — vit dans `geste.js`, ou elle est testee. La recopier ici l'aurait fait diverger.
  let depart = null;
  let avalerLeClic = false;
  scene.addEventListener('click', (ev) => {
    if (!avalerLeClic) return;
    avalerLeClic = false;
    ev.stopPropagation();
    ev.preventDefault();
  }, true);
  scene.addEventListener('pointerdown', (ev) => { depart = { x: ev.clientX, y: ev.clientY }; });
  scene.addEventListener('pointerup', (ev) => {
    if (!depart) return;
    const r = scene.getBoundingClientRect();
    const quoi = gesteDeBalayage({
      dx: ev.clientX - depart.x,
      dy: ev.clientY - depart.y,
      largeur: r.width,
      zoom: etat.zoom,
      mode: 'page-a-page',
      // Un PDF se lit toujours de gauche a droite : ce n'est pas un manga.
      sens: 'ltr',
    });
    depart = null;
    if (!quoi) return;
    avalerLeClic = true;
    aller(etat.page + (quoi === 'suivante' ? 1 : -1));
  });

  // La pose depend de la taille du cadre : elle se refait quand la fenetre change.
  window.addEventListener('resize', () => dessiner());
  fermer.addEventListener('click', partir);
  document.addEventListener('keydown', auClavier);

  const auDepart = () => envoyerPosition(true);
  window.addEventListener('pagehide', auDepart);
  document.body.style.overflow = 'hidden';
  document.body.append(surcouche);
  compteur.textContent = 'ouverture…';
  indicateur.textContent = '';
  montrerChrome();

  const params = new URLSearchParams({ service });
  if (fichier) params.set('fichier', fichier);
  const url = `/api/pdf/${encodeURIComponent(hash)}/fichier?${params.toString()}`;

  // `getDocument` demande des PLAGES a notre route : seules les pages regardees sont
  // reellement telechargees. Un magazine de trente megaoctets s'ouvre sur les quelques
  // dizaines de kilo-octets de sa premiere page.
  getDocument({ url, withCredentials: true }).promise
    .then((doc) => {
      etat.doc = doc;
      // La reprise peut depasser un document raccourci depuis la derniere lecture.
      etat.page = Math.min(Math.max(1, etat.page), doc.numPages);
      dessiner();
    })
    .catch((e) => { compteur.textContent = `ouverture impossible : ${e.message}`; });
}

window.LiseusePdf = { ouvrir };
