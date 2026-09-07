// A quelle famille appartient un fichier de fourtoutici, et que lui demander.
//
// LE SITE NOMME SA CATEGORIE EN TETE DU FICHIER — « MANGA Boruto… », « EBOOK … » — mais
// pas toujours : mesure du 2026-09-07 sur 199 resultats, 48 n'ont AUCUN prefixe, soit
// presque un quart. Se fier au seul prefixe en perdrait autant, ou les rangerait au
// hasard.
//
// D'ou la regle, qui est celle que ce depot applique deja aux formats : CE QUI EST NOMME
// PEUT EXCLURE, CE QUI EST MUET RESTE ADMIS. Un fichier dont la categorie contredit la
// famille demandee est ecarte ; un fichier sans categorie passe, et c'est le rapprochement
// par titre qui decidera de sa place.

/**
 * Prefixes releves le 2026-09-07 : EBOOK, MANGA, BD, MAGAZINE, JOURNAL, AUDIO, AUTRES.
 *
 * DEUX LETTRES SUFFISENT, et exiger trois coutait une categorie entiere : « BD » n'etait
 * reconnu nulle part, donc jamais ecarte d'une autre famille, et son titre gardait son
 * prefixe au moment du rapprochement. Un prefixe court inconnu ne risque rien : il ne
 * designe aucune famille, et reste donc admis partout.
 */
const RE_PREFIXE = /^([A-Z][A-Z0-9_-]{1,14})\s/;

/**
 * Les familles que designe un prefixe. Vide quand il n'en designe aucune.
 *
 * UN PREFIXE PEUT EN SERVIR PLUSIEURS, et l'oublier coutait cher : le site n'a pas de
 * categorie « COMICS » — mesure du 2026-09-07, « Walking Dead » sort en `BD`, et
 * `cat=COMICS` est ignore. Ranger `BD` dans la seule famille `bd` ecartait donc tous les
 * comics de la famille `comics`, sans que rien ne le signale.
 *
 * Les prefixes que le site n'emploie pas — COMICS, JOURNAUX — restent listes : ils ne
 * servent qu'a ECARTER, et un nom qui les porterait doit l'etre.
 */
const FAMILLES_DU_PREFIXE: Record<string, readonly string[]> = {
  EBOOK: ['livres'],
  MANGA: ['mangas'],
  BD: ['bd', 'comics'],
  COMICS: ['comics'],
  COMIC: ['comics'],
  JOURNAL: ['presse'],
  JOURNAUX: ['presse'],
  MAGAZINE: ['presse'],
  MAGAZINES: ['presse'],
  AUDIO: ['audio'],
};

/**
 * Les categories a demander au site pour une famille, dans l'ordre.
 *
 * POURQUOI FILTRER A LA SOURCE PLUTOT QU'AU RETOUR. `files.php` classe par pertinence et
 * rend 50 fichiers par page : mesure du 2026-09-07, « Elle » rend 297 fichiers dont les
 * deux seuls MAGAZINE ne paraissent sur aucune des six pages avant la fin. Trier apres
 * coup ne pouvait donc pas les trouver. Avec `cat=MAGAZINE`, ils arrivent tous les deux du
 * premier coup.
 *
 * N'Y METTRE QUE DES CATEGORIES VERIFIEES : une categorie inconnue n'est pas refusee, elle
 * est IGNOREE — `cat=COMICS` rend la recherche non filtree, ce qui se lirait a tort comme
 * un resultat. Vide vaut « demander sans filtre », et c'est le tri au retour qui decide.
 */
const CATEGORIES_DE_FAMILLE: Record<string, readonly string[]> = {
  livres: ['EBOOK'],
  mangas: ['MANGA'],
  bd: ['BD'],
  comics: ['BD'],
  presse: ['MAGAZINE', 'JOURNAL'],
  audio: ['AUDIO'],
};

/** Les categories a interroger pour cette famille. Vide : interroger sans filtre. */
export function categoriesInterrogeables(famille: string): readonly string[] {
  return CATEGORIES_DE_FAMILLE[String(famille || '')] ?? [];
}

/**
 * La categorie annoncee par le nom, en majuscules, ou `null`.
 *
 * « AUTRES » est une categorie du site, mais elle ne designe aucune famille : elle est
 * donc lue — pour ne pas la confondre avec un titre — et rendue telle quelle.
 */
export function categorieDeNom(nom: string): string | null {
  const m = RE_PREFIXE.exec(String(nom || '').trim());
  return m ? m[1] : null;
}

/**
 * Ce fichier a-t-il sa place dans cette famille ?
 *
 * Vrai quand la categorie designe cette famille, ET quand elle n'en designe aucune —
 * prefixe absent, ou prefixe inconnu comme « AUTRES ». Faux dans le seul cas ou elle en
 * designe une AUTRE : c'est la seule information dont on soit sur.
 */
export function sertLaFamille(nom: string, famille: string): boolean {
  const cat = categorieDeNom(nom);
  if (!cat) return true;
  const visees = FAMILLES_DU_PREFIXE[cat];
  if (!visees) return true;
  return visees.includes(famille);
}

/** Le titre sans son prefixe de categorie : « MANGA Boruto… » se lit « Boruto… ». */
export function titreSansCategorie(nom: string): string {
  const brut = String(nom || '').trim();
  const cat = categorieDeNom(brut);
  return cat && FAMILLES_DU_PREFIXE[cat] !== undefined
    ? brut.slice(cat.length).trim()
    : brut;
}
