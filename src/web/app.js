// Mangaloo — script unique, servi tel quel. Aucun framework, aucun build.

const ETATS = {
  'en-cache': { libelle: 'en cache', classe: 'etat--en-cache' },
  absent: { libelle: 'pas en cache', classe: 'etat--absent' },
  // Le troisieme etat n'est pas un defaut d'affichage : c'est l'information exacte.
  // AllDebrid n'a aucune consultation en lecture seule, et le cache communautaire de
  // StremThru ne sait dire que « oui ». Afficher « pas en cache » ici serait un
  // mensonge.
  inconnu: { libelle: 'non verifie', classe: 'etat--inconnu' },
};

const ETATS_SOURCE = {
  repondu: (n) => `repondu (${n})`,
  vide: () => 'vide',
  echec: () => "n'a pas repondu",
  'cle-absente': () => 'cle absente',
};

// --- utilitaires ---------------------------------------------------------

function elem(balise, classe, texte) {
  const e = document.createElement(balise);
  if (classe) e.className = classe;
  if (texte !== undefined) e.textContent = texte;
  return e;
}

/**
 * L'oeuvre que la page regarde actuellement.
 *
 * Alimentee par la fiche MangaDex (uuid + couverture connus) ou par la recherche libre
 * (titre saisi seul). Tant qu'elle est nulle, on ne propose PAS de suivre : sans identite
 * formable, on creerait une oeuvre fantome dans la bibliotheque.
 *
 * La normalisation du titre en identite reste cote SERVEUR — deux clients qui la
 * feraient chacun de leur cote finiraient par diverger et creeraient deux oeuvres pour
 * un meme titre.
 */
let oeuvreCourante = null;

/**
 * Famille interrogee, lue dans l'URL.
 *
 * Absente, c'est « mangas » : les liens existants n'ont pas ce parametre, et les casser
 * rendrait la bibliotheque inutilisable le temps d'un deploiement.
 */
let familleCourante = 'mangas';
// Le catalogue qui sert la famille affichee. Sert a nommer le bon service quand il
// ne trouve rien : « MangaDex ne connait pas ce titre » etait faux des qu'on
// cherchait une BD, et le sera encore plus pour un livre.
let catalogueCourant = null;
const NOM_CATALOGUE = {
  mangadex: 'MangaDex', comicvine: 'ComicVine',
  openlibrary: 'Open Library', booknode: 'Booknode',
};

/** Faux pour l'audiobook : la visionneuse affiche des planches, pas du son. */
let familleLisible = true;

/** Ajoute la famille a une URL de route, ou qu'elle en soit dans ses parametres. */
function avecFamille(url) {
  return url + (url.includes('?') ? '&' : '?') + `famille=${encodeURIComponent(familleCourante)}`;
}

/**
 * Positions deja connues pour l'oeuvre regardee, indexees par identite de tome.
 *
 * Chargees une fois a l'ouverture de la page : sans elles, « reprendre » demanderait un
 * aller-retour au moment precis ou l'on veut que la planche s'affiche.
 */
let positionsConnues = new Map();

/** L'identite formee par le serveur au moment du suivi, ou rien si on ne suit pas. */
let identiteSuivie = null;

function oeuvreSuivie() {
  return identiteSuivie || '';
}

function repriseConnue(tomeId) {
  const p = positionsConnues.get(tomeId);
  return p ? p.planche : 0;
}

/**
 * La reprise d'un OUVRAGE — un livre lu ou ecoute.
 *
 * DEUX FORMES, ET LES CONFONDRE NE FAIT AUCUN BRUIT. `repriseConnue` rend un NOMBRE, ce
 * dont la visionneuse se contente : une planche. La liseuse et l'ecoute attendent un
 * objet, parce qu'un chapitre est un flux continu et qu'il faut dire ou l'on en est
 * DEDANS. Passer le nombre a l'ecoute laissait `reprise.chapitre` a `undefined` : la
 * lecture repartait du debut, sans la moindre erreur.
 */
function repriseOuvrage(tomeId) {
  const p = positionsConnues.get(tomeId);
  return { chapitre: p?.planche || 0, pourcent: p?.pourcent || 0 };
}

/**
 * Recupere l'identite et les positions de l'oeuvre regardee, si elle est deja suivie.
 *
 * Silencieux en cas d'echec : la bibliotheque est un confort, elle ne doit jamais
 * empecher de chercher ni de lire.
 */
async function chargerSuivi(titre, mangadexId) {
  identiteSuivie = null;
  positionsConnues = new Map();
  if (!titre) return;
  try {
    const { oeuvres } = await api('/api/bibliotheque');
    const attendue = mangadexId ? `md:${mangadexId}` : null;
    const trouvee = oeuvres.find((o) =>
      attendue ? o.oeuvre === attendue : o.titre.toLowerCase() === titre.toLowerCase());
    if (!trouvee) return;
    identiteSuivie = trouvee.oeuvre;
    for (const p of trouvee.positions) positionsConnues.set(p.tome, p);
  } catch {
    /* la bibliotheque est indisponible : on lit quand meme */
  }
}

/**
 * Les deux facons d'obtenir un fichier Telegram, dans l'ordre de leur cout.
 *
 * Le lien `t.me` d'abord : les octets vont du canal au client de l'utilisateur SANS
 * passer par ce serveur, et le fichier arrive intact. Le telechargement par Mangaloo
 * ensuite, pour qui n'a pas Telegram sous la main — il fait transiter le tome entier par
 * le nipogi, ce qui n'est pas rien pour 477 Mo.
 */
function sortiesTelegram(candidat) {
  const sorties = [];
  if (candidat.lienExterne) {
    const a = elem('a', 'bouton-lien', 'Ouvrir dans Telegram');
    a.href = candidat.lienExterne;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.title = 'Ouvre le message d origine. Le fichier ne transite pas par ce serveur.';
    sorties.push(a);
  }
  const t = elem('a', 'bouton-lien', 'Telecharger');
  t.href = `/api/telegram/telechargement/${encodeURIComponent(candidat.identite)}`
    + `?nom=${encodeURIComponent(candidat.titre)}`;
  t.setAttribute('download', candidat.titre);
  t.title = 'Passe par ce serveur. Preferez « Ouvrir dans Telegram » quand c est possible.';
  sorties.push(t);
  return sorties;
}

/**
 * Boutons d'un resultat Z-Library.
 *
 * Le telechargement REDIRIGE vers le CDN : les octets ne passent pas par ce serveur.
 * L'attribut `download` est donc sans effet une fois sur l'autre domaine — c'est le
 * CDN qui pose le nom de fichier, via son parametre `filename`.
 */
function boutonsZlibrary(candidat) {
  const sorties = [];
  if (candidat.lienExterne) {
    const a = elem('a', 'bouton-lien', 'Voir sur Z-Library');
    a.href = candidat.lienExterne;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    sorties.push(a);
  }
  const t = elem('a', 'bouton-lien', 'Telecharger');
  t.href = `/api/zlibrary/telechargement/${encodeURIComponent(candidat.identite)}`;
  t.title = 'Le fichier vient directement de Z-Library. Le quota quotidien est celui de votre compte.';
  sorties.push(t);
  return sorties;
}

function jetonCsrf() {
  const m = document.cookie.match(/(?:^|;\s*)mangaloo-csrf=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : '';
}

async function api(chemin, options = {}) {
  const reponse = await fetch(chemin, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF': jetonCsrf(),
      ...(options.headers || {}),
    },
  });
  if (reponse.status === 401) {
    location.href = '/login.html';
    throw new Error('connexion requise');
  }
  const corps = await reponse.json().catch(() => ({}));
  if (!reponse.ok) {
    const erreur = new Error(corps.erreur || `erreur ${reponse.status}`);
    // Le code permet a l'appelant de traiter un cas precis — « sans-torrent » — plutot
    // que d'afficher un message d'echec sur une situation qui a une suite.
    erreur.code = corps.code;
    erreur.statut = reponse.status;
    throw erreur;
  }
  return corps;
}

function poids(octets) {
  if (!octets) return '—';
  const go = octets / 1e9;
  return go >= 1 ? `${go.toFixed(1)} Go` : `${Math.round(octets / 1e6)} Mo`;
}

function libelleTomes(tomes) {
  if (!tomes) return null;
  if (tomes.integrale) return 'integrale';
  if (tomes.fin) return `T${tomes.debut}–T${tomes.fin}`;
  return `T${tomes.debut}`;
}

function afficherErreur(cible, message) {
  cible.replaceChildren(elem('div', 'message message--erreur', message));
}

// --- indicateurs d'etat --------------------------------------------------

function indicateur(service, etat) {
  const def = ETATS[etat] || ETATS.inconnu;
  const ligne = elem('span', `etat ${def.classe}`);
  ligne.append(elem('span', 'pastille'));
  ligne.append(elem('span', null, `${service} ${def.libelle}`));
  ligne.title = `${service} : ${def.libelle}`;
  return ligne;
}

// --- la tranche : un dos de livre par tome -------------------------------

/**
 * Rangee de dos de livres pour un pack.
 *
 * C'est ce que rien d'autre ne montre : quels tomes sont REELLEMENT dans l'archive.
 * Une plage annoncee « T01-T105 » avec un trou au 44 se voit ici d'un coup d'oeil,
 * alors que le nom de la release, lui, ne le dira jamais.
 */
/**
 * La tranche : un dos de livre par tome.
 *
 * C'est ce que rien d'autre ne montre : quels tomes sont REELLEMENT dans l'archive.
 * Une plage annoncee « T01-T105 » avec un trou au 44 se voit ici d'un coup d'oeil,
 * alors que le nom de la release, lui, ne le dira jamais.
 *
 * Elle NAVIGUE, elle ne selectionne pas. Cliquer un dos amene a la ligne du tome ;
 * decocher se fait dans la case du tableau, la ou on l'attend.
 */
function tranche(structure, surClic) {
  const numeros = structure.fichiers.filter((f) => f.tome !== undefined).map((f) => f.tome);
  if (numeros.length === 0) return null;

  const min = Math.min(...numeros);
  const max = Math.max(...numeros);
  const presents = new Set(numeros);

  const rangee = elem('div', 'tranche');
  rangee.setAttribute('role', 'group');
  rangee.setAttribute('aria-label', `Tomes ${min} a ${max}`);

  for (let t = min; t <= max; t++) {
    const dos = elem('button', 'dos');
    dos.type = 'button';
    dos.dataset.present = presents.has(t) ? 'oui' : 'non';
    dos.dataset.tome = String(t);
    dos.setAttribute(
      'aria-label',
      presents.has(t) ? `Aller au tome ${t}` : `Tome ${t} absent de cette release`,
    );
    if (presents.has(t)) {
      dos.setAttribute('aria-pressed', 'true');
      dos.addEventListener('click', () => surClic(t));
    } else {
      dos.disabled = true;
    }
    rangee.append(dos);
  }

  const bloc = elem('div');
  bloc.append(rangee);
  const legende = elem('div', 'tranche-legende');
  legende.append(elem('span', null, `${presents.size} tomes, de ${min} a ${max}`));
  const manquants = max - min + 1 - presents.size;
  if (manquants > 0) legende.append(elem('span', null, `${manquants} manquant${manquants > 1 ? 's' : ''}`));
  legende.append(elem('span', null, 'cliquez un dos pour aller au tome'));
  bloc.append(legende);
  return { bloc };
}

// --- rendu d'une release -------------------------------------------------

