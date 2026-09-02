// Lecture d'un EPUB.
//
// UN EPUB EST UN ZIP, et le lecteur du projet l'ouvre deja. Sonde du 2026-08-25 sur un
// livre reel : 43 entrees, `META-INF/container.xml` designant l'OPF, un `spine` de 34
// elements, des chapitres XHTML. `lireEntree` decompresse les methodes 0 et 8, les deux
// seules qu'un EPUB emploie. Rien de tout cela n'est a reecrire.
//
// CE FICHIER NE FAIT AUCUN ACCES — ni reseau, ni disque. Il recoit du texte et rend du
// texte, ce qui le rend testable sur fixture, et c'est la partie ou une erreur coute le
// plus cher : elle finit dans le DOM d'une page authentifiee.

/** Un chapitre, dans l'ordre de lecture. */
export interface ChapitreEpub {
  id: string;
  /** Chemin DANS l'archive, prefixe du dossier de l'OPF. */
  chemin: string;
}

export interface LivreEpub {
  titre?: string;
  auteur?: string;
  chapitres: ChapitreEpub[];
}

/** Le chemin de l'OPF, designe par `META-INF/container.xml`. */
export function cheminOpf(containerXml: string): string | null {
  const m = /<rootfile[^>]*\sfull-path="([^"]+)"/.exec(containerXml || '');
  return m ? m[1] : null;
}

/** Le dossier d'un chemin d'archive : « OEBPS/content.opf » -> « OEBPS ». */
export function dossierDe(chemin: string): string {
  const i = chemin.lastIndexOf('/');
  return i === -1 ? '' : chemin.slice(0, i);
}

/** Recolle un chemin relatif sur son dossier, en resolvant les « .. ». */
function joindre(base: string, relatif: string): string {
  const morceaux = (base ? base.split('/') : []).concat(relatif.split('/'));
  const pile: string[] = [];
  for (const m of morceaux) {
    if (!m || m === '.') continue;
    if (m === '..') pile.pop();
    else pile.push(m);
  }
  return pile.join('/');
}

/** Types MIME qui sont des documents lisibles. Le reste n'est pas un chapitre. */
const MEDIA_DOCUMENT = /^(?:application\/xhtml\+xml|text\/html)$/i;

/**
 * Le livre, lu dans son OPF.
 *
 * L'ORDRE VIENT DU `spine`, PAS DU MANIFESTE. Le manifeste est un inventaire — images,
 * feuilles de style et chapitres melanges, dans un ordre quelconque. Le `spine` est
 * l'ordre de LECTURE. Les confondre donnerait un livre dont les chapitres s'enchainent au
 * hasard, ce qui ne se voit pas sur un test et se voit tout de suite a la lecture.
 */
export function lireOpf(xml: string, dossier: string): LivreEpub | null {
  if (!xml) return null;

  const items = new Map<string, { href: string; media: string }>();
  for (const m of xml.matchAll(/<item\s([^>]*?)\/?>/g)) {
    const attrs = m[1];
    // `(?:^|\s)` et non `\s` : le premier attribut d'une balise n'a rien devant lui.
    // Exiger une espace faisait manquer TOUS les items dont `href` ouvrait la balise —
    // c'est-a-dire tous ceux de l'echantillon reel, et le livre sortait sans un chapitre.
    const attr = (nom: string) =>
      new RegExp(`(?:^|\\s)${nom}="([^"]*)"`).exec(attrs)?.[1];
    const id = attr('id');
    const href = attr('href');
    if (!id || !href) continue;
    items.set(id, { href, media: attr('media-type') ?? '' });
  }

  const spine = /<spine[^>]*>([\s\S]*?)<\/spine>/.exec(xml)?.[1] ?? '';
  const chapitres: ChapitreEpub[] = [];
  for (const m of spine.matchAll(/<itemref[^>]*?(?:^|\s)idref="([^"]+)"/g)) {
    const item = items.get(m[1]);
    // Un idref orphelin est ignore : jeter ferait perdre le livre entier pour une entree
    // abimee. Une image ou une feuille de style egaree dans le spine n'est pas un
    // chapitre non plus — l'afficher rendrait un ecran vide au milieu du livre.
    if (!item || !MEDIA_DOCUMENT.test(item.media)) continue;
    chapitres.push({ id: m[1], chemin: joindre(dossier, item.href) });
  }

  const texte = (balise: string) =>
    new RegExp(`<(?:dc:)?${balise}[^>]*>([^<]+)<`, 'i').exec(xml)?.[1]?.trim() || undefined;

  return { titre: texte('title'), auteur: texte('creator'), chapitres };
}

