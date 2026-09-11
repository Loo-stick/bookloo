// Rendre le CHANGELOG, et rien d'autre.
//
// UN SOUS-ENSEMBLE DELIBERE, pas un moteur Markdown. Le seul document rendu est ecrit dans
// ce depot : porter une dependance — et sa surface de faille — pour six formes serait payer
// cher un probleme qu'on n'a pas.
//
// L'ECHAPPEMENT PASSE AVANT TOUT LE RESTE, et c'est la seule regle qui compte ici. Le rendu
// produit du HTML ; si le texte pouvait en devenir, une note de version deviendrait un jour
// une porte d'entree. On echappe donc le document ENTIER d'abord, puis on n'introduit que
// les balises qu'on decide.

const ECHAPPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function echapper(t) {
  return String(t).replace(/[&<>"']/g, (c) => ECHAPPES[c]);
}

/** Les formes en ligne, appliquees a du texte DEJA echappe. */
function enLigne(t) {
  return t
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

/**
 * Le HTML d'un document Markdown restreint : titres, gras, code, listes, blocs de code.
 *
 * Tout ce qui n'est reconnu par aucune de ces formes devient un paragraphe. Rien n'est
 * jamais rendu tel quel.
 */
function rendreMarkdown(texte) {
  if (!texte) return '';
  const lignes = String(texte).split('\n');
  const sortie = [];
  let liste = [];
  let bloc = null;

  const viderListe = () => {
    if (liste.length) { sortie.push(`<ul>${liste.join('')}</ul>`); liste = []; }
  };

  for (const brute of lignes) {
    const l = brute.replace(/\s+$/, '');

    // Un bloc de code garde son contenu MOT POUR MOT — echappe, mais sans mise en forme :
    // une commande d'installation ne doit pas voir ses etoiles interpretees.
    if (l.trim().startsWith('```')) {
      if (bloc === null) { viderListe(); bloc = []; } else {
        sortie.push(`<pre><code>${bloc.join('\n')}</code></pre>`);
        bloc = null;
      }
      continue;
    }
    if (bloc !== null) { bloc.push(echapper(l)); continue; }

    if (!l.trim()) { viderListe(); continue; }

    const titre = /^(#{1,4})\s+(.*)$/.exec(l);
    if (titre) {
      viderListe();
      const n = titre[1].length;
      sortie.push(`<h${n}>${enLigne(echapper(titre[2]))}</h${n}>`);
      continue;
    }

    const puce = /^[-*]\s+(.*)$/.exec(l);
    if (puce) { liste.push(`<li>${enLigne(echapper(puce[1]))}</li>`); continue; }

    viderListe();
    sortie.push(`<p>${enLigne(echapper(l))}</p>`);
  }

  viderListe();
  // Un bloc de code jamais referme : on rend ce qu'on a plutot que de le perdre.
  if (bloc !== null) sortie.push(`<pre><code>${bloc.join('\n')}</code></pre>`);
  return sortie.join('');
}

/**
 * Le journal des versions, chaque version dans un volet.
 *
 * Cinq versions tiennent sur une page ; trente n'y tiendront pas. Le volet garde le journal
 * lisible quel que soit leur nombre — sans rien cacher : tout est la, replie.
 *
 * La plus recente est OUVERTE. C'est celle qu'on vient lire ; obliger a un clic pour voir
 * ce qui vient de changer serait mettre un obstacle devant la seule raison d'ouvrir la page.
 *
 * Ce qui precede la premiere version — le titre, l'introduction, le lien vers les notes
 * completes — reste hors des volets : ca doit se lire sans rien deplier.
 */
function rendreJournal(texte) {
  const lignes = String(texte || '').split('\n');
  const entete = [];
  const versions = [];

  for (const l of lignes) {
    const titre = /^##\s+(.*)$/.exec(l);
    if (titre) { versions.push({ titre: titre[1], corps: [] }); continue; }
    if (versions.length) versions[versions.length - 1].corps.push(l);
    else entete.push(l);
  }

  const html = [rendreMarkdown(entete.join('\n'))];
  for (const [i, v] of versions.entries()) {
    // `echapper` sur le titre : il finit dans un `summary`, et la regle ne change pas
    // parce que la balise change.
    html.push(
      `<details${i === 0 ? ' open' : ''}><summary>${echapper(v.titre)}</summary>`
      + `${rendreMarkdown(v.corps.join('\n'))}</details>`,
    );
  }
  return html.join('');
}

if (typeof module !== 'undefined') {
  module.exports = { rendreMarkdown, rendreJournal, echapper };
}