function carteRelease(candidat, etats, colonnes) {
  const carte = elem('div', 'release');

  const colonneEtats = elem('div', 'etats');
  // Les etats de cache arrivent APRES la liste : on garde de quoi les poser en place
  // sans tout reconstruire, pour ne pas refermer un panneau deja ouvert.
  // On garde la REFERENCE : l'action d'ecoute s'y accrochera plus bas, pour etre
  // rejouee quand les etats de cache arriveront.
  const entreeColonne = candidat.hash && colonnes
    ? { hash: candidat.hash, colonneEtats, majActions: null }
    : null;
  if (entreeColonne) colonnes.push(entreeColonne);
  // QUATRE NATURES, ET UNE SEULE PAR CANDIDAT. Le pipeline melange des choses qui n'ont
  // en commun que l'absence de hash, et les confondre a coute trois defauts signales a
  // l'usage.
  //
  //   Telegram    — le fichier est dans un canal indexe. Aucun debrideur, aucun etat de
  //                 cache a verifier : on SAIT qu'il est la.
  //   Z-Library   — pareil, le fichier est chez eux.
  //   sans empreinte — un TORRENT dont Gemini ne publie pas le hash. Il faudra le
  //                 calculer avant de pouvoir interroger un debrideur.
  //   lien direct — un fichier chez un hebergeur, dont la disponibilite ne se decouvre
  //                 qu'a l'ouverture.
  //
  // Les trois premieres ont ete prises pour la quatrieme, tour a tour : « ouvrir pour
  // voir » suivi de « hash invalide » sur un torrent Gemini, et « lien direct » affiche
  // a cote de « empreinte a calculer » puis sur une carte Z-Library.
  const identite = typeof candidat.identite === 'string' ? candidat.identite : '';
  const estTelegram = identite.startsWith('tg:');
  const estZlibrary = identite.startsWith('zl:');
  // `!candidat.hash` EN PREMIER : une release peut porter les deux le temps qu'un ancien
  // onglet vive, et c'est l'empreinte qui fait foi.
  const sansEmpreinte = !candidat.hash && identite.startsWith('u3d:');
  const estDirect = !candidat.hash && Boolean(identite)
    && !estTelegram && !estZlibrary && !sansEmpreinte;
  const hash = candidat.hash;

  if (estTelegram || estZlibrary) {
    const info = elem('span', 'etat etat--present');
    info.append(elem('span', 'pastille'));
    info.append(elem('span', null, 'disponible'));
    info.title = estZlibrary
      ? 'Fichier disponible chez Z-Library : aucun debrideur n intervient'
      : 'Fichier present dans un canal Telegram indexe : aucun debrideur n intervient';
    colonneEtats.append(info);
  } else if (estDirect) {
    const info = elem('span', 'etat etat--inconnu');
    info.append(elem('span', 'pastille'));
    info.append(elem('span', null, 'ouvrir pour voir'));
    info.title = "Lien direct : la disponibilite depend de l'hebergeur, pas du cache";
    colonneEtats.append(info);
  } else if (sansEmpreinte) {
    // On NE SAIT PAS, et on le dit. Sans empreinte, aucune des deux colonnes ne peut
    // etre renseignee — ce n'est pas « pas en cache ».
    const info = elem('span', 'etat etat--inconnu');
    info.append(elem('span', 'pastille'));
    info.append(elem('span', null, 'empreinte a calculer'));
    info.title = 'Gemini ne publie pas l empreinte. Sans elle, aucun debrideur ne peut '
      + 'etre interroge.';
    colonneEtats.append(info);
  } else {
    colonneEtats.append(indicateur('AD', hash ? etats.alldebrid[hash] : 'inconnu'));
    colonneEtats.append(indicateur('TB', hash ? etats.torbox[hash] : 'inconnu'));
  }
  carte.append(colonneEtats);

  const centre = elem('div');
  centre.append(elem('div', 'nom', candidat.titre));
  // L'EDITION, SOUS LE TITRE ET PAS DEDANS. Trente resultats « Holly » tous en epub ne se
  // distinguent ni par le titre ni par le format ; « Albin Michel · 2023 · 449 p. » et
  // « De Saxus · 2025 · 143 p. », si. Ces informations avaient d'abord ete collees au
  // titre : le rapprochement le note, et le score tombait sous le seuil.
  if (candidat.edition) centre.append(elem('div', 'edition', candidat.edition));
  // LA PROVENANCE, QUAND ELLE EST DITE. Convention Tr4ker : RETAiL est un ebook issu
  // d'une source officielle, SCAN vient d'un livre papier passe au scanner, HYBRiD melange
  // les deux. Ca ne filtre rien — ca departage deux editions du meme livre, la ou le
  // titre, le format et la taille se ressemblent.
  //
  // Environ la moitie des releases ne suivent aucune convention (mesure sur 226 noms) :
  // l'absence de mention ne veut donc pas dire « mauvaise qualite », elle ne veut rien
  // dire du tout. C'est pourquoi rien ne s'affiche alors.
  if (candidat.provenance) {
    const LIBELLES = {
      retail: ['officiel', 'Ebook issu d une source officielle propre'],
      scan: ['scan', 'Cree a partir d un livre papier scanne'],
      hybride: ['hybride', 'Melange de plusieurs sources'],
    };
    const [texte, aide] = LIBELLES[candidat.provenance];
    const p = elem('span', `provenance provenance--${candidat.provenance}`, texte);
    p.title = aide;
    centre.append(p);
  }
  // Zone dediee aux messages de verification : sans elle, verifier apres avoir ouvert
  // effacait la liste des tomes et les boutons.
  const messages = elem('div');

  const puces = elem('div', 'puces');
  const tomes = libelleTomes(candidat.tomes);
  if (tomes) puces.append(elem('span', 'puce', tomes));
  if (candidat.langue && candidat.langue !== 'inconnue') puces.append(elem('span', 'puce', candidat.langue));
  if (candidat.format && candidat.format !== 'inconnu') puces.append(elem('span', 'puce', candidat.format));
  // La duree ne s'affiche que sur un enregistrement : « ≈ 17 h » a cote d'un epub
  // n'aurait aucun sens, et un nom d'epub peut porter un debit quand la release contient
  // aussi sa lecture.
  if (candidat.format === 'audio') {
    const duree = dureeEstimee(candidat.titre, candidat.taille);
    if (duree) puces.append(elem('span', 'puce', duree));
  }
  if (estDirect) {
    // Sans cette puce, la colonne d'etat voudrait dire deux choses sans le dire :
    // « en cache » pour un torrent, « hebergeur utilisable » pour un lien direct.
    //
    // `estDirect` EXCLUT DEJA Telegram, Z-Library et les torrents sans empreinte. Aucun
    // des trois n'est un lien direct : il n'y a ni hebergeur ni disponibilite a
    // decouvrir. La condition etait ecrite en clair ici, et un torrent Gemini dont
    // l'empreinte restait a calculer s'affichait « lien direct » a cote de « empreinte a
    // calculer » — deux etiquettes qui se contredisent, signale a l'usage.
    puces.append(elem('span', 'puce pack', 'lien direct'));
  }
  const puceSource = elem('span', 'puce', candidat.source);
  puceSource.dataset.origine = '1';
  puces.append(puceSource);
  for (const autre of candidat.aussiSur || []) {
    const p = elem('span', 'puce', `aussi ${autre}`);
    p.dataset.origine = '1';
    puces.append(p);
  }
  if (candidat.nbFichiers > 1) puces.append(elem('span', 'puce pack', `pack · ${candidat.nbFichiers} fichiers`));
  centre.append(puces);

  const zone = elem('div');
  centre.append(messages, zone);

  const actions = elem('div', 'puces');
  if (!sansEmpreinte && (hash || candidat.identite)) {
    if (!familleLisible) {
      // Un livre audio ne se lit pas dans la visionneuse : elle affiche des planches. Le
      // dire vaut mieux qu'un bouton qui ouvrirait une surcouche vide, et aucun
      // avancement en planches n'est enregistre pour cette famille.
      actions.append(elem('span', 'puce', 'pas de lecture en ligne'));
      if (estTelegram) actions.append(...sortiesTelegram(candidat));
      else if (estZlibrary) actions.append(...boutonsZlibrary(candidat));
    } else if (estZlibrary && candidat.format === 'epub') {
      // LA LISEUSE, PAS LA VISIONNEUSE. Un EPUB est un flux de texte : la visionneuse
      // affiche des planches numerotees et n'a rien a en faire.
      //
      // Le livre est rapatrie ENTIER — le CDN de Z-Library n'honore que les plages
      // suffixes, mesure du 2026-08-24 — mais l'EPUB median pese 1,4 Mo : c'est un
      // aller-retour d'une seconde, et il est mis en cache pour ne pas redepenser une
      // unite du quota quotidien au chapitre suivant.
      const lire = elem('button', 'principal', 'Lire');
      lire.addEventListener('click', () => {
        window.Liseuse.ouvrir({
          identite: candidat.identite,
          titre: candidat.titre,
          oeuvre: oeuvreSuivie(),
          titreOeuvre: oeuvreCourante?.titre,
            famille: familleCourante,
          couverture: oeuvreCourante?.couverture,
        });
      });
      actions.append(lire);
      actions.append(...boutonsZlibrary(candidat));
    } else if (estZlibrary) {
      // Les autres formats restent hors de portee, et on le DIT. Mesure sur 192
      // resultats francais : 48 % de pdf, 11 % de mobi. Le pdf demande un moteur de
      // rendu qui n'a rien de commun avec ce qui existe ici.
      const raison = elem('span', 'puce', `${candidat.format} — la lecture en ligne lit les epub`);
      actions.append(raison);
      actions.append(...boutonsZlibrary(candidat));
    } else if (estTelegram && candidat.format === 'epub') {
      // MEME LISEUSE QUE Z-LIBRARY, et par le meme chemin — mais SANS rapatriement : la
      // facade Telegram accepte les plages d'octets, donc le livre se lit a distance,
      // entree par entree. C'est deja ce qui permet a la visionneuse d'ouvrir un CBZ de
      // 500 Mo sans rien telecharger.
      const lire = elem('button', 'principal', 'Lire');
      lire.addEventListener('click', () => {
        window.Liseuse.ouvrir({
          identite: candidat.identite,
          titre: candidat.titre,
          oeuvre: oeuvreSuivie(),
          titreOeuvre: oeuvreCourante?.titre,
            famille: familleCourante,
          couverture: oeuvreCourante?.couverture,
        });
      });
      actions.append(lire);
      actions.append(...sortiesTelegram(candidat));
    } else if (estTelegram && !lisibleEnLigne(candidat.format)) {
      // Pas de bouton du tout : 80,9 % de l'index Telegram est en `.cbr`, que le lecteur
      // par plages ne sait pas ouvrir. Proposer « Lire » ferait patienter puis echouer
      // sur « aucune fin de repertoire central ». La release reste VISIBLE — savoir
      // qu'elle existe a de la valeur — mais on dit ce qu'on ne sait pas en faire.
      const raison = elem('span', 'puce', raisonNonLisible(candidat.format));
      raison.title = 'Le lecteur ouvre les archives ZIP par plages d octets. Un RAR range '
        + 'ses en-tetes autrement, et le parcourir couterait environ une seconde par planche.';
      actions.append(raison);
      actions.append(...sortiesTelegram(candidat));
    } else if (estTelegram) {
      // Un message Telegram porte UN fichier : il n'y a rien a lister, donc pas d'etape
      // « Ouvrir ». Elle appelait `/api/release/<cle>/fichiers`, qui ne connait que les
      // hashs et les liens directs, et repondait « hash invalide ».
      const lire = elem('button', 'principal', 'Lire');
      lire.addEventListener('click', () => {
        window.Visionneuse.ouvrir({
          hash: candidat.identite,
          service: 'telegram',
          fichier: candidat.titre,
          titre: candidat.titre,
          oeuvre: oeuvreSuivie(),
          tome: `f:${candidat.titre}`,
          reprise: repriseConnue(`f:${candidat.titre}`),
          titreOeuvre: oeuvreCourante?.titre,
            famille: familleCourante,
          mangadexId: oeuvreCourante?.mangadexId,
          couverture: oeuvreCourante?.couverture,
        });
      });
      actions.append(lire);
      actions.append(...sortiesTelegram(candidat));
    } else {
      // UN LIVRE AUDIO S'ECOUTE DEPUIS LA CARTE. Le bouton n'existait que dans le
      // panneau des fichiers, donc invisible tant qu'on n'ouvrait pas la release — et la
      // carte annoncait « pas de lecture en ligne » juste au-dessus, ce qui dissuadait
      // precisement de l'ouvrir. Signale a l'usage : « ok mais je lis comment ? ».
      if (candidat.format === 'audio' && hash) {
        const boite = elem('span');
        // LES ETATS DE CACHE ARRIVENT APRES LA CARTE. Sans ce rappel, le bouton ne
        // paraitrait jamais : au premier rendu, aucun service n'est encore annonce.
        const majEcoute = () => {
          const enCache = ['alldebrid', 'torbox']
            .find((nom) => etats?.[nom]?.[hash] === 'en-cache');
          boite.replaceChildren();
          // Pas de bouton sans garantie : « Ecouter » n'apparait que si un service
          // annonce la release en cache, comme « Lire » ailleurs.
          if (!enCache) return;
          const ecouter = elem('button', 'principal', 'Ecouter');
          ecouter.addEventListener('click', () => {
            window.Ecoute.ouvrir({
              identite: hash,
              service: enCache,
              titre: candidat.titre,
              oeuvre: oeuvreSuivie(),
              titreOeuvre: oeuvreCourante?.titre,
            famille: familleCourante,
              couverture: oeuvreCourante?.couverture,
              reprise: repriseOuvrage(`audio:${hash}`),
            });
          });
          boite.append(ecouter);
        };
        majEcoute();
        if (entreeColonne) entreeColonne.majActions = majEcoute;
        actions.append(boite);
      }
      const ouvrir = elem('button', 'discret', 'Ouvrir');
      ouvrir.addEventListener('click', () => {
        // La liste des tomes part dans SA propre surface. Dans la carte, elle poussait la
        // page sans retour possible, et plusieurs releases ouvertes s'empilaient.
        const p = window.Panneau.ouvrir({
          titre: candidat.titre,
          sousTitre: [candidat.source, poids(candidat.taille), libelleTomes(candidat.tomes)]
            .filter(Boolean).join(' · '),
        });
        ouvrirRelease(candidat, p.corps, ouvrir, etats);
      });
      actions.append(ouvrir);
    }

    // Le favori porte sur l'OEUVRE ; cette release n'est memorisee que comme raccourci
    // d'acces, et sera remplacee le jour ou elle ne repondra plus. Le libelle le dit,
    // sans quoi il promettrait une permanence que le modele ne tient pas.
    if (oeuvreCourante) {
      const suivre = elem('button', 'discret', 'Suivre cette oeuvre');
      suivre.addEventListener('click', async () => {
        suivre.disabled = true;
        try {
          await api('/api/bibliotheque/suivre', {
            method: 'POST',
            body: JSON.stringify({
              mangadexId: oeuvreCourante.mangadexId,
              titre: oeuvreCourante.titre,
              couverture: oeuvreCourante.couverture,
              cleRelease: hash || candidat.identite,
              titreRelease: candidat.titre,
              source: candidat.source,
              famille: familleCourante,
            }),
          });
          suivre.textContent = 'Suivie';
        } catch (err) {
          suivre.disabled = false;
          messages.replaceChildren(elem('div', 'vide', `impossible de suivre : ${err.message}`));
        }
      });
      actions.append(suivre);
    }

    // La verification de cache n'a de sens que pour un TORRENT. Une release en lien
    // direct n'est pas « en cache » chez un debrideur : sa disponibilite depend de
    // l'hebergeur, et se decouvre en ouvrant la fiche.
    if (hash) {
      // Chaque bouton dit ce qu'il fait, et les deux ne font PAS la meme chose : chez
      // AllDebrid, verifier DEPOSE le magnet — le cacher derriere un libelle neutre
      // serait agir a l'insu de l'utilisateur. Chez TorBox, c'est une consultation qui
      // ne touche a rien, et lui coller le meme avertissement mentirait dans l'autre sens.
      const LIBELLES_VERIF = {
        alldebrid: 'Verifier sur AllDebrid (depose le magnet une seconde)',
        torbox: 'Verifier sur TorBox',
      };
      for (const service of ['alldebrid', 'torbox']) {
        const b = elem('button', 'discret', LIBELLES_VERIF[service]);
        b.addEventListener('click', () =>
          verifier(candidat, service, messages, zone, b, colonneEtats, etats, LIBELLES_VERIF[service]));
        actions.append(b);
      }
    }
  } else if (sansEmpreinte) {
    // UNE RELEASE SANS EMPREINTE N'EST PAS UNE IMPASSE. Gemini ne publie ni hash ni
    // magnet : il faut telecharger le .torrent pour le calculer. Le faire pour tous
    // couterait des secondes a chaque recherche — et le tracker limite durement le debit
    // des qu'on parallelise (mesure : 0 sur 40 en lots de six). Une a la fois, quand
    // c'est demande, ne declenche rien.
    const b = elem('button', 'discret', 'Obtenir l empreinte');
    b.title = 'Telecharge le fichier .torrent pour en calculer l empreinte. Sans effet sur '
      + 'votre ratio : seuls les octets annonces par un client comptent.';
    b.addEventListener('click', async () => {
      b.disabled = true;
      b.textContent = 'calcul…';
      try {
        const r = await api('/api/empreinte', {
          method: 'POST', body: JSON.stringify({ identite: candidat.identite }),
        });
        // La carte se reconstruit avec son empreinte : les colonnes de cache et les
        // boutons de verification apparaissent alors d'eux-memes.
        candidat.hash = r.hash;
        const neuve = carteRelease(candidat, etats, colonnes);
        neuve.dataset.rang = carte.dataset.rang;
        carte.replaceWith(neuve);
      } catch (e) {
        b.disabled = false;
        b.textContent = 'Obtenir l empreinte';
        messages.replaceChildren(elem('div', 'message message--erreur', e.message));
      }
    });
    actions.append(b);
  } else {
    actions.append(elem('span', 'puce', 'sans empreinte : non verifiable'));
  }
  centre.append(actions);
  carte.append(centre);

  const mesures = elem('div', 'mesures');
  const ligneSeeders = elem('div', null, `${candidat.seeders ?? '?'} seed`);
  mesures.append(elem('div', null, poids(candidat.taille)), ligneSeeders);
  carte.append(mesures);

  /**
   * Met a jour la ligne quand la meme release revient d'un second tracker.
   *
   * On retouche les deux elements concernes plutot que de reconstruire la carte :
   * remplacer l'element detruirait un panneau de tomes deja ouvert.
   */
  carte.majFusion = (f) => {
    candidat.seeders = f.seeders;
    candidat.source = f.source;
    candidat.aussiSur = f.aussiSur;
    ligneSeeders.textContent = `${f.seeders ?? '?'} seed`;
    for (const vieille of puces.querySelectorAll('[data-origine]')) vieille.remove();
    const source = elem('span', 'puce', f.source);
    source.dataset.origine = '1';
    puces.append(source);
    for (const autre of f.aussiSur) {
      const p = elem('span', 'puce', `aussi ${autre}`);
      p.dataset.origine = '1';
      puces.append(p);
    }
  };

  return carte;
}