/**
 * Le titre d'un chapitre, ou `null`.
 *
 * LE PREMIER INTERTITRE D'ABORD, PAS LA BALISE `<title>`. Mesure sur un EPUB reel : les
 * 34 chapitres portent le meme `<title>` — « Le Comte de Monte-Cristo Tome I | Project
 * Gutenberg », c'est-a-dire le titre du LIVRE. Un sommaire construit dessus aurait
 * affiche trente-quatre fois la meme ligne. Les vrais titres sont dans les `<h1>`/`<h2>` :
 * « I », « II », « III ».
 *
 * `<title>` reste le repli : certains EPUB y mettent un titre de chapitre utile, et un
 * chapitre sans intertitre — une couverture, une page de garde — n'en a pas d'autre.
 *
 * On n'invente rien : sans les deux, l'appelant affichera « Chapitre 3 ».
 */
export function titreDeChapitre(xhtml: string): string | null {
  const texte = (brut: string | undefined) =>
    brut?.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() || null;
  const corps = /<body[\s\S]*/i.exec(xhtml || '')?.[0] ?? (xhtml || '');
  return texte(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]\s*>/i.exec(corps)?.[1])
    ?? texte(/<title[^>]*>([^<]*)</i.exec(xhtml || '')?.[1]);
}

// Balises retirees AVEC leur contenu : ce qu'elles portent n'est pas du texte a lire.
const AVEC_CONTENU = /<(script|style|iframe|object|embed|form|noscript|template|svg|math)\b[\s\S]*?<\/\1\s*>/gi;
// Les memes, non fermees, plus les balises de structure du document hote.
// `svg` et `math` s'y ajoutent : ce sont des espaces de noms ETRANGERS, ou les regles
// d'analyse changent — `<svg><script>` n'est pas le `<script>` du HTML, et une balise
// `<animate>` sait viser un attribut. Un chapitre de livre n'en a aucun besoin.
const BALISES_SEULES = /<\/?(script|style|iframe|object|embed|form|input|button|select|textarea|link|meta|base|html|head|body|title|svg|math|frame|frameset|applet|portal)\b[^>]*>/gi;

/**
 * Cette adresse est-elle sure a laisser dans un chapitre ?
 *
 * ON DECODE D'ABORD. Le navigateur decode les entites HTML avant d'interpreter le schema :
 * comparer le texte litteral revient a filtrer autre chose que ce qui sera execute.
 *
 * Puis LISTE BLANCHE : http, https, et les adresses internes au livre — relatives ou
 * ancres. Tout le reste part, y compris ce qu'on n'a pas su lire. Une liste noire
 * demanderait de prevoir chaque graphie ; une liste blanche demande seulement de savoir ce
 * qu'on veut.
 */
export function schemaAutorise(valeur: string | undefined): boolean {
  // Entites hexadecimales, numeriques et nommees usuelles, puis blancs de toute nature :
  // « java&#115;cript: », « &#x6a;avascript: » et « java<tab>script: » doivent tous se
  // ramener a la meme chaine avant d'etre juges.
  const nommees: Record<string, string> = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", colon: ':', tab: '\t', newline: '\n',
  };
  const decode = String(valeur ?? '')
    .replace(/&#x([0-9a-f]+);?/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);?/g, (_m, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (_m, n) => nommees[String(n).toLowerCase()] ?? '')
    .replace(/[\s\u0000-\u001f\u007f]/g, '')
    .toLowerCase();

  // Pas de schema du tout : adresse relative ou ancre, donc interne au livre.
  const schema = /^([a-z][a-z0-9+.-]*):/.exec(decode);
  if (!schema) return true;
  return schema[1] === 'http' || schema[1] === 'https';
}

