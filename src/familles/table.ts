// Les familles d'ouvrages, et ce que chacune sait interroger.
//
// POURQUOI LES CATEGORIES SONT PAR SOURCE. Sonde `t=caps` du 2026-08-22 : Ygg emploie sa
// propre serie 71xx (7100 Livres, 7102 BD, 7103 Mangas, 7104 Comics) la ou C411 et Tr4ker
// suivent la norme Torznab (7020 Ebook, 7030 Comics, 3030 Audiobook). Une categorie
// globale enverrait donc un numero inconnu a un tracker sur deux — qui rendrait zero
// resultat, sans erreur et sans explication.
//
// AJOUTER UNE FAMILLE, C'EST EDITER CETTE TABLE. Rien d'autre.

// IMPORT DE TYPE, ET IL DOIT LE RESTER. `sources/types.ts` importe `Famille` d'ici :
// les deux fichiers se citent donc mutuellement. C'est sans consequence tant que les
// deux cotes sont des `import type`, que TypeScript efface a l'emission. En faire un
// import de valeur creerait un vrai cycle au chargement.
import type { Format } from '../sources/types';

export type IdFamille = 'mangas' | 'comics' | 'bd' | 'livres' | 'audio';

export interface Famille {
  id: IdFamille;
  libelle: string;
  /**
   * Catalogues a interroger, DANS L'ORDRE. Le premier qui rend quelque chose gagne.
   *
   * Une liste et non un seul nom, parce qu'aucune source ne couvre les livres a elle
   * seule : Booknode apporte la serie, le tome et le fonds recent, mais c'est du scraping
   * derriere un pare-feu Cloudflare — il tombera un jour. Open Library derriere lui est
   * plus pauvre et plus sur. Une liste vide signifie recherche libre.
   */
  catalogues: ('mangadex' | 'comicvine' | 'openlibrary' | 'booknode')[];
  /** Categories PAR SOURCE. Une source absente n'est pas interrogee pour cette famille. */
  categories: Record<string, (string | number)[]>;
  /** Faux pour l'audio : la visionneuse affiche des planches, pas du son. */
  lisibleEnLigne: boolean;
}

/**
 * Sources qui cherchent PAR CATEGORIE, et qu'une famille doit donc declarer.
 *
 * Wawacity et Telegram n'y figurent pas, et ce n'est pas un oubli : ils cherchent par
 * TITRE. Leur imposer une categorie n'aurait aucun sens, et les exclure faute d'en
 * declarer une les aurait purement et simplement eteints.
 */
export const SOURCES_A_CATEGORIE = new Set([
  'yggreborn', 'c411', 'tr4ker', 'g3mini', 'v3x', 'nyaa', 'knaben',
]);