async function verifier(candidat, service, messages, zone, bouton, colonneEtats, etats, libelle) {
  bouton.disabled = true;
  bouton.textContent = 'verification…';
  try {
    const r = await api('/api/debrid/verifier', {
      method: 'POST',
      body: JSON.stringify({ hash: candidat.hash, service }),
    });
    etats[service][candidat.hash] = r.etat;
    colonneEtats.replaceChildren(
      indicateur('AD', etats.alldebrid[candidat.hash] || 'inconnu'),
      indicateur('TB', etats.torbox[candidat.hash] || 'inconnu'),
    );
    // Le resultat du RETRAIT est affiche, pas seulement l'etat du cache : c'est la
    // seule operation qui touche le compte de l'utilisateur.
    const classe = r.retire === false ? 'message message--erreur' : 'message';
    messages.replaceChildren(elem('div', classe, r.message));
    // L'etat vient de changer : le panneau deja ouvert doit refaire ses boutons, sinon
    // « Lire » n'apparaitrait jamais dans l'ordre naturel — ouvrir, puis verifier.
    zone.majActions?.();
  } catch (e) {
    afficherErreur(messages, e.message);
  } finally {
    bouton.disabled = false;
    bouton.textContent = libelle;
  }
}

/**
 * Depose la release chez le debrideur, et le DIT sans rien promettre de plus.
 *
 * Un torrent non cache met des minutes a descendre : annoncer « pret » serait faux, et
 * demander des liens dans la foulee rendrait une liste vide qui passerait pour un echec.
 */
async function deposerRelease(candidat, service, sortie, bouton) {
  bouton.disabled = true;
  const libelle = bouton.textContent;
  bouton.textContent = 'depot en cours…';
  try {
    await api('/api/debrid/deposer', {
      method: 'POST',
      body: JSON.stringify({ hash: candidat.hash, service }),
    });
    sortie.replaceChildren(elem('div', 'message',
      `Depose chez ${service}. Le telechargement est en cours de leur cote — il peut `
      + 'prendre plusieurs minutes. Revenez verifier le cache pour lire ou telecharger.'));
  } catch (e) {
    bouton.disabled = false;
    bouton.textContent = libelle;
    afficherErreur(sortie, e.message);
  }
}

async function ouvrirRelease(candidat, zone, bouton, etats) {
  bouton.disabled = true;
  // Le message dit ce qu'on fait VRAIMENT : un torrent se decode depuis son .torrent,
  // une release en lien direct s'ouvre depuis sa fiche.
  zone.replaceChildren(elem('div', 'vide',
    candidat.hash ? 'lecture du .torrent…' : 'ouverture de la fiche et sondage de l archive…'));
  try {
    let structure;
    try {
      structure = await api(`/api/release/${encodeURIComponent(candidat.hash || candidat.identite)}/fichiers`);
    } catch (err) {
      if (err.code !== 'sans-torrent') throw err;
      // La source ne publie qu'un magnet (Knaben). Connaitre les fichiers exige de
      // deposer chez un debrideur : c'est un geste, pas un chargement, donc on le
      // demande explicitement au lieu de le faire dans le dos de l'utilisateur.
      zone.replaceChildren();
      zone.append(elem('div', 'message',
        'Cette source ne fournit pas de fichier .torrent, seulement un magnet. '
        + 'Lister les fichiers impose de deposer la release chez un debrideur.'));
      const choix = elem('div', 'puces');
      for (const service of ['alldebrid', 'torbox']) {
        const b = elem('button', 'discret', `Lister via ${service} (depose la release)`);
        b.addEventListener('click', async () => {
          b.disabled = true;
          try {
            const s = await api(`/api/release/${candidat.hash}/fichiers-debrid`, {
              method: 'POST', body: JSON.stringify({ service }),
            });
            zone.replaceChildren();
            rendreStructure(candidat, s, zone, etats);
          } catch (e2) {
            afficherErreur(zone, e2.message);
          } finally {
            b.disabled = false;
          }
        });
        choix.append(b);
      }
      zone.append(choix);
      return;
    }
    zone.replaceChildren();

    if (structure.type === 'hebergeurs') {
      rendreHebergeurs(candidat, structure, zone);
      return;
    }
    rendreStructure(candidat, structure, zone, etats);
  } catch (e) {
    afficherErreur(zone, e.message);
  } finally {
    bouton.disabled = false;
  }
}