/**
 * Un chapitre, ramene a un fragment HTML sur.
 *
 * LE NETTOYAGE EST OBLIGATOIRE, MEME SUR UN LIVRE PROPRE. L'echantillon sonde n'avait ni
 * script ni gestionnaire d'evenement — mais un EPUB est un fichier fourni par un TIERS,
 * et son contenu finit injecte dans le DOM d'une page authentifiee. Le jour ou un livre
 * en portera, ce sera trop tard pour s'en apercevoir.
 *
 * LA FEUILLE DE STYLE DU LIVRE EST ECARTEE, et c'est un choix. Elle peut positionner des
 * elements hors de la page, elle rend chaque livre different alors que le confort de
 * lecture doit etre constant, et l'ecarter supprime toute question de style tiers.
 *
 * `resoudre` reecrit les adresses d'images : une `src` relative pointerait vers un chemin
 * qui n'existe pas cote serveur.
 */
export function nettoyerChapitre(xhtml: string, resoudre: (src: string) => string): string {
  // La declaration XML et les commentaires d'abord : ils peuvent cacher n'importe quoi.
  let h = String(xhtml || '')
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '');

  // JUSQU'A CE QUE PLUS RIEN NE BOUGE.
  //
  // Une passe unique se laisse reconstituer : « <scr<link>ipt src=x> » perdait son
  // « <link> » et redevenait « <script src=x> ». Verifie en executant la fonction le
  // 2026-09-02 — trois formes passaient, dont `<iframe srcdoc>`. `BALISES_SEULES` passant
  // APRES `AVEC_CONTENU`, une balise du second lot recomposait une balise du premier, que
  // plus rien ne relisait.
  //
  // La boucle est bornee : chaque tour retire au moins un caractere, donc elle se termine.
  for (let avant = ''; avant !== h;) {
    avant = h;
    h = h.replace(AVEC_CONTENU, '').replace(BALISES_SEULES, '');
  }

  // LES GESTIONNAIRES D'EVENEMENTS, ET LE SEPARATEUR N'EST PAS QUE L'ESPACE.
  //
  // Les trois expressions exigeaient `\s` devant le `on…`. HTML accepte aussi la barre
  // oblique comme separateur d'attributs : « <img/onerror=alert(1) src=x> » traversait le
  // filtre intact. Verifie en executant la fonction le 2026-09-02.
  h = h.replace(/[\s/]on[a-z]+\s*=\s*"[^"]*"/gi, ' ')
    .replace(/[\s/]on[a-z]+\s*=\s*'[^']*'/gi, ' ')
    .replace(/[\s/]on[a-z]+\s*=\s*[^\s>]+/gi, ' ');

  // LES ADRESSES : UNE LISTE BLANCHE DE SCHEMAS, PAS UNE LISTE NOIRE DE MOTS.
  //
  // La liste noire cherchait « javascript: » dans le texte litteral, sans jamais decoder les
  // entites — or le navigateur les decode AVANT d'interpreter le schema. Verifie en
  // executant le filtre le 2026-08-29 : « &#106;avascript: », « java&#115;cript: » et
  // « &#74;avaScript: » passaient tous les trois intacts.
  //
  // Une liste noire ne peut pas gagner cette course : il y aura toujours une graphie de
  // plus. On n'autorise donc QUE ce qu'on comprend, et l'attribut entier part sinon — le
  // vider laisserait un lien mort, le retirer laisse un texte lisible.
  //
  // ET LA VALEUR N'EST PAS TOUJOURS ENTRE GUILLEMETS. L'expression n'acceptait que les
  // formes guillemetees : « <a href=javascript:alert(1)> » n'etait meme pas presente a
  // `schemaAutorise`, qui pourtant le refuse. Le filtre etait juste, il n'etait pas
  // atteint. Verifie en executant la fonction le 2026-09-02.
  h = h.replace(
    /[\s/](?:href|src|xlink:href)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
    (tout, guill, apos, nu) => {
      const valeur = guill !== undefined ? guill : apos !== undefined ? apos : nu;
      return schemaAutorise(valeur) ? tout : ' ';
    },
  );

  // Les images, vers la route qui les sert depuis l'archive.
  h = h.replace(/(<img\b[^>]*?\ssrc\s*=\s*)"([^"]*)"/gi, (_t, avant, src) => `${avant}"${resoudre(src)}"`)
    .replace(/(<img\b[^>]*?\ssrc\s*=\s*)'([^']*)'/gi, (_t, avant, src) => `${avant}"${resoudre(src)}"`);

  return h.trim();
}