export const FAMILLES: Famille[] = [
  {
    id: 'mangas',
    libelle: 'Mangas',
    catalogues: ['mangadex'],
    categories: {
      yggreborn: [7103],
      c411: [7030],
      // 7030 « Books/Comics », et NON 7000. Releve du 2026-08-25 dans le `t=caps` de
      // Tr4ker : 7000 est la branche ENTIERE — Mags, eBook et Comics reunis. Une
      // recherche de manga y ramenait 76 resultats dont 12 enregistrements audio et 51
      // ebooks. Tr4ker n'a pas de categorie manga distincte : ses manga vivent sous
      // Comics, comme le « Comics/Manga » de C411.
      tr4ker: [7030],
      // 30 = « Livres\\Mangas » chez Gemini. Voir la famille Livres pour l'explication
      // des types.
      g3mini: [30],
      // 7000 : voir la famille Livres — l'API de V3X ne filtre qu'au premier niveau.
      v3x: [7000],
      nyaa: ['3_1', '3_2', '3_3'],
      knaben: [6000000],
    },
    lisibleEnLigne: true,
  },
  {
    id: 'comics',
    libelle: 'Comics',
    catalogues: ['comicvine'],
    categories: {
      yggreborn: [7104], c411: [7030], tr4ker: [7030], knaben: [6000000],
      // 29 = « Livres\\Comics » chez Gemini : voir la famille Livres pour les types.
      g3mini: [29], v3x: [7000],
    },
    lisibleEnLigne: true,
  },
  {
    id: 'bd',
    libelle: 'BD franco-belge',
    catalogues: ['comicvine'],
    // Sur C411 et Tr4ker, BD et comics tombent dans la MEME categorie : ces trackers ne
    // les distinguent pas. Seul Ygg le fait. Les resultats se recouvriront, et
    // l'interface le dira plutot que de faire semblant.
    categories: {
      yggreborn: [7102], c411: [7030], tr4ker: [7030], knaben: [6000000],
      // 28 = « Livres\\BD » chez Gemini.
      g3mini: [28], v3x: [7000],
    },
    lisibleEnLigne: true,
  },
  {
    id: 'livres',
    libelle: 'Livres',
    // Booknode d'abord : lui seul rend la serie, le rang du tome et les livres recents
    // — « Holly » (2023) est introuvable chez Open Library, faute d'edition francaise
    // saisie. Open Library derriere, parce que Booknode est du scraping.
    catalogues: ['booknode', 'openlibrary'],
    // GEMINI : ce sont des TYPES, pas des categories. Chez lui la categorie 12 vaut
    // « Livres » tout entier — romans, BD, comics, manga et enregistrements melanges —
    // et c'est `type_id` qui distingue. 27 = « Livres », c'est-a-dire un livre au sens
    // ou l'entend cette famille.
    categories: {
      yggreborn: [7100], c411: [7020], tr4ker: [7020], knaben: [6000000], g3mini: [27],
      // V3X : 7000 POUR TOUTES LES FAMILLES, et ce n'est pas de la paresse.
      //
      // Son site distingue finement — 15 Audio, 16 BDs, 17 Comics, 18 Livres, 19 Manga
      // sous la racine 14 Ebook, arborescence lue sur /api/categories — mais SON ENDPOINT
      // TORZNAB N'EN VEUT PAS. Trois approches essayees le 2026-08-25, toutes mesurees :
      //
      //   cat=7010 a 7070   -> exactement les memes resultats que 7000, aux titres pres
      //   cats=ebook-manga  -> le slug est ignore, sous toutes les formes essayees
      //   cat=14 a 19       -> les identifiants PROPRES de V3X rendent ZERO resultat
      //
      // La granularite fine existe, elle n'est simplement pas joignable par Torznab. Ne
      // pas la rechercher une quatrieme fois.
      //
      // Declarer 7000 partout ne coute donc rien en precision — c'est la meme requete —
      // et ne cree pas de bruit : la recherche se fait par TITRE. « Kaijin Reijoh » y
      // rend 13 CBZ, « Solo Leveling » un, « Nausicaa » l'integrale. Ne le declarer que
      // pour les livres aurait perdu ces 146 bandes dessinees et mangas.
      v3x: [7000],
    },
    lisibleEnLigne: true,
  },
  {
    id: 'audio',
    libelle: 'Audiobook',
    // UN LIVRE AUDIO ET SON EPUB SONT LA MEME OEUVRE. Booknode et Open Library decrivent
    // le livre, jamais l'edition sonore : la famille Audiobook n'a donc rien a chercher
    // ailleurs, elle emprunte le catalogue des livres.
    //
    // La fiche reste separee par famille : ouverte depuis Livres elle liste les epub,
    // ouverte depuis Audiobook les mp3 et les m4b. Le lien de fiche porte deja
    // `&famille=`, donc rien n'est a ecrire pour ca.
    catalogues: ['booknode', 'openlibrary'],
    // YGG A BIEN UNE CATEGORIE LIVRES AUDIO, et l'affirmation inverse etait FAUSSE.
    // Elle disait : « ses sous-categories audio sont Musique, Podcast, Samples, Karaoke,
    // il n'a pas de categorie audiobook ». C'est vrai de la branche Audio (31xx) — et
    // c'est la seule qui avait ete regardee. La bonne est ailleurs, sous Books :
    // 7105 « Books/Livres audio ». Relevee le 2026-08-25 dans le `t=caps` d'Ygg
    // lui-meme, qui declare 59 categories.
    //
    // La famille Audiobook n'interrogeait donc pas Ygg du tout, sans que rien ne le
    // signale — une source muette ressemble a une source vide.
    // Gemini a TROIS types d'enregistrement, et il faut les trois : 25 « Livres\\M4B »,
    // 26 « Livres\\MP3 » et 33 « Livres\\Audio ». N'en declarer qu'un en manquerait
    // deux tiers sans que rien ne le signale.
    // V3X RANGE SES LIVRES AUDIO SOUS BOOKS (7000) — MAIS SES EBOOKS AUSSI, et le
    // commentaire precedent affirmait le contraire. Il avait ete releve avec `q=mp3`,
    // une requete qui contenait sa propre reponse : elle ne pouvait rendre que des
    // enregistrements. Interroge sur `king`, le meme 7000 rend des EPUB.
    //
    // UNE MESURE DONT LA REQUETE CONTIENT LA REPONSE NE MESURE RIEN.
    //
    // La categorie reste declaree — c'est la seule que V3X offre — et c'est
    // `formatEcarte` qui retire les livres texte. Sa categorie 3000 reste de la
    // musique : Gipsy Kings, Damso, Fela Kuti.
    categories: {
      yggreborn: [7105], c411: [3030], tr4ker: [3030], g3mini: [25, 26, 33], v3x: [7000],
    },
    // VRAI DEPUIS LE 2026-08-26 : la famille a sa surface d'ecoute. Le drapeau etait
    // reste a faux apres l'avoir construite, et la carte annoncait donc « pas de lecture
    // en ligne » juste au-dessus d'un lecteur parfaitement fonctionnel — signale a
    // l'usage, « ok mais je lis comment ? ».
    //
    // Ce drapeau ne dit PAS « la visionneuse sait l'ouvrir » : elle affiche des planches
    // et n'en saura jamais rien. Il dit « cette famille se consulte ici plutot que de se
    // telecharger », ce qui est desormais le cas.
    lisibleEnLigne: true,
  },
];