function rendreStructure(candidat, structure, zone, etatsCache = { alldebrid: {}, torbox: {} }) {
  zone.replaceChildren();

  const etatDe = (s) => etatsCache?.[s]?.[candidat.hash] ?? 'inconnu';

  /** Tous les tomes que porte cette release, dans l'ordre du .torrent. */
  const tomesDuPack = () =>
    (structure.fichiers || []).filter((f) => f.estBd).map((f) => f.tomeId);

  /** Le tome qui suit, ou rien. La visionneuse ne le deduit jamais elle-meme. */
  function suivantDe(tomeId) {
    const ordre = tomesDuPack();
    const i = ordre.indexOf(tomeId);
    if (i < 0 || i + 1 >= ordre.length) return null;
    const suivant = ordre[i + 1];
    return { tome: suivant, libelle: suivant.startsWith('t') ? `T${suivant.slice(1)}` : suivant };
  }

  /** Enchaine sur un autre tome du MEME panneau, sans repasser par la liste. */
  function ouvrirTomeDuPanneau(tomeId) {
    const f = (structure.fichiers || []).find((x) => x.tomeId === tomeId);
    if (!f) return;
    const ligne = lignesParTome.get(f.tome);
    const bouton = ligne?.querySelector('button.principal');
    if (bouton) bouton.click();
  }

  // Verification AUTOMATIQUE a l'ouverture.
  //
  // Avant, ouvrir une release non verifiee n'affichait ni « Lire » ni « Telecharger », et
  // renvoyait vers un bouton « Verifier » a cliquer soi-meme. Or ouvrir EST le geste
  // explicite : c'est le moment de savoir.
  //
  // Chez TorBox c'est une consultation, elle ne coute rien. Chez AllDebrid elle DEPOSE le
  // magnet une seconde avant de le retirer — on le dit pendant que ca se passe, plutot
  // que de le faire en silence.
  let verificationEnCours = null;

  async function assurerEtat() {
    if (!candidat.hash || etatDe(service) !== 'inconnu' || verificationEnCours) return;
    verificationEnCours = service;
    majPied();
    try {
      const r = await api('/api/debrid/verifier', {
        method: 'POST',
        body: JSON.stringify({ hash: candidat.hash, service }),
      });
      etatsCache[service] = etatsCache[service] || {};
      etatsCache[service][candidat.hash] = r.etat;
    } catch {
      // On reste en « inconnu » : c'est exact, et l'interface le dira comme tel.
    } finally {
      verificationEnCours = null;
      majTableau();
      majPied();
    }
  }
  // Le service est choisi UNE FOIS, en haut. Le porter sur chaque ligne donnerait
  // quatre boutons par tome — lire/telecharger x AllDebrid/TorBox — et rendrait un
  // tableau de quatre-vingts lignes illisible. Le choix reste explicite, il est
  // simplement fait une fois.
  let service = ['torbox', 'alldebrid'].find((s) => etatDe(s) === 'en-cache') || 'alldebrid';

  const choix = elem('div', 'choix-service');
  const corps = elem('div');
  const sortie = elem('div');
  zone.append(choix, corps, sortie);

  // LE CONTENU, ET PAS SEULEMENT LA BANDE DESSINEE. Un .mp3 ne passait pas `estBd` :
  // les vingt-huit pistes d'un livre audio arrivaient donc DECOCHEES et repliees
  // derriere « 28 fichier(s) annexe(s) ». Signale a l'usage : « si je veux telecharger
  // je dois selectionner toutes les pistes ? ».
  //
  // `estBd` reste ce qu'il est — ce qui compte comme un TOME — et c'est lui seul qui
  // nourrit l'etagere de la bibliotheque. Melanger les deux y aurait pose vingt-huit
  // faux tomes pour un seul livre.
  const contenu = structure.fichiers.filter((f) => f.estBd || f.estPiste);
  const annexes = structure.fichiers.filter((f) => !f.estBd && !f.estPiste);
  // Les cases servent UNIQUEMENT au telechargement groupe. Lire est un choix unique,
  // et le faire passer par la selection obligeait a decocher soixante-dix-neuf tomes
  // pour en ouvrir un.
  const cochees = new Set(contenu.map((f) => f.chemin));
  const lignesParTome = new Map();

  function majChoixService() {
    choix.replaceChildren();
    for (const s of ['alldebrid', 'torbox']) {
      const def = ETATS[etatDe(s)] || ETATS.inconnu;
      const b = elem('button', 'discret', `${s} — ${def.libelle}`);
      b.setAttribute('aria-pressed', String(s === service));
      b.addEventListener('click', () => {
        service = s;
        majChoixService();
        majTableau();
        // L'etat du service qu'on vient de choisir est peut-etre inconnu : on le
        // demande, plutot que d'afficher un panneau muet.
        assurerEtat();
      });
      choix.append(b);
    }
  }

  function ligneTome(f) {
    const tr = elem('tr');
    if (f.tome !== undefined) lignesParTome.set(f.tome, tr);

    const tdCoche = elem('td');
    const coche = elem('input');
    coche.type = 'checkbox';
    coche.checked = cochees.has(f.chemin);
    coche.setAttribute('aria-label', `Inclure ${f.chemin} dans la selection`);
    coche.addEventListener('change', () => {
      if (coche.checked) cochees.add(f.chemin); else cochees.delete(f.chemin);
      majPied();
    });
    tdCoche.append(coche);

    const tdTome = elem('td', 'col-tome', f.tome !== undefined ? `T${f.tome}` : '—');
    const tdNom = elem('td', 'col-nom', f.chemin.split('/').pop());
    const tdTaille = elem('td', 'col-taille', poids(f.taille));

    const tdActions = elem('td', 'col-actions');
    // « Lire » n'apparait que si le service choisi annonce la release en cache : la
    // garantie du serveur, rendue visible.
    if (etatDe(service) === 'en-cache') {
      const lire = elem('button', 'principal', 'Lire');
      lire.addEventListener('click', () => {
        // UN LIVRE VA DANS LA LISEUSE, PAS DANS LA VISIONNEUSE. Constate a l'usage sur
        // « Stephen King - Holly (2024) Epub » : la visionneuse traitait l'EPUB comme un
        // CBZ, y trouvait la couverture et une illustration, et annoncait « 2 planches »
        // pour un roman de quatre cents pages.
        if (/\.epub$/i.test(f.chemin)) {
          window.Liseuse.ouvrir({
            identite: candidat.hash, service, fichier: f.chemin,
            titre: f.chemin.split('/').pop(),
            oeuvre: oeuvreSuivie(), titreOeuvre: oeuvreCourante?.titre,
            famille: familleCourante,
            couverture: oeuvreCourante?.couverture,
          });
          return;
        }
        // UNE PISTE VA DANS LA SURFACE D'ECOUTE, PAS DANS LA VISIONNEUSE.
        //
        // DEFAUT INTRODUIT le 2026-08-26 en rendant les pistes « contenu de premier
        // rang » : chaque ligne a gagne un bouton « Lire », qui tombait dans la branche
        // par defaut et ouvrait la visionneuse sur un MP3. Elle y cherchait des planches,
        // et enregistrait une progression en TOMES pour un livre audio — d'ou une entree
        // de bibliotheque qu'on ne peut plus rouvrir.
        //
        // On ouvre le livre entier, positionne sur la piste demandee : ses vingt-huit
        // fichiers sont UN livre, et l'ecoute a besoin du sommaire pour enchainer.
        if (f.estPiste) {
          const n = (structure.fichiers || []).filter((x) => x.estPiste).indexOf(f);
          window.Ecoute.ouvrir({
            identite: candidat.hash,
            service,
            titre: candidat.titre,
            oeuvre: oeuvreSuivie(),
            titreOeuvre: oeuvreCourante?.titre,
            famille: familleCourante,
            couverture: oeuvreCourante?.couverture,
            reprise: { chapitre: Math.max(0, n), pourcent: 0 },
          });
          return;
        }
        // `tomeId` vient du SERVEUR (structure.ts) : le client ne recalcule pas cette
        // identite, sous peine de la voir diverger en silence.
        window.Visionneuse.ouvrir({
          hash: candidat.hash, service, fichier: f.chemin, titre: f.chemin.split('/').pop(),
          oeuvre: oeuvreSuivie(), tome: f.tomeId, reprise: repriseConnue(f.tomeId),
          titreOeuvre: oeuvreCourante?.titre,
            famille: familleCourante, mangadexId: oeuvreCourante?.mangadexId,
          couverture: oeuvreCourante?.couverture,
          // La liste ENTIERE du pack, pas seulement le tome ouvert. Sans elle, lire le
          // tome 5 d'une integrale faisait entrer l'oeuvre dans la bibliotheque avec un
          // seul tome connu, et l'etagere annoncait « Tous les tomes (1) ».
          tomes: tomesDuPack(),
          tomeSuivant: suivantDe(f.tomeId),
          surTomeSuivant: (t) => ouvrirTomeDuPanneau(t),
        });
      });
      tdActions.append(lire);

      // « Telecharger » suit desormais la MEME regle que « Lire », et vit donc dans le
      // meme `if`. Sur une release non cachee, il promettait de recuperer UN tome alors
      // que rien dans le .torrent envoye ne dit au debrideur quels fichiers nous
      // interessent : il les prend tous. Le bouton faisait descendre le pack entier sans
      // le dire.
      const tel = elem('button', 'discret', 'Telecharger');
      tel.addEventListener('click', () => telechargerUn(candidat, service, f.chemin, sortie, tel));
      tdActions.append(tel);
    }

    tr.append(tdCoche, tdTome, tdNom, tdTaille, tdActions);
    return tr;
  }

  const pied = elem('div', 'pied-selection');

  function majPied() {
    pied.replaceChildren();

    const etat = etatDe(service);

    // TROIS etats, pas deux. Confondre « je ne sais pas » et « ce n'est pas la » faisait
    // affirmer « pas en cache » sur une release qu'on n'avait jamais interrogee — et
    // proposait de deposer, donc de telecharger plusieurs gigaoctets, sur la foi d'une
    // ignorance.
    if (verificationEnCours) {
      pied.append(elem('span', null, service === 'alldebrid'
        ? 'verification chez AllDebrid (depose le magnet une seconde)…'
        : 'verification chez TorBox…'));
      return;
    }

    if (etat === 'inconnu') {
      pied.append(elem('span', null, `etat inconnu chez ${service} — non verifie`));
      const v = elem('button', 'discret', `Verifier chez ${service}`);
      v.addEventListener('click', () => assurerEtat());
      pied.append(v);
      return;
    }

    // UN MOT, UN GESTE. La release est ABSENTE — verifiee, pas supposee. Il faut donc la
    // DEPOSER, et le debrideur prendra la release entiere : rien dans le .torrent envoye
    // ne lui dit quels tomes nous interessent.
    if (etat === 'absent') {
      const combien = structure.fichiers?.length || 0;
      const total = structure.fichiers?.reduce((n, f) => n + (f.taille || 0), 0) || 0;
      pied.append(elem('span', null, combien > 1
        ? `pas en cache — deposer telechargera les ${combien} fichiers (${poids(total)})`
        : `pas en cache — il faut d abord le deposer (${poids(total)})`));

      const dep = elem('button', 'principal', `Deposer chez ${service}`);
      dep.addEventListener('click', () => deposerRelease(candidat, service, sortie, dep));
      pied.append(dep);
      return;
    }

    pied.append(elem('span', null, `${cochees.size} tome(s) coche(s)`));

    const liens = elem('button', 'discret', 'Liens pour la selection');
    liens.addEventListener('click', () =>
      obtenirLiens(candidat, service, [...cochees], sortie, liens));
    pied.append(liens);

    if (structure.estPack) {
      // TORBOX D'ABORD QUAND IL L'OFFRE : son archive est servie depuis chez eux et ne
      // traverse pas cette machine. L'assemblage par Mangaloo ne sert que la ou personne
      // d'autre ne sait faire — AllDebrid, dont l'API n'a aucun point d'entree de zip
      // (mesure du 2026-08-20).
      const zip = elem('button', 'discret', 'Tout recuperer en archive');
      zip.addEventListener('click', () => {
        if (service === 'torbox') { obtenirZip(candidat, sortie, zip); return; }
        archiveAssemblee(candidat, service, sortie);
      });
      pied.append(zip);
    }
  }

  function majTableau() {
    corps.replaceChildren();
    lignesParTome.clear();

    // UN LIVRE AUDIO S'OUVRE EN ENTIER, PAS FICHIER PAR FICHIER. Ses vingt-huit MP3 sont
    // UN livre : offrir « Lire » sur chaque ligne ferait ouvrir un chapitre isole, sans
    // sommaire, sans enchainement et sans reprise.
    //
    // La condition est le FORMAT calcule par le serveur, jamais une liste d'extensions
    // recopiee ici. Deux listes finiraient par diverger, et c'est le serveur qui sait
    // vraiment ce qui s'ecoute — y compris qu'un M4B, lui, ne s'ecoute pas encore.
    if (candidat.format === 'audio' && etatDe(service) === 'en-cache') {
      const bloc = elem('div', 'actions-release');
      const ecouter = elem('button', 'principal', 'Ecouter');
      ecouter.addEventListener('click', () => {
        window.Ecoute.ouvrir({
          identite: candidat.hash,
          service,
          titre: candidat.titre,
          oeuvre: oeuvreSuivie(),
          titreOeuvre: oeuvreCourante?.titre,
            famille: familleCourante,
          couverture: oeuvreCourante?.couverture,
        });
      });
      bloc.append(ecouter);
      corps.append(bloc);
    }

    // La tranche reste en tete, comme vue d'ensemble : cliquer un dos fait DEFILER
    // jusqu'a la ligne du tome. Decocher se fait dans la case, la ou on l'attend.
    const t = tranche(structure, (tome) => {
      const ligne = lignesParTome.get(tome);
      if (!ligne) return;
      ligne.scrollIntoView({ block: 'center', behavior: 'smooth' });
      for (const autre of corps.querySelectorAll('tr.cible')) autre.classList.remove('cible');
      ligne.classList.add('cible');
    });
    if (t) corps.append(t.bloc);

    const table = elem('table', 'tomes');
    for (const f of contenu) table.append(ligneTome(f));
    corps.append(table);

    if (annexes.length > 0) {
      const detail = elem('details');
      detail.append(elem('summary', null, `${annexes.length} fichier(s) annexe(s) — non coche(s)`));
      const liste = elem('div', 'fichiers');
      for (const f of annexes) {
        const ligne = elem('div', 'fichier fichier--annexe');
        const coche = elem('input');
        coche.type = 'checkbox';
        coche.addEventListener('change', () => {
          if (coche.checked) cochees.add(f.chemin); else cochees.delete(f.chemin);
          majPied();
        });
        ligne.append(coche, elem('span', null, f.chemin), elem('span', 'taille', poids(f.taille)));
        liste.append(ligne);
      }
      detail.append(liste);
      corps.append(detail);
    }

    corps.append(pied);
    majPied();
  }

  // Expose pour que la verification de cache rafraichisse un panneau deja ouvert :
  // chez AllDebrid, l'etat n'existe QU'APRES le clic de verification.
  zone.majActions = () => {
    service = ['torbox', 'alldebrid'].find((s) => etatDe(s) === 'en-cache') || service;
    majChoixService();
    majTableau();
  };

  majChoixService();
  majTableau();
  // Ouvrir EST le geste explicite : c'est le moment de savoir si la release est en
  // cache, plutot que de renvoyer vers un bouton a cliquer soi-meme.
  assurerEtat();
}

/**
 * Table des hebergeurs d'une release en lien direct.
 *
 * Meme forme que la table de tomes : une ligne, deux actions. Un torrent se decompose en
 * tomes, une fiche en hebergeurs.
 */
