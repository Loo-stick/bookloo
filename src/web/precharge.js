// Le prechargement d'un fichier LibGen, vu de l'interface.
//
// POURQUOI UNE ATTENTE AVANT LA LISEUSE. Le CDN de LibGen rend 14 a 400 Ko/s (mesure du
// 2026-09-15) : lire une planche a distance prenait 19 s. Le serveur rapatrie donc le
// fichier en entier, et la liseuse ne s'ouvre qu'ensuite, sur une copie locale. Cette
// attente peut durer plusieurs minutes : elle se VOIT, avec ce qui est arrive et ce qui reste.
//
// LE TELECHARGEMENT VIT SUR LE SERVEUR. Fermer la page ne l'arrete pas ; revenir et cliquer
// « Lire » reprend la barre la ou elle en est.
//
// Les libelles sont PURS et testes ; `attendre` touche le DOM et le reseau.

(function () {
  const MO = 1024 * 1024;

  function mo(octets) {
    const v = octets / MO;
    return v < 10 ? v.toFixed(1).replace('.', ',') : String(Math.round(v));
  }

  /** Octets par seconde, d'apres les derniers releves. 0 tant qu'il n'y a pas de quoi juger. */
  function debitDe(releves) {
    if (!Array.isArray(releves) || releves.length < 2) return 0;
    const premier = releves[0];
    const dernier = releves[releves.length - 1];
    const secondes = (dernier.t - premier.t) / 1000;
    // Moins de trois secondes d'observation : une estimation qui sauterait de 2 a 40 min.
    if (secondes < 3) return 0;
    return Math.max(0, (dernier.recus - premier.recus) / secondes);
  }

  function reste(secondes) {
    if (secondes < 60) return 'moins d une minute restante';
    const minutes = Math.round(secondes / 60);
    if (minutes < 60) return `environ ${minutes} min restantes`;
    return `environ ${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} restantes`;
  }

  /** Ce qu'on affiche pour un etat rendu par `/api/libgen/precharge`. */
  function libelleAvancee(etat, debit) {
    if (!etat || etat.etat === 'absent') return 'prechargement depuis LibGen…';
    if (etat.etat === 'en-attente') return 'en file d attente : d autres fichiers LibGen se prechargent deja…';
    if (etat.etat === 'pret') return 'fichier pret';
    if (etat.etat === 'echec') return etat.erreur || 'le prechargement a echoue';
    if (!etat.taille) return 'prechargement depuis LibGen — connexion au serveur de fichiers…';
    const recus = etat.recus || 0;
    const pourcent = Math.min(100, Math.floor((100 * recus) / etat.taille));
    let texte = `prechargement depuis LibGen — ${pourcent} %, ${mo(recus)} / ${mo(etat.taille)} Mo`;
    if (debit > 0) texte += `, ${reste((etat.taille - recus) / debit)}`;
    return texte;
  }

  const pause = (ms) => new Promise((z) => { setTimeout(z, ms); });

  /**
   * Lance le prechargement et attend qu'il soit fini, en affichant l'avancee dans `zone`.
   *
   * Rend `true` quand le fichier est pret, `false` si la zone a quitte la page entre-temps
   * (panneau ferme) — le serveur, lui, continue. LEVE sur un echec, avec la raison.
   */
  async function attendre({ identite, zone, api, intervalleMs = 1500 }) {
    const bloc = document.createElement('div');
    bloc.className = 'precharge';
    const texte = document.createElement('div');
    const jauge = document.createElement('div');
    jauge.className = 'jauge';
    const barre = document.createElement('div');
    barre.className = 'jauge-barre';
    jauge.append(barre);
    bloc.append(texte, jauge);
    texte.textContent = libelleAvancee(null, 0);
    zone.replaceChildren(bloc);

    let etat = await api('/api/libgen/precharge', { method: 'POST', body: JSON.stringify({ identite }) });
    const releves = [];
    for (;;) {
      if (!bloc.isConnected) return false;
      if (etat.etat === 'pret') {
        zone.replaceChildren();
        return true;
      }
      if (etat.etat === 'echec') throw new Error(etat.erreur || 'le prechargement a echoue');
      if (etat.etat === 'en-cours') {
        releves.push({ t: Date.now(), recus: etat.recus || 0 });
        // Les vingt derniers releves, soit une trentaine de secondes : le debit de LibGen
        // change d'une minute a l'autre, une moyenne depuis le debut mentirait.
        if (releves.length > 20) releves.shift();
      }
      texte.textContent = libelleAvancee(etat, debitDe(releves));
      barre.style.width = etat.taille ? `${Math.min(100, Math.floor((100 * (etat.recus || 0)) / etat.taille))}%` : '0%';
      await pause(intervalleMs);
      if (!bloc.isConnected) return false;
      etat = await api(`/api/libgen/precharge?identite=${encodeURIComponent(identite)}`);
      // Un etat « absent » apres un lancement : le serveur a redemarre. On relance.
      if (etat.etat === 'absent') {
        etat = await api('/api/libgen/precharge', { method: 'POST', body: JSON.stringify({ identite }) });
      }
    }
  }

  if (typeof module !== 'undefined') module.exports = { libelleAvancee, debitDe };
  if (typeof window !== 'undefined') window.Precharge = { attendre };
})();
