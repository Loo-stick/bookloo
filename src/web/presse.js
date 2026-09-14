// Le kiosque : trois onglets, une liste qui se remplit au fil des sites.
//
// La rubrique arrive en flux — bookys met quinze secondes la ou les deux autres en mettent
// une — donc la liste se retrie a chaque arrivee au lieu d'attendre le dernier.

(() => {
  if (document.body.dataset.page !== 'presse') return;

  const onglets = document.getElementById('onglets');
  const sites = document.getElementById('sites');
  const zoneCategories = document.getElementById('categories');
  const zone = document.getElementById('numeros');

  const el = (balise, classe, texte) => {
    const e = document.createElement(balise);
    if (classe) e.className = classe;
    if (texte !== undefined) e.textContent = texte;
    return e;
  };

  let courant = 'journaux';
  let annulation = null;

  function afficher(numeros) {
    if (numeros.length === 0) {
      zone.replaceChildren(el('div', 'vide', 'rien pour l instant'));
      return;
    }
    const table = el('div', 'kiosque');
    for (const n of numeros) {
      const ligne = el('div', 'kiosque-ligne');
      ligne.append(el('span', 'kiosque-date', dateLisible(n.date) || '—'));
      const titre = el('span', 'kiosque-titre', n.titre);
      titre.title = n.brut;
      ligne.append(titre);
      ligne.append(el('span', 'kiosque-sites', n.sites.map((s) => s.site).join(', ')));

      // PAS DE BOUTON « LIRE ». Un magazine est un PDF ; la visionneuse affiche des
      // planches d'archive. Un bouton qui echoue apres une attente vaut moins qu'un
      // bouton absent — la regle est deja celle du depot pour les formats non lisibles.
      // LE KIOSQUE NE REFAIT PAS LE CHEMIN, IL Y MENE. Ce bouton envoyait vers
      // « /oeuvre.html?libre=…&ddl=… », deux parametres que rien ne lisait : on atterrissait
      // sur une page vide. Et meme repare, ce chemin aurait double celui des autres
      // familles.
      //
      // La presse EST une famille depuis le 2026-09-01. Ouvrir un numero, c'est donc lancer
      // la recherche normale sur son titre — avec ses cartes, sa verification de cache, son
      // panneau, son « Lire » et ses regles de ratio. Rien de tout cela n'est a reecrire.
      const prendre = el('button', 'discret', 'Ouvrir');
      prendre.addEventListener('click', () => {
        location.href = `/index.html?famille=presse&q=${encodeURIComponent(n.titre)}`;
      });
      ligne.append(prendre);
      table.append(ligne);
    }
    zone.replaceChildren(table);
  }

  function pastille(site, etat) {
    // Trois etats, et ils ne disent PAS la meme chose : « n'a pas repondu » est une panne,
    // « ne sait pas chercher » est une limite du site, et le silence est une reponse.
    if (etat === 'echec') return el('span', 'puce puce-echec', `${site} : n a pas repondu`);
    if (etat === 'sans-recherche') return el('span', 'puce puce-echec', `${site} : ne sait pas chercher`);
    return el('span', 'puce', site);
  }

  async function charger(rubrique, categorie, terme) {
    if (annulation) annulation.abort();
    annulation = new AbortController();
    sites.replaceChildren();
    zone.replaceChildren(el('div', 'vide', 'consultation des sites…'));

    const url = terme
      ? `/api/presse/flux?q=${encodeURIComponent(terme)}`
      : `/api/presse/flux?rubrique=${encodeURIComponent(rubrique)}`
        + (categorie ? `&categorie=${encodeURIComponent(categorie)}` : '');
    let recus = [];
    try {
      const r = await fetch(url, {
        headers: { Accept: 'application/x-ndjson' },
        signal: annulation.signal,
      });
      if (r.status === 401) { location.href = '/login.html'; return; }
      if (!r.ok || !r.body) throw new Error(`le serveur a repondu ${r.status}`);

      const lecteur = r.body.getReader();
      const decodeur = new TextDecoder();
      let reste = '';
      for (;;) {
        const { done, value } = await lecteur.read();
        if (done) break;
        const lignes = (reste + decodeur.decode(value, { stream: true })).split('\n');
        reste = lignes.pop() || '';
        for (const l of lignes) {
          if (!l.trim()) continue;
          let ligne;
          try { ligne = JSON.parse(l); } catch { continue; }
          if (ligne.type !== 'site') continue;
          sites.append(pastille(ligne.libelle, ligne.etat));
          recus.push(ligne.numeros || []);
          // On RETRIE a chaque arrivee : attendre le dernier site annulerait l'interet
          // du flux, puisque c'est le plus lent qui le retarde.
          afficher(fusionnerNumeros(recus));
        }
      }
      if (recus.every((x) => x.length === 0)) afficher([]);
    } catch (e) {
      if (e.name === 'AbortError') return;
      zone.replaceChildren(el('div', 'vide', e.message));
    }
  }

  async function chargerTitres() {
    sites.replaceChildren(el('span', 'puce', 'source : bookys uniquement'));
    zone.replaceChildren();
    zoneCategories.hidden = false;
    zoneCategories.replaceChildren(el('div', 'vide', 'lecture des categories…'));
    try {
      const r = await fetch('/api/presse/categories');
      if (r.status === 401) { location.href = '/login.html'; return; }
      const { categories } = await r.json();
      const groupes = new Map();
      for (const c of categories || []) {
        if (!groupes.has(c.rubrique)) groupes.set(c.rubrique, []);
        groupes.get(c.rubrique).push(c);
      }
      const sortie = el('div');
      for (const [rubrique, liste] of groupes) {
        sortie.append(el('h2', 'kiosque-groupe', rubrique));
        const rangee = el('div', 'choix-service');
        for (const c of liste) {
          const b = el('button', null, c.libelle);
          b.type = 'button';
          b.addEventListener('click', () => {
            zoneCategories.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', 'false'));
            b.setAttribute('aria-pressed', 'true');
            charger(rubrique === 'journaux' ? 'journaux' : 'magazines', `${rubrique}/${c.slug}`);
          });
          rangee.append(b);
        }
        sortie.append(rangee);
      }
      zoneCategories.replaceChildren(sortie);
      zone.replaceChildren(el('div', 'vide', 'choisissez un titre ou un theme'));
    } catch {
      zoneCategories.replaceChildren(el('div', 'vide', 'les categories n ont pas pu etre lues'));
    }
  }

  onglets.addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-onglet]');
    if (!b) return;
    courant = b.dataset.onglet;
    for (const x of onglets.querySelectorAll('button')) {
      x.setAttribute('aria-pressed', String(x === b));
    }
    if (courant === 'titres') { chargerTitres(); return; }
    zoneCategories.hidden = true;
    document.getElementById('q').value = '';
    charger(courant, null, null);
  });

  document.getElementById('recherche').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const terme = document.getElementById('q').value.trim();
    // Un champ vide RAMENE au parcours : c'est le geste naturel pour revenir en arriere,
    // et le refuser laisserait l'utilisateur devant ses resultats sans porte de sortie.
    zoneCategories.hidden = true;
    charger(courant === 'titres' ? 'journaux' : courant, null, terme || null);
  });

  charger('journaux', null, null);
})();