function rendreHebergeurs(candidat, structure, zone) {
  zone.replaceChildren();
  const choix = elem('div', 'choix-service');
  const info = elem('div');
  const corps = elem('div');
  const sortie = elem('div');
  zone.append(choix, info, corps, sortie);

  const archive = structure.archive || { format: 'inconnu', lisible: false };

  // Ce que contient le fichier, dit avant toute action. Sur Wawacity, la moitie des
  // releases sont des RAR — que la visionneuse ne lit pas — et le titre ne permet pas
  // de le deviner.
  if (archive.lisible) {
    info.append(elem('div', 'tranche-legende', `archive lisible en ligne — ${archive.nbPlanches} planches`));
  } else {
    info.append(elem('div', 'message', archive.motif || 'archive non lisible en ligne'));
  }

  // Un pack : on LISTE les tomes meme si on ne sait pas les extraire un par un.
  // Ne rien afficher laisserait croire que le fichier est monolithique.
  if (archive.tomes?.length) {
    const detail = elem('details');
    detail.append(elem('summary', null, `${archive.tomes.length} tome(s) dans l archive`));
    const table = elem('table', 'tomes');
    for (const t of archive.tomes) {
      const tr = elem('tr');
      tr.append(elem('td', 'col-nom', t.nom));
      tr.append(elem('td', 'col-taille', poids(t.taille)));
      table.append(tr);
    }
    detail.append(table);
    info.append(detail);
  }

  let service = ['alldebrid', 'torbox']
    .find((s) => structure.hebergeurs.some((h) => h.supporte[s] && !h.mort)) || 'alldebrid';

  function majChoix() {
    choix.replaceChildren();
    for (const s of ['alldebrid', 'torbox']) {
      const n = structure.hebergeurs.filter((h) => h.supporte[s] && !h.mort).length;
      const b = elem('button', 'discret', `${s} — ${n} hebergeur(s)`);
      b.setAttribute('aria-pressed', String(s === service));
      b.addEventListener('click', () => { service = s; majChoix(); majTable(); });
      choix.append(b);
    }
  }

  function majTable() {
    corps.replaceChildren();
    const table = elem('table', 'tomes');
    for (const h of structure.hebergeurs) {
      const tr = elem('tr');
      const utilisable = h.supporte[service] && !h.mort;
      tr.append(elem('td', 'col-tome', utilisable ? '●' : h.mort ? '◌' : '○'));
      tr.append(elem('td', 'col-nom', h.hebergeur));
      tr.append(elem('td', 'col-taille', poids(h.taille)));

      const actions = elem('td', 'col-actions');
      if (h.mort) {
        // Grise, PAS cache : le cacher ferait croire que l'hebergeur n'existe pas.
        actions.append(elem('span', 'puce', `lien mort${h.morteDepuis ? ` — ${h.morteDepuis}` : ''}`));
      } else if (!utilisable) {
        actions.append(elem('span', 'puce', `non pris en charge par ${service}`));
      } else {
        // « Lire » n'apparait que si la sonde a vu un ZIP d'images. Un bouton qui echoue
        // apres une attente vaut moins qu'un bouton absent et une explication.
        if (archive.lisible) {
          const lire = elem('button', 'principal', 'Lire');
          lire.addEventListener('click', () => {
            const nom = h.nomFichier || candidat.titre;
            window.Visionneuse.ouvrir({
              hash: candidat.identite, service, fichier: nom, titre: nom,
              oeuvre: oeuvreSuivie(), tome: `f:${nom}`, reprise: repriseConnue(`f:${nom}`),
              titreOeuvre: oeuvreCourante?.titre,
            famille: familleCourante, mangadexId: oeuvreCourante?.mangadexId,
              couverture: oeuvreCourante?.couverture,
            });
          });
          actions.append(lire);
        }
        const tel = elem('button', 'discret', 'Telecharger');
        tel.addEventListener('click', () => telechargerDirect(candidat, service, h, sortie, tel));
        actions.append(tel);
      }
      tr.append(actions);
      table.append(tr);
    }
    corps.append(table);
  }

  majChoix();
  majTable();
}

async function telechargerDirect(candidat, service, hebergeur, sortie, bouton) {
  bouton.disabled = true;
  sortie.replaceChildren(elem('div', 'vide', `resolution via ${hebergeur.hebergeur}…`));
  try {
    const r = await api('/api/debrid/lien-direct', {
      method: 'POST',
      body: JSON.stringify({ identite: candidat.identite, service, index: hebergeur.index }),
    });
    if (r.repli) {
      // On ne bascule jamais en silence : l'utilisateur doit savoir que ce qu'il
      // telecharge ne vient pas de l'hebergeur qu'il avait choisi.
      sortie.replaceChildren(elem('div', 'message',
        `${hebergeur.hebergeur} n'a pas repondu — le fichier vient de ${r.hebergeur}.`));
    } else {
      sortie.replaceChildren();
    }
    location.href = r.url;
  } catch (e) {
    afficherErreur(sortie, e.message);
  } finally {
    bouton.disabled = false;
  }
}

// Verdict du seed anti-H&R renvoye par /api/debrid/liens. null si rien a annoncer.
function noteSeed(r) {
  const s = r && r.rustatio;
  if (!s || s.statut === 'ignore') return null;
  if (s.statut === 'seede') {
    const msg = s.raison === 'deja-present'
      ? '🌱 H&R couvert (déjà présent dans Rustatio)'
      : '🌱 Seed H&R lancé sur Rustatio';
    return elem('div', 'message message--ok', msg);
  }
  return elem('div', 'message message--erreur',
    '⚠️ Seed H&R non couvert : ' + (s.raison || 'echec Rustatio'));
}

async function telechargerUn(candidat, service, chemin, sortie, bouton) {
  bouton.disabled = true;
  try {
    const r = await api('/api/debrid/liens', {
      method: 'POST',
      body: JSON.stringify({ hash: candidat.hash, service, fichiers: [chemin] }),
    });
    const lien = r.liens?.[0];
    if (!lien) throw new Error("ce fichier n'a pas pu etre ouvert");
    const ns = noteSeed(r);
    if (ns) sortie.replaceChildren(ns);
    // Le lien porte un Content-Disposition d'attachement : le navigateur telecharge
    // sans quitter la page.
    location.href = lien.url;
  } catch (e) {
    afficherErreur(sortie, e.message);
  } finally {
    bouton.disabled = false;
  }
}

async function obtenirLiens(candidat, service, selection, sortie, bouton) {
  if (selection.length === 0) {
    afficherErreur(sortie, 'aucun fichier selectionne');
    return;
  }
  bouton.disabled = true;
  sortie.replaceChildren(elem('div', 'vide', `${service} prepare ${selection.length} lien(s)…`));
  try {
    const r = await api('/api/debrid/liens', {
      method: 'POST',
      body: JSON.stringify({ hash: candidat.hash, service, fichiers: selection }),
    });
    const liste = elem('div', 'liens');
    const ns = noteSeed(r);
    if (ns) liste.append(ns);
    if (r.resolus < r.demandes) {
      liste.append(elem('div', 'message message--erreur',
        `${r.resolus} lien(s) sur ${r.demandes} : les autres n'ont pas pu etre ouverts`));
    }
    for (const l of r.liens) {
      const a = elem('a', null, l.nom);
      a.href = l.url;
      a.download = l.nom;
      liste.append(a);
    }
    sortie.replaceChildren(liste);
  } catch (e) {
    afficherErreur(sortie, e.message);
  } finally {
    bouton.disabled = false;
  }
}

/**
 * L'archive que Mangaloo assemble lui-meme, pour les debrideurs qui n'en produisent pas.
 *
 * ON DONNE UN LIEN PLUTOT QUE DE LANCER LE TELECHARGEMENT. Le fichier n'existe nulle part
 * et se fabrique pendant l'envoi : il NE SE REPREND PAS. Le dire avant que l'utilisateur
 * clique vaut mieux que de le lui apprendre a 900 Mo.
 */
function archiveAssemblee(candidat, service, sortie) {
  // ON TRANSMET LE TITRE DE LA RELEASE : le serveur ne connait que le hash, et
  // nommerait sinon l'archive d'apres le dossier racine du torrent — qui perd le format
  // et l'annee. Le serveur en retire ce qu'un systeme de fichiers refuse.
  const url = `/api/release/${encodeURIComponent(candidat.hash)}/archive`
    + `?service=${encodeURIComponent(service)}`
    + `&nom=${encodeURIComponent(candidat.titre || '')}`;
  const a = elem('a', null, 'Telecharger l archive complete');
  a.href = url;
  sortie.replaceChildren(a, elem('div', 'vide',
    `${service} ne produit pas d archive : Mangaloo l assemble pendant l envoi. `
    + 'Le telechargement ne se reprend pas si la connexion tombe.'));
}

async function obtenirZip(candidat, sortie, bouton) {
  bouton.disabled = true;
  sortie.replaceChildren(elem('div', 'vide', 'TorBox prepare l archive…'));
  try {
    const r = await api('/api/debrid/zip', {
      method: 'POST',
      body: JSON.stringify({ hash: candidat.hash, service: 'torbox' }),
    });
    const a = elem('a', null, 'Telecharger l archive complete');
    a.href = r.url;
    sortie.replaceChildren(a);
  } catch (e) {
    afficherErreur(sortie, e.message);
  } finally {
    bouton.disabled = false;
  }
}

// --- rendu de la liste de releases ---------------------------------------

/** Lit un flux NDJSON ligne par ligne, sans attendre la fin de la reponse. */
async function* lignesDuFlux(reponse) {
  const lecteur = reponse.body.getReader();
  const decodeur = new TextDecoder();
  let reste = '';
  for (;;) {
    const { done, value } = await lecteur.read();
    if (done) break;
    reste += decodeur.decode(value, { stream: true });
    const morceaux = reste.split('\n');
    reste = morceaux.pop() ?? '';
    for (const l of morceaux) if (l.trim()) yield JSON.parse(l);
  }
  if (reste.trim()) yield JSON.parse(reste);
}

/**
 * Affiche les releases AU FUR ET A MESURE que les sources repondent.
 *
 * Le navigateur ne dedoublonne ni ne trie : il insere au `rang` que le serveur lui
 * donne. Ces regles sont testees la-bas, et les dupliquer ici garantirait qu'elles
 * divergent un jour.
 */