/** Rend `null` sur une famille inconnue : jamais de famille par defaut. */
export function familleParId(id: string): Famille | null {
  return FAMILLES.find((f) => f.id === id) ?? null;
}

/** Categories de cette famille pour cette source. Vide = source non interrogee. */
export function categoriesPour(f: Famille, source: string): (string | number)[] {
  return f.categories[source] ?? [];
}

/**
 * Cette source doit-elle etre ecartee pour cette famille ?
 *
 * Vrai seulement pour une source qui cherche par categorie et pour laquelle la famille
 * n'en declare aucune — Ygg face a l'audiobook, par exemple. Une source qui cherche par
 * titre n'est jamais ecartee.
 */
export function sourceEcartee(f: Famille, source: string): boolean {
  if (!SOURCES_A_CATEGORIE.has(source)) return false;
  return categoriesPour(f, source).length === 0;
}

/**
 * Formats qui identifient POSITIVEMENT un livre texte.
 *
 * « inconnu » n'y est pas, et c'est le coeur de la regle : un nom muet reste admis.
 */
const FORMATS_TEXTE: Format[] = ['epub', 'pdf', 'kindle', 'cbz', 'cbr'];

/**
 * Le format sonore n'appartient qu'a la famille Audiobook, et la famille Audiobook
 * refuse ce qui est positivement un livre texte.
 *
 * POURQUOI PAS « ne garder que le format audio ». C'etait la premiere redaction, et la
 * mesure du 2026-08-26 l'a annulee : sur 188 noms de la categorie 7105 d'Ygg, deux
 * n'annoncent aucun format. Un filtre positif les jetait en silence, alors que la
 * categorie du tracker suffisait a les qualifier.
 *
 * Ce que la regle coute, chiffre : un nom sur 188, « Audioconte.Disney.-.110.Numeros.CBZ »,
 * qui est reellement une archive d'images.
 */
export function formatEcarte(f: Famille, format: Format): boolean {
  if (f.id === 'audio') return FORMATS_TEXTE.includes(format);
  return format === 'audio';
}
