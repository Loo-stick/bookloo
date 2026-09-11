// Surcouche de release : la liste des tomes, dans sa propre surface.
//
// POURQUOI ELLE EXISTE. Le panneau s'ouvrait DANS la carte, et rien ne le refermait. Une
// table de cent tomes poussait donc la page sans retour possible, et plusieurs releases
// ouvertes s'empilaient. Ce que ce panneau contient n'est pas un detail a consulter mais
// une TACHE — choisir un service, cocher des tomes, lancer une lecture — et une tache
// merite sa propre surface.
//
// ELLE EMPRUNTE TOUT A LA VISIONNEUSE : meme fermeture, meme touche Echap, meme
// verrouillage du defilement. Deux grammaires differentes pour deux surcouches donneraient
// l'impression de deux applications.

(function () {
  function el(balise, classe, texte) {
    const e = document.createElement(balise);
    if (classe) e.className = classe;
    if (texte !== undefined) e.textContent = texte;
    return e;
  }

  /**
   * Ouvre une surcouche et rend de quoi ecrire dedans.
   *
   * `corps` est la zone ou l'appelant depose son contenu — exactement ce qu'il ecrivait
   * dans la carte auparavant, donc rien a reapprendre de son cote.
   */
  function ouvrir({ titre, sousTitre, surFermeture }) {
    const surcouche = el('div', 'panneau');
    surcouche.setAttribute('role', 'dialog');
    surcouche.setAttribute('aria-modal', 'true');
    surcouche.setAttribute('aria-label', titre || 'Details de la release');

    const boite = el('div', 'panneau-boite');
    const entete = el('div', 'panneau-entete');
    const textes = el('div');
    textes.append(el('div', 'nom', titre || ''));
    if (sousTitre) textes.append(el('div', 'resume', sousTitre));
    const fermerBouton = el('button', 'discret', 'Fermer');
    entete.append(textes, fermerBouton);

    const corps = el('div', 'panneau-corps');
    boite.append(entete, corps);
    surcouche.append(boite);

    const defilementAvant = document.body.style.overflow;
    let ferme = false;

    function fermer() {
      if (ferme) return;
      ferme = true;
      document.removeEventListener('keydown', auClavier);
      surcouche.remove();
      // Sans cela, la page dessous et la surcouche defileraient toutes les deux.
      document.body.style.overflow = defilementAvant;
      if (typeof surFermeture === 'function') surFermeture();
    }

    function auClavier(e) {
      // Echap ne ferme QUE si aucune visionneuse n'est ouverte par-dessus : sinon on
      // retirerait le panneau sous les pieds du lecteur, qui reviendrait a la liste des
      // resultats au lieu de sa liste de tomes.
      if (e.key !== 'Escape') return;
      if (document.querySelector('.visionneuse')) return;
      e.preventDefault();
      fermer();
    }

    fermerBouton.addEventListener('click', fermer);
    // Cliquer le fond ferme, comme partout. Cliquer la boite ne doit rien fermer.
    surcouche.addEventListener('click', (e) => { if (e.target === surcouche) fermer(); });
    document.addEventListener('keydown', auClavier);

    document.body.style.overflow = 'hidden';
    document.body.append(surcouche);
    fermerBouton.focus();

    return { corps, fermer };
  }

  window.Panneau = { ouvrir };
})();