async function suivreFlux(url, cible, surOeuvre) {
  cible.replaceChildren();
  const messages = elem('div');
  const pastilles = elem('div', 'sources');
  const liste = elem('div');
  const blocIncertaines = elem('details');
  const listeIncertaines = elem('div');
  const resumeIncertaines = elem('summary', null, '');
  blocIncertaines.append(resumeIncertaines, listeIncertaines);
  blocIncertaines.hidden = true;
  const etatServices = elem('div');
  const filtresAutres = elem('div', 'sources');
  const invitation = elem('div', 'vide', '');
  const sentinelleCertaines = elem('div', 'sentinelle');
  const sentinelleIncertaines = elem('div', 'sentinelle');
  sentinelleCertaines.hidden = true;
  sentinelleIncertaines.hidden = true;
  cible.append(messages, pastilles, filtresAutres, invitation, liste, sentinelleCertaines,
    blocIncertaines, etatServices);
  // Le bloc replie ne se peint qu'a son ouverture.
  blocIncertaines.addEventListener('toggle', () => {
    if (blocIncertaines.open && listeIncertaines.children.length === 0) {
      peindreParFournees(aPeindreIncertaines, listeIncertaines, sentinelleIncertaines);
    }
  });

  const etats = { torbox: {}, alldebrid: {}, services: {} };
  const colonnes = [];
  const parHash = new Map();
  const parSource = new Map();
  // Toutes les cartes affichees, avec de quoi les filtrer. Le filtre MASQUE, il ne
  // reordonne pas : le rang reste celui que le serveur a calcule.
  const toutes = [];
  const filtres = {
    source: new Set(), langue: new Set(), format: new Set(),
    nature: new Set(), ratio: new Set(),
  };
  // Renseigne par la ligne « attente » du flux : le serveur dit quelles sources sont
  // gratuites, le client se contente de s'en souvenir.
  const sansRatio = new Set();
  let nCertaines = 0;
  let nIncertaines = 0;
  // « tout afficher » n'est pas l'absence de filtre : c'est une demande explicite. Sans
  // cette distinction, retirer le dernier filtre viderait l'ecran au lieu de tout montrer.
  let montrerTout = false;
  let aPeindreIncertaines = [];
  const observateurs = [];
  // Des qu'un panneau est ouvert, on cesse de repositionner : rien ne doit sauter sous
  // le curseur pendant qu'on lit une liste de tomes.
  let triGele = false;

  function pastille(id, label, etat, n, retenus) {
    const actif = filtres.source.has(id);
    const e = elem(
      etat === 'repondu' ? 'button' : 'span',
      `${etat ? `source--${etat}` : 'source--attente'}${actif ? ' filtre-actif' : ''}`,
      etat ? `${label} : ${ETATS_SOURCE[etat](n)}` : `${label} …`,
    );
    // ECARTES PAR LE PLAFOND. Sans ce mot, une pastille « repondu (30) » cotoyait une
    // liste ou la source n'avait pas une seule carte : filtrer dessus vidait l'ecran
    // sans rien expliquer.
    if (etat === 'repondu' && typeof retenus === 'number' && retenus < n) {
      e.textContent = `${label} : ${n} rendus, ${retenus} affiches`;
      e.title = retenus === 0
        ? 'La limite de resultats etait atteinte quand cette source a repondu : aucun de '
          + 'ses resultats n a pu etre affiche.'
        : `La limite de resultats a ecarte ${n - retenus} de ses resultats.`;
    }
    e.dataset.source = id;
    // Filtrer sur une source vide ou en echec n'a pas de sens : elle n'est pas cliquable.
    if (etat === 'repondu') {
      e.setAttribute('aria-pressed', String(actif));
      e.addEventListener('click', () => basculer('source', id));
    }
    return e;
  }

  function basculer(axe, valeur) {
    montrerTout = false;
    if (filtres[axe].has(valeur)) filtres[axe].delete(valeur);
    else filtres[axe].add(valeur);
    appliquerFiltres();
  }

  /** Une carte passe si, pour CHAQUE axe filtre, elle correspond. */
  function retenue(c) {
    // La source PRINCIPALE ne suffit pas. Une release trouvee sur deux trackers est
    // fusionnee en une seule carte : le premier arrive devient `source`, les autres
    // passent dans `aussiSur`. Or la pastille compte ce que la source a RENDU, doublons
    // compris.
    //
    // Ne regarder que `source` faisait donc annoncer « C411 : 2 » et n'afficher rien du
    // tout quand ces deux resultats existaient deja ailleurs — constate sur « Sidooh ».
    // Le filtre dit desormais la meme chose que le compteur : « presente sur ce
    // tracker ».
    if (filtres.source.size) {
      const surLeTracker =
        filtres.source.has(c.source) || (c.aussiSur || []).some((s) => filtres.source.has(s));
      if (!surLeTracker) return false;
    }
    if (filtres.langue.size && !filtres.langue.has(c.langue || 'inconnue')) return false;
    // LE FORMAT EST LE SEUL AXE QUI DIT CE QU'ON POURRA FAIRE DU FICHIER. Un tracker
    // range un mp3 en categorie Ebook, et rien ne l'en empeche : c'est ici que le lecteur
    // ecarte ce qui ne l'interesse pas.
    if (filtres.format.size && !filtres.format.has(c.format || 'inconnu')) return false;
    const nature = c.hash ? 'torrent' : 'direct';
    if (filtres.nature.size && !filtres.nature.has(nature)) return false;

    // Sans ratio : la release s'obtient sans debiter le compte d'un tracker prive. On
    // regarde AUSSI `aussiSur` — le dedoublonnage garde la premiere source arrivee comme
    // principale, et une release trouvee sur Ygg ET sur Nyaa s'obtient gratuitement.
    if (filtres.ratio && filtres.ratio.size) {
      const gratuite = sansRatio.has(c.source)
        || (c.aussiSur || []).some((s) => sansRatio.has(s));
      if (!gratuite) return false;
    }
    return true;
  }

  /**
   * Un affichage est-il demande ?
   *
   * Tant que la reponse est non, AUCUNE carte n'est peinte. C'est ce qui permet de ne
   * plus rien jeter cote serveur : le cout d'un resultat de plus n'est plus un noeud DOM.
   */
  function affichageActif() {
    return montrerTout || filtres.source.size > 0 || filtres.langue.size > 0
      || filtres.format.size > 0 || filtres.nature.size > 0 || filtres.ratio.size > 0;
  }

  /** Combien de cartes par fournee. Assez pour remplir un grand ecran d'un coup. */
  const PAR_FOURNEE = 24;

  /** Peint une liste par fournees, la suite venant au defilement. */
  function peindreParFournees(entrees, conteneur, sentinelle) {
    let poses = 0;
    const fournee = () => {
      for (const e of entrees.slice(poses, poses + PAR_FOURNEE)) peindre(e);
      poses = Math.min(poses + PAR_FOURNEE, entrees.length);
      return poses >= entrees.length;
    };
    if (fournee()) { sentinelle.hidden = true; return; }
    sentinelle.hidden = false;
    // `IntersectionObserver` plutot qu'un ecouteur de defilement : il ne se declenche pas
    // soixante fois par seconde et n'a rien a calculer.
    const oeil = new IntersectionObserver((entrs) => {
      if (!entrs.some((x) => x.isIntersecting)) return;
      if (fournee()) { oeil.disconnect(); sentinelle.hidden = true; }
    }, { rootMargin: '400px' });
    oeil.observe(sentinelle);
    observateurs.push(oeil);
    conteneur.after(sentinelle);
  }

  function appliquerFiltres() {
    // Les observateurs de la peinture precedente n'ont plus rien a surveiller.
    for (const o of observateurs) o.disconnect();
    observateurs.length = 0;
    liste.replaceChildren();
    listeIncertaines.replaceChildren();
    for (const e of toutes) if (e.carte) e.carte.hidden = true;

    const retenus = affichageActif() ? toutes.filter(({ candidat }) => retenue(candidat)) : [];
    const certains = retenus.filter(({ candidat }) => candidat.certain !== false);
    const incertains = retenus.filter(({ candidat }) => candidat.certain === false);

    if (!affichageActif()) {
      blocIncertaines.hidden = true;
      majCompteurs();
      return;
    }

    peindreParFournees(certains, liste, sentinelleCertaines);
    // Les incertaines ne sont peintes qu'a l'ouverture du bloc : il est replie par
    // defaut, et y poser des centaines de cartes que personne ne regarde serait payer
    // pour rien.
    blocIncertaines.hidden = incertains.length === 0;
    resumeIncertaines.textContent =
      `${incertains.length} correspondance(s) incertaine(s) — le titre ne correspond pas franchement`;
    aPeindreIncertaines = incertains;
    if (blocIncertaines.open) peindreParFournees(incertains, listeIncertaines, sentinelleIncertaines);

    majCompteurs();
  }

  /**
   * Rafraichit les compteurs et l'invitation, SANS repeindre.
   *
   * Appelee a chaque source qui repond : une repeinture complete a chacune couterait de
   * refabriquer des centaines de cartes pour rien, alors que les arrivees se peignent
   * deja d'elles-memes a leur rang.
   */
  function majCompteurs() {
    const actif = affichageActif();
    invitation.hidden = actif || toutes.length === 0;
    if (!actif) {
      // NE PAS RENDRE UNE PAGE VIDE SANS RIEN DIRE. Une recherche qui n'affiche rien se
      // lit comme un echec : l'ecran doit dire ce qu'il attend.
      invitation.textContent =
        `${toutes.length} resultat(s). Choisissez une source ou un format ci-dessus `
        + 'pour les afficher.';
    }
    majPastillesSource();
    majFiltresAutres(toutes.filter(({ candidat }) => retenue(candidat)).length);
  }

  function majPastillesSource() {
    for (const [id, p] of parSource) {
      if (!p) continue;
      p.classList.toggle('filtre-actif', filtres.source.has(id));
      if (p.tagName === 'BUTTON') p.setAttribute('aria-pressed', String(filtres.source.has(id)));
    }
  }

  function majFiltresAutres(visibles) {
    filtresAutres.replaceChildren();
    const compte = (predicat) => toutes.filter(({ candidat }) => predicat(candidat)).length;

    const langues = [...new Set(toutes.map(({ candidat }) => candidat.langue || 'inconnue'))];
    for (const l of langues.sort()) {
      const n = compte((c) => (c.langue || 'inconnue') === l);
      if (n === 0) continue;
      const b = elem('button', filtres.langue.has(l) ? 'filtre-actif' : null, `${l} · ${n}`);
      b.setAttribute('aria-pressed', String(filtres.langue.has(l)));
      b.addEventListener('click', () => basculer('langue', l));
      filtresAutres.append(b);
    }

    // Les formats reellement presents, pas une liste figee : proposer « cbr » sur une
    // recherche qui n'en contient aucun serait une fausse promesse.
    const formats = [...new Set(toutes.map(({ candidat }) => candidat.format || 'inconnu'))];
    for (const f of formats.sort()) {
      const n = compte((c) => (c.format || 'inconnu') === f);
      if (n === 0) continue;
      const b = elem('button', filtres.format.has(f) ? 'filtre-actif' : null, `${f} · ${n}`);
      if (f === 'audio') b.title = 'Enregistrements : mp3, m4b, flac. Aucune lecture en ligne.';
      b.setAttribute('aria-pressed', String(filtres.format.has(f)));
      b.addEventListener('click', () => basculer('format', f));
      filtresAutres.append(b);
    }

    for (const [cle, libelle] of [['torrent', 'torrent'], ['direct', 'lien direct']]) {
      const n = compte((c) => (c.hash ? 'torrent' : 'direct') === cle);
      if (n === 0) continue;
      const b = elem('button', filtres.nature.has(cle) ? 'filtre-actif' : null, `${libelle} · ${n}`);
      b.setAttribute('aria-pressed', String(filtres.nature.has(cle)));
      b.addEventListener('click', () => basculer('nature', cle));
      filtresAutres.append(b);
    }

    const n = compte((c) => sansRatio.has(c.source)
      || (c.aussiSur || []).some((s) => sansRatio.has(s)));
    // La pastille n'apparait que s'il y a quelque chose a montrer : proposer un filtre
    // qui ne rendrait rien serait une fausse promesse.
    if (n > 0) {
      const b = elem('button', filtres.ratio.has('oui') ? 'filtre-actif' : null, `sans ratio · ${n}`);
      b.title = 'Releases qui ne debitent aucun tracker prive : Telegram, Nyaa, Knaben, '
        + 'liens directs. Deposer chez un debrideur telecharge avec VOTRE passkey.';
      b.setAttribute('aria-pressed', String(filtres.ratio.has('oui')));
      b.addEventListener('click', () => basculer('ratio', 'oui'));
      filtresAutres.append(b);
    }

    // « Tout afficher » est une DEMANDE, pas l'absence de filtre : sans lui, il n'y
    // aurait aucun moyen de voir l'ensemble, puisque retirer le dernier filtre rend
    // desormais la page a son etat d'attente.
    if (toutes.length > 0) {
      const tout = elem('button', montrerTout ? 'filtre-actif' : 'principal',
        montrerTout ? `tout (${visibles})` : `tout afficher (${toutes.length})`);
      tout.setAttribute('aria-pressed', String(montrerTout));
      tout.addEventListener('click', () => {
        montrerTout = !montrerTout;
        if (montrerTout) for (const axe of Object.keys(filtres)) filtres[axe].clear();
        appliquerFiltres();
      });
      filtresAutres.append(tout);
    }
  }

  /** Insere au bon rang. Le client ne connait pas la regle, seulement l'ordre. */
  function inserer(conteneur, carte, rang) {
    if (triGele) { conteneur.append(carte); return; }
    for (const enfant of conteneur.children) {
      if (Number(enfant.dataset.rang) > rang) { conteneur.insertBefore(carte, enfant); return; }
    }
    conteneur.append(carte);
  }

  /**
   * Memorise un candidat. NE FABRIQUE AUCUNE CARTE.
   *
   * C'est le changement de principe. Auparavant chaque candidat devenait immediatement un
   * noeud DOM, ce qui obligeait a plafonner le nombre de resultats — et ce plafond
   * ecartait des sources entieres, arrivees trop tard. Une carte coute maintenant
   * quelques centaines d'octets en memoire tant que personne ne demande a la voir.
   */
  function ajouter(c) {
    const entree = { candidat: c, carte: null };
    if (c.hash) parHash.set(c.hash, entree);
    toutes.push(entree);
    if (c.certain === false) nIncertaines++; else nCertaines++;
    // Une arrivee pendant qu'un filtre est pose se peint tout de suite, a son rang.
    if (affichageActif() && retenue(c)) peindre(entree);
  }

  /** Fabrique la carte d'un candidat, une seule fois, et la pose a son rang. */
  function peindre(entree) {
    const c = entree.candidat;
    if (!entree.carte) {
      entree.carte = carteRelease(c, etats, colonnes);
      entree.carte.dataset.rang = String(c.rang ?? 0);
      entree.carte.addEventListener('click', () => { triGele = true; }, { once: true });
    }
    entree.carte.hidden = false;
    const cible = c.certain === false ? listeIncertaines : liste;
    if (entree.carte.parentElement !== cible) inserer(cible, entree.carte, c.rang ?? 0);
  }

  function fusionner(f) {
    const ligne = parHash.get(f.hash);
    if (!ligne) return;
    Object.assign(ligne.candidat, f);
    // La carte n'existe que si elle a ete demandee : sans ce garde, une fusion arrivant
    // avant tout clic de filtre ferait tomber la page entiere.
    ligne.carte?.majFusion?.(f);
  }

  try {
    const reponse = await fetch(url, { headers: { Accept: 'application/x-ndjson' } });
    if (reponse.status === 401) { location.href = '/login.html'; return; }

    for await (const ligne of lignesDuFlux(reponse)) {
      if (ligne.type === 'erreur') {
        afficherErreur(messages, ligne.erreur);
        return;
      }
      if (ligne.type === 'oeuvre') {
        surOeuvre?.(ligne.oeuvre);
        continue;
      }
      if (ligne.type === 'attente') {
        pastilles.replaceChildren();
        for (const s of ligne.sources) {
          if (s.ratio === false) sansRatio.add(s.id);
          const p = pastille(s.id, s.label, null, 0);
          parSource.set(s.id, p);
          pastilles.append(p);
        }
        continue;
      }
      if (ligne.type === 'source') {
        const p = parSource.get(ligne.id);
        if (p) p.replaceWith(pastille(ligne.id, ligne.label, ligne.etat, ligne.n, ligne.retenus));
        parSource.set(ligne.id, pastilles.querySelector(`[data-source="${ligne.id}"]`));
        for (const c of ligne.ajouts) ajouter(c);
        for (const f of ligne.fusions) fusionner(f);
        majCompteurs();
        continue;
      }
      if (ligne.type === 'fin') {
        if (nCertaines + nIncertaines === 0) {
          messages.append(elem('div', 'vide',
            'Aucune release trouvee. Regardez l etat des sources : « vide » et « n a pas repondu » ne veulent pas dire la meme chose.'));
        }
        const hashes = [...parHash.keys()];
        if (hashes.length > 0) {
              chargerEtatsCache(hashes, etats, colonnes, etatServices);
        }
      }
    }
  } catch (e) {
    // On GARDE ce qui est arrive : vider la liste sur une coupure tardive serait perdre
    // un travail deja fait, et faire croire qu'il n'y avait rien.
    afficherErreur(messages,
      `La recherche s'est interrompue (${e.message}). ${nCertaines + nIncertaines} resultat(s) deja recus.`);
  }
}


/**
 * Va chercher les etats de cache APRES l'affichage.
 *
 * La liste ne doit pas attendre : TorBox traverse des periodes ou il repond en 25 s ou
 * pas du tout, et faire patienter devant une page deja construite serait un mauvais
 * echange. Les pastilles se remplissent quand elles peuvent.
 */
async function chargerEtatsCache(hashes, etats, colonnes, etatServices) {
  etatServices.replaceChildren(elem('div', 'vide', 'verification du cache en cours…'));
  try {
    const { etats: recus } = await api('/api/etats-cache', {
      method: 'POST',
      body: JSON.stringify({ hashes }),
    });
    Object.assign(etats.torbox, recus.torbox);
    Object.assign(etats.alldebrid, recus.alldebrid);
    etats.services = recus.services;

    for (const { hash, colonneEtats, majActions } of colonnes) {
      colonneEtats.replaceChildren(
        indicateur('AD', etats.alldebrid[hash] || 'inconnu'),
        indicateur('TB', etats.torbox[hash] || 'inconnu'),
      );
      // « Ecouter » depend du cache, qu'on vient tout juste d'apprendre.
      majActions?.();
    }

    const tb = recus.services?.torbox;
    if (tb === 'echec') {
      etatServices.replaceChildren(elem('div', 'message message--erreur',
        "TorBox n'a pas repondu : sa colonne est incomplete. Ce n'est pas un « pas en cache », "
        + 'mais une panne de leur cote — reessayez dans un moment.'));
    } else if (tb === 'cle-absente') {
      etatServices.replaceChildren(elem('div', 'message',
        'Aucune cle TorBox enregistree : sa colonne reste vide.'));
    } else {
      etatServices.replaceChildren();
    }
  } catch (e) {
    etatServices.replaceChildren(elem('div', 'message message--erreur',
      `Etat de cache indisponible : ${e.message}`));
  }
}

// --- pages ---------------------------------------------------------------

function bandeauCommun() {
  const deconnexion = document.getElementById('deconnexion');
  if (deconnexion) {
    deconnexion.addEventListener('click', async () => {
      await api('/api/logout', { method: 'POST' }).catch(() => undefined);
      location.href = '/login.html';
    });
  }
}

/** Une carte d'oeuvre. */
function carteOeuvre(o) {
  const a = elem('a', 'fiche');
  // LA FAMILLE VOYAGE AVEC LA FICHE. Sans elle, `oeuvre.html` retombait sur « mangas »
  // par defaut : une fiche de livre interrogeait donc les sources avec les categories du
  // manga, et Gemini rendait des mangas pour un roman de Stephen King. Signale a l'usage
  // sur une URL copiee — c'est ce lien-ci qui l'avait perdue.
  a.href = `/oeuvre.html?id=${encodeURIComponent(o.id)}`
    + `&famille=${encodeURIComponent(familleCourante)}`;
  if (o.couverture) {
    const img = elem('img');
    img.src = o.couverture;
    img.alt = '';
    img.loading = 'lazy';
    a.append(img);
  } else {
    a.append(elem('div', 'sans-image'));
  }
  a.append(elem('b', null, o.titre));
  // L'AUTEUR D'ABORD. Une recherche « Holly » rend trois fiches identiquement intitulees
  // « Holly » : l'une est de Stephen King, l'autre d'Albert French. Sans le nom, il n'y
  // avait aucun moyen de choisir — il fallait ouvrir les trois.
  a.append(elem('small', null, [o.auteur, o.annee, o.statut].filter(Boolean).join(' · ')));
  return a;
}

/** Combien de cartes par fournee. Assez pour remplir un grand ecran d'un coup. */
const PAR_FOURNEE = 24;

/**
 * Affiche les oeuvres par fournees, la suite venant au defilement.
 *
 * POURQUOI PAS TOUT D'UN COUP. La bibliographie de Stephen King rend 128 livres, chacun
 * avec sa couverture : les poser tous demande 128 requetes d'image pour un ecran qui en
 * montre douze. Le plafond n'est plus dans les donnees — elles arrivent entieres — il est
 * seulement dans ce qui est peint.
 *
 * TOUT EST DEJA LA. Aucune requete reseau au defilement : la liste complete est en
 * memoire, on ne fait qu'en peindre la suite. Rien ne peut donc echouer a mi-parcours.
 */
function afficherOeuvres(hote, oeuvres) {
  const grille = elem('div', 'grille');
  let poses = 0;

  const fournee = () => {
    for (const o of oeuvres.slice(poses, poses + PAR_FOURNEE)) grille.append(carteOeuvre(o));
    poses = Math.min(poses + PAR_FOURNEE, oeuvres.length);
    return poses >= oeuvres.length;
  };

  const fini = fournee();
  hote.replaceChildren(grille);
  if (fini) return;

  // La sentinelle est un element vide place SOUS la grille : quand il entre dans le
  // champ, c'est qu'on approche du bas.
  const sentinelle = elem('div', 'sentinelle');
  const compteur = elem('div', 'vide');
  const direCombien = () => { compteur.textContent = `${poses} sur ${oeuvres.length}`; };
  direCombien();
  hote.append(compteur, sentinelle);

  // `IntersectionObserver` plutot qu'un ecouteur de defilement : il ne se declenche pas
  // soixante fois par seconde et n'a rien a calculer.
  const oeil = new IntersectionObserver((entrees) => {
    if (!entrees.some((e) => e.isIntersecting)) return;
    if (fournee()) {
      oeil.disconnect();
      compteur.remove();
      sentinelle.remove();
      return;
    }
    direCombien();
  }, { rootMargin: '400px' });
  oeil.observe(sentinelle);
}

async function pageAccueil() {
  bandeauCommun();
  familleCourante = new URLSearchParams(location.search).get('famille') || 'mangas';
  try {
    const { familles } = await api('/api/familles');
    const f = familles.find((x) => x.id === familleCourante);
    if (f) {
      familleLisible = f.lisibleEnLigne;
      catalogueCourant = f.catalogues[0] ?? null;
      document.title = `${f.libelle} — Book Loo Store`;
      const h = document.querySelector('main h1');
      if (h) h.textContent = f.libelle;
      // Le texte d'accueil nommait MangaDex et « les quatre trackers » sur TOUTES les
      // familles. Il dit maintenant ce que cette famille-ci interroge vraiment.
      const intro = document.getElementById('intro');
      if (intro) {
        const noms = f.catalogues.map((c) => NOM_CATALOGUE[c] || c);
        intro.textContent = noms.length > 0
          ? `Fiches ${noms.join(', puis ')}. La recherche libre interroge les ${f.sources} source(s) sans passer par une fiche.`
          : `Pas de fiche pour cette famille : la recherche interroge directement les ${f.sources} source(s).`;
      }
    }
  } catch {
    // La vitrine est indisponible : on cherche quand meme, en mangas par defaut.
  }
  const champ = document.getElementById('q');
  const resultats = document.getElementById('resultats');
  const titreSection = document.getElementById('titre-resultats');

  async function chercherCatalogue() {
    const q = champ.value.trim();
    if (!q) return;
    titreSection.textContent = 'Oeuvres';
    resultats.replaceChildren(elem('div', 'vide', 'recherche dans le catalogue…'));
    try {
      const mode = document.getElementById('mode')?.value === 'auteur' ? 'auteur' : 'titre';
      const r = await api(avecFamille(`/api/catalogue?q=${encodeURIComponent(q)}&mode=${mode}`));
      if (r.sansCatalogue) {
        // Cette famille n'a pas de fiche : chercher directement chez les sources est le
        // seul parcours qui rend quelque chose. Le faire en silence vaut mieux qu'un
        // « aucun resultat » qui serait faux.
        await chercherLibre();
        return;
      }
      const { oeuvres } = r;
      if (oeuvres.length === 0) {
        // Le catalogue qui a REELLEMENT repondu : la famille Livres bascule de Booknode
        // a Open Library en cours de route, et nommer le mauvais egarerait.
        const nom = NOM_CATALOGUE[r.catalogue || catalogueCourant] || 'Le catalogue';
        resultats.replaceChildren(elem('div', 'vide',
          `${nom} ne connait pas ce titre. Essayez la recherche libre : elle interroge les trackers sans passer par une fiche — c'est aussi ce qu'il faut pour les packs et les integrales, qu'aucun catalogue ne repertorie.`));
        return;
      }
      afficherOeuvres(resultats, oeuvres);
    } catch (e) {
      afficherErreur(resultats, e.message);
    }
  }

  async function chercherLibre() {
    const q = champ.value.trim();
    if (!q) return;
    titreSection.textContent = 'Releases (recherche libre)';
    // Pas de fiche, donc pas d'uuid ni de couverture : le titre saisi suffit a former une
    // identite « libre: ». C'est ce qui permet a la BD franco-belge — la raison d'etre de
    // cette recherche — d'entrer dans la bibliotheque comme le reste.
    oeuvreCourante = { titre: q, couverture: null };
    await chargerSuivi(q, null);
    await suivreFlux(avecFamille(`/api/recherche-libre/flux?q=${encodeURIComponent(q)}`), resultats);
  }

  document.getElementById('chercher').addEventListener('click', chercherCatalogue);
  document.getElementById('chercher-libre').addEventListener('click', chercherLibre);
  champ.addEventListener('keydown', (e) => { if (e.key === 'Enter') chercherCatalogue(); });
  champ.focus();
}

async function pageOeuvre() {
  bandeauCommun();
  const params = new URLSearchParams(location.search);
  const id = params.get('id');
  familleCourante = params.get('famille') || 'mangas';
  try {
    const { familles } = await api('/api/familles');
    const f = familles.find((x) => x.id === familleCourante);
    if (f) familleLisible = f.lisibleEnLigne;
  } catch { /* on lit quand meme */ }
  const entete = document.getElementById('entete');
  const resultats = document.getElementById('resultats');
  if (!id) { afficherErreur(entete, 'aucune oeuvre demandee'); return; }

  entete.replaceChildren(elem('div', 'vide', 'chargement de la fiche…'));

  // La fiche arrive dans la PREMIERE ligne du flux : elle s'affiche avant qu'aucun
  // tracker n'ait repondu.
  await suivreFlux(avecFamille(`/api/oeuvre/${encodeURIComponent(id)}/releases/flux`), resultats, (o) => {
    document.title = `${o.titre} — Book Loo Store`;
    // Desormais on sait quoi suivre : l'uuid MangaDex et sa couverture.
    oeuvreCourante = { mangadexId: id, titre: o.titre, couverture: o.couverture || null };
    chargerSuivi(o.titre, id);
    const bloc = elem('div', 'oeuvre');
    if (o.couverture) {
      const img = elem('img');
      img.src = o.couverture;
      img.alt = `Couverture de ${o.titre}`;
      bloc.append(img);
    } else {
      bloc.append(elem('div', 'sans-image'));
    }
    const droite = elem('div');
    droite.append(elem('h1', null, o.titre));
    droite.append(elem('div', 'titres', [o.auteur, o.annee, o.statut].filter(Boolean).join(' · ')));
    const autres = o.titres.filter((t) => t !== o.titre).slice(0, 4);
    if (autres.length) droite.append(elem('div', 'titres', autres.join(' · ')));
    if (o.synopsis) droite.append(elem('p', null, o.synopsis.slice(0, 400)));
    bloc.append(droite);
    entete.replaceChildren(bloc);
  });
}

async function pageConnexion() {
  const form = document.getElementById('form');
  const sortie = document.getElementById('sortie');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    sortie.replaceChildren();
    try {
      await api('/api/login', {
        method: 'POST',
        body: JSON.stringify({
          login: document.getElementById('login').value,
          motDePasse: document.getElementById('motdepasse').value,
        }),
      });
      // On arrive sur la vitrine, pas sur une recherche : il faut d'abord choisir ce
      // qu'on cherche.
      location.href = '/accueil.html';
    } catch (err) {
      afficherErreur(sortie, err.message);
    }
  });
}

async function pageCompte() {
  bandeauCommun();
  const liste = document.getElementById('cles');
  const sortie = document.getElementById('sortie');

  // Groupees par role : les passkeys de trackers et les cles de debrideurs ne se
  // trouvent pas au meme endroit et ne se renouvellent pas en meme temps.
  const GROUPES = [
    {
      titre: 'Trackers',
      cles: [
        ['ygg', 'YggReborn', 'passkey Torznab, dans votre profil du tracker'],
        ['c411', 'C411', 'passkey Torznab'],
        ['tr4ker', 'Tr4ker', 'passkey Torznab'],
        ['g3mini', 'Gemini', 'jeton API, dans les parametres du compte'],
        ['v3x', 'V3X', 'cle API Torznab — livres seulement, ce tracker n a pas de BD'],
      ],
    },
    {
      titre: 'Debrideurs',
      cles: [
        ['ad', 'AllDebrid', 'cle API'],
        ['tb', 'TorBox', 'cle API'],
      ],
    },
  ];

  const ETIQUETTES = Object.fromEntries(
    GROUPES.flatMap((g) => g.cles.map(([nom, label]) => [nom, label])),
  );

  async function recharger() {
    const { cles } = await api('/api/compte/cles');
    const presence = Object.fromEntries(cles.map((c) => [c.nom, c.renseignee]));
    liste.replaceChildren();

    for (const groupe of GROUPES) {
      const bloc = elem('div', 'groupe-cles');
      bloc.append(elem('h2', null, groupe.titre));

      for (const [nom, label, aide] of groupe.cles) {
        const ligne = elem('div', 'cle');

        const entete = elem('div', 'cle-entete');
        const etiquette = elem('label', null, label);
        etiquette.htmlFor = `cle-${nom}`;
        entete.append(etiquette);
        entete.append(elem('span', 'presence', presence[nom] ? 'enregistree' : 'non renseignee'));
        ligne.append(entete);

        const champ = elem('input');
        champ.type = 'password';
        champ.id = `cle-${nom}`;
        champ.autocomplete = 'off';
        // La valeur n'est JAMAIS renvoyee par le serveur : on annonce seulement si elle
        // est en place. Pre-remplir le champ ferait finir la passkey dans un cache.
        champ.placeholder = presence[nom]
          ? `${aide} — saisir pour remplacer, vider pour retirer`
          : aide;
        ligne.append(champ);

        // Zone de verdict, remplie par « Tester mes cles ».
        ligne.append(elem('div', 'cle-verdict', ''));
        bloc.append(ligne);
      }
      liste.append(bloc);
    }

    // Bloc Z-Library : adresse + mot de passe, DEUX cles distinctes en base. L'adresse
    // revient du serveur et pre-remplit le champ ; le mot de passe, jamais.
    const blocZ = elem('div', 'groupe-cles');
    blocZ.append(elem('h2', null, 'Z-Library — livres et bandes dessinees'));
    blocZ.append(elem('p', 'titres',
      "La recherche fonctionne sans compte. Les identifiants ne servent qu'a telecharger, "
      + 'et le quota quotidien est celui de VOTRE compte.'));

    let emailConnu = null;
    try {
      const z = await api('/api/compte/zlibrary');
      emailConnu = z.email;
    } catch {
      // Le compte reste utilisable meme si cette lecture echoue : le champ sera vide.
    }

    const ligneZ1 = elem('div', 'cle');
    const enteteZ1 = elem('div', 'cle-entete');
    const labZ1 = elem('label', null, 'Adresse e-mail');
    labZ1.htmlFor = 'cle-zlib_email';
    enteteZ1.append(labZ1);
    enteteZ1.append(elem('span', 'presence', emailConnu ? 'enregistree' : 'non renseignee'));
    ligneZ1.append(enteteZ1);
    const champZ1 = elem('input');
    champZ1.type = 'email';
    champZ1.id = 'cle-zlib_email';
    champZ1.autocomplete = 'off';
    champZ1.placeholder = 'vous@exemple.fr';
    if (emailConnu) champZ1.value = emailConnu;
    ligneZ1.append(champZ1);
    blocZ.append(ligneZ1);

    const ligneZ2 = elem('div', 'cle');
    const enteteZ2 = elem('div', 'cle-entete');
    const labZ2 = elem('label', null, 'Mot de passe');
    labZ2.htmlFor = 'cle-zlib_mdp';
    enteteZ2.append(labZ2);
    enteteZ2.append(elem('span', 'presence', presence.zlib_mdp ? 'enregistre' : 'non renseigne'));
    ligneZ2.append(enteteZ2);
    const champZ2 = elem('input');
    champZ2.type = 'password';
    champZ2.id = 'cle-zlib_mdp';
    champZ2.autocomplete = 'new-password';
    champZ2.placeholder = presence.zlib_mdp
      ? 'enregistre — saisir pour remplacer'
      : 'mot de passe Z-Library';
    ligneZ2.append(champZ2);
    // C'est ici que « Tester mes cles » pose son verdict : le couple est teste une fois.
    ligneZ2.append(elem('div', 'cle-verdict', ''));
    blocZ.append(ligneZ2);
    liste.append(blocZ);

    // Bloc Rustatio : URL + token optionnel, combines en une valeur JSON sous 'rustatio'.
    // L'input URL porte l'id `cle-rustatio` pour que poserVerdict/tester le trouvent.
    const blocR = elem('div', 'groupe-cles');
    blocR.append(elem('h2', null, 'Rustatio — seed anti-H&R'));
    const ligneR = elem('div', 'cle');
    const enteteR = elem('div', 'cle-entete');
    const labR = elem('label', null, 'Connexion Rustatio');
    labR.htmlFor = 'cle-rustatio';
    enteteR.append(labR);
    enteteR.append(elem('span', 'presence', presence.rustatio ? 'enregistree' : 'non renseignee'));
    ligneR.append(enteteR);
    // Deux champs dans un meme bloc : chacun porte son propre libelle. Une marque-place
    // disparait des qu'on saisit, et ne peut donc pas servir d'etiquette — c'est ce qui
    // rendait ce bloc illisible une fois rempli.
    const champ = (id, type, libelle, aide) => {
      const enveloppe = elem('div', 'champ');
      const l = elem('label', null, libelle);
      l.htmlFor = id;
      const i = elem('input');
      i.type = type;
      i.id = id;
      i.autocomplete = 'off';
      if (aide) i.placeholder = aide;
      enveloppe.append(l, i);
      return { enveloppe, input: i };
    };

    const url = champ('cle-rustatio', 'url', 'Adresse', 'http://172.17.0.1:8186');
    // L'adresse n'est pas un secret : on la pre-remplit. Le jeton, lui, ne revient jamais.
    const rustatioActuel = await api('/api/compte/rustatio').catch(() => ({ url: null }));
    if (rustatioActuel?.url) url.input.value = rustatioActuel.url;
    ligneR.append(url.enveloppe);

    const tok = champ('cle-rustatio-token', 'password', 'Jeton (facultatif)',
      'seulement si votre Rustatio exige une authentification');
    ligneR.append(tok.enveloppe);
    ligneR.append(elem('div', 'cle-verdict', ''));
    blocR.append(ligneR);
    liste.append(blocR);
  }

  function zoneVerdict(nom) {
    // `closest` et non `parentElement` : un champ peut etre enveloppe dans un `.champ`
    // pour porter son libelle, et le verdict vit au niveau du bloc `.cle`. Remonter d'un
    // seul cran ne le trouvait plus — le test de cle aurait paru muet, sans erreur.
    return document.getElementById(`cle-${nom}`)?.closest('.cle')?.querySelector('.cle-verdict');
  }

  function poserVerdict(nom, verdict) {
    const zone = zoneVerdict(nom);
    if (!zone) return;
    // Trois etats, comme partout ailleurs dans Mangaloo : en cours n'est ni un succes
    // ni un echec, et l'afficher en rouge le temps de la requete serait mentir.
    const etat = verdict === null ? '' : ` cle-verdict--${verdict.ok ? 'ok' : 'ko'}`;
    zone.className = `cle-verdict${etat}`;
    zone.replaceChildren();
    if (verdict === null) {
      zone.append(elem('span', null, 'test en cours…'));
      return;
    }
    zone.append(elem('span', 'marqueur', verdict.ok ? '\u25CF' : '\u25CB'));
    zone.append(elem('span', null, verdict.message));
    if (verdict.detail) zone.append(elem('span', 'detail', verdict.detail));
  }

  document.getElementById('tester').addEventListener('click', async (e) => {
    const bouton = e.currentTarget;
    bouton.disabled = true;
    bouton.textContent = 'test en cours…';
    sortie.replaceChildren();
    for (const nom of Object.keys(ETIQUETTES)) poserVerdict(nom, null);
    poserVerdict('rustatio', null);
    try {
      const { resultats } = await api('/api/compte/cles/tester', { method: 'POST' });
      for (const r of resultats) poserVerdict(r.nom, r);
      const echecs = resultats.filter((r) => !r.ok).length;
      sortie.replaceChildren(elem(
        'div',
        echecs === 0 ? 'message message--ok' : 'message',
        echecs === 0
          ? 'Toutes les cles repondent.'
          : `${resultats.length - echecs} cle(s) sur ${resultats.length} repondent. Le detail est sous chaque champ.`,
      ));
    } catch (err) {
      afficherErreur(sortie, err.message);
    } finally {
      bouton.disabled = false;
      bouton.textContent = 'Tester mes cles';
    }
  });

  document.getElementById('enregistrer').addEventListener('click', async () => {
    const corps = {};
    for (const nom of Object.keys(ETIQUETTES)) {
      const champ = document.getElementById(`cle-${nom}`);
      if (champ && champ.value !== '') corps[nom] = champ.value;
    }
    // Z-Library : deux cles independantes. Un champ vide est simplement omis — le mot
    // de passe deja enregistre n'est donc pas efface quand on ne corrige que l'adresse.
    for (const nom of ['zlib_email', 'zlib_mdp']) {
      const champ = document.getElementById(`cle-${nom}`);
      if (champ && champ.value.trim() !== '') corps[nom] = champ.value.trim();
    }
    // Rustatio : deux champs combines en une valeur JSON {url, token}.
    const rUrl = document.getElementById('cle-rustatio');
    if (rUrl && rUrl.value.trim() !== '') {
      const tok = document.getElementById('cle-rustatio-token');
      corps.rustatio = JSON.stringify({ url: rUrl.value.trim(), token: tok?.value.trim() || undefined });
    }
    if (Object.keys(corps).length === 0) {
      afficherErreur(sortie, 'aucune cle modifiee');
      return;
    }
    try {
      const r = await api('/api/compte/cles', { method: 'PUT', body: JSON.stringify(corps) });
      sortie.replaceChildren(elem('div', 'message message--ok', `${r.modifiees.length} cle(s) enregistree(s)`));
      await recharger();
    } catch (e) {
      afficherErreur(sortie, e.message);
    }
  });

  document.getElementById('changer-mdp').addEventListener('click', async () => {
    try {
      await api('/api/compte/motdepasse', {
        method: 'POST',
        body: JSON.stringify({
          ancien: document.getElementById('mdp-ancien').value,
          nouveau: document.getElementById('mdp-nouveau').value,
        }),
      });
      sortie.replaceChildren(elem('div', 'message message--ok',
        'Mot de passe change. Toutes les sessions sont fermees, reconnectez-vous.'));
      setTimeout(() => { location.href = '/login.html'; }, 2500);
    } catch (e) {
      afficherErreur(sortie, e.message);
    }
  });

  await recharger().catch((e) => afficherErreur(sortie, e.message));
}

async function pageAdmin() {
  bandeauCommun();
  const corps = document.getElementById('utilisateurs');
  const sortie = document.getElementById('sortie');

  async function recharger() {
    const { utilisateurs } = await api('/api/admin/utilisateurs');
    corps.replaceChildren();
    for (const u of utilisateurs) {
      const tr = elem('tr');
      tr.append(elem('td', null, u.login));
      tr.append(elem('td', null, u.role));
      tr.append(elem('td', null, new Date(u.creeLe).toISOString().slice(0, 10)));
      tr.append(elem('td', null, u.verrouilleJusqua > Date.now() ? 'verrouille' : `${u.echecs} echec(s)`));
      corps.append(tr);
    }
  }

  document.getElementById('creer').addEventListener('click', async () => {
    try {
      await api('/api/admin/utilisateurs', {
        method: 'POST',
        body: JSON.stringify({
          login: document.getElementById('nouveau-login').value,
          motDePasse: document.getElementById('nouveau-mdp').value,
          role: document.getElementById('nouveau-role').value,
        }),
      });
      sortie.replaceChildren(elem('div', 'message message--ok', 'Compte cree.'));
      await recharger();
    } catch (e) {
      afficherErreur(sortie, e.message);
    }
  });

  await recharger().catch((e) => afficherErreur(sortie, e.message));
}

const PAGES = {
  accueil: pageAccueil,
  oeuvre: pageOeuvre,
  connexion: pageConnexion,
  compte: pageCompte,
  admin: pageAdmin,
};

document.addEventListener('DOMContentLoaded', () => {
  const page = document.body.dataset.page;
  if (PAGES[page]) PAGES[page]();
});
