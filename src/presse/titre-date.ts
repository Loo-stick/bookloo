// Separer « Les Echos Week-end » de « 28 aout 2026 ».
//
// C'est LA difficulte du kiosque, et c'est pour ca qu'elle vit dans un module pur : les
// trois sites ecrivent la meme parution de sept facons differentes, et cela ne se verifie
// qu'en executant la fonction sur les formes reelles — relevees le 2026-08-31, jamais
// inventees. Voir `titre-date.test.ts`.

export const MOIS = [
  'janvier', 'fevrier', 'mars', 'avril', 'mai', 'juin',
  'juillet', 'aout', 'septembre', 'octobre', 'novembre', 'decembre',
];

const JOURS = 'lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche';

/**
 * Une forme sans accents, DE MEME LONGUEUR que l'original.
 *
 * La longueur compte : on cherche la date sur la forme pliee, puis on coupe le titre dans
 * la chaine D'ORIGINE au meme indice. Un `normalize('NFD')` global decalerait tout, parce
 * qu'il transforme un caractere accentue en DEUX. On plie donc caractere par caractere.
 */
function plier(s: string): string {
  return s
    .split('')
    .map((c) => c.normalize('NFD')[0])
    .join('')
    .toLowerCase();
}

// La date : un jour de semaine facultatif, un quantieme facultatif, un mois, un second
// mois facultatif pour les intervalles, une annee. L'annee seule ne suffit jamais — le
// mois est ce qui fait d'un nombre une date.
//
// LE JOUR DE SEMAINE EST DANS CETTE EXPRESSION, ET PAS DANS LE NETTOYAGE DU TITRE. C'est
// ce qui distingue « L'Equipe du lundi 31 aout 2026 », ou « du lundi » annonce la date, de
// « Le Journal du Dimanche - 30 Aout 2026 », ou « du Dimanche » EST le titre. Le critere
// est l'adjacence : un jour de semaine colle a la date en fait partie, un jour de semaine
// separe d'elle appartient au nom du journal.
//
// LE QUANTIEME EST BORNE A 31, ET PRECEDE D'UN NON-CHIFFRE. Sans cela « N°46 mai-juillet
// 2026 » rendait le 46 mai : le numero de parution etait lu comme un quantieme. Et sans le
// non-chiffre, l'expression se rabattait sur le « 6 » de « 46 ».
//
// LE PREMIER DU MOIS PORTE SON ORDINAL, et lui seul. En francais le premier ne s'ecrit
// jamais « 1 » mais « 1er » — defaut vu au deploiement du 2026-09-01, sur les trois sites
// a la fois : le jour etait perdu, la date tombait au mois, et « Du Mardi 1er » restait
// colle au titre. L'ordinal n'est accepte QUE derriere un 1, parce que « 2er » n'existe
// pas et que l'accepter ferait lire comme des jours des nombres qui n'en sont pas.
const RE_DATE = new RegExp(
  `(?:(?:du\\s+)?(?:${JOURS})\\s+)?(?<!\\d)(?:((?:0?1(?:er|\u1d49\u02b3))|3[01]|[12]\\d|0?[1-9])\\s+)?`
  + `(${MOIS.join('|')})(?:\\s*[-–—/]\\s*(?:${MOIS.join('|')}))?\\s+(\\d\\d\\d\\d)`,
);

/**
 * La date EN CHIFFRES : « 08.09.2026 », « 08/09/2026 », « 08 09 2026 ».
 *
 * POURQUOI ELLE EST ARRIVEE. Mesure du 2026-09-14 sur les releases de « Le Parisien » :
 * worldivx ecrit ses numeros recents `Le.Parisien.Du.08.09.2026.FR.[PDF]-NoTag`, et le
 * parseur, qui ne lisait que les mois en toutes lettres, n'en datait que 18 sur 40 — les
 * plus RECENTS etant justement ceux qu'il manquait. Trier du plus recent au plus ancien
 * les aurait envoyes en fin de liste.
 *
 * JOUR, MOIS, ANNEE, dans cet ordre : c'est l'ordre francais, et le seul releve. Une annee
 * sur quatre chiffres, entre 1900 et 2099 ; un jour et un mois bornes, precedes et suivis
 * d'un non-chiffre. « N°25522 13 09 2026 » rend le 13 septembre, pas le 22 : le numero de
 * parution colle a ses chiffres ne peut pas preter un jour. Et « 2026-2027 » n'est pas une
 * date.
 *
 * ELLE NE SERT QU'EN SECOND : un mois en toutes lettres reste prioritaire, pour que rien
 * de ce qui etait deja lu ne change.
 */
const RE_DATE_NUM = new RegExp(
  `(?:(?:du\\s+)?(?:${JOURS})\\s+)?(?<!\\d)(3[01]|[12]\\d|0?[1-9])[\\s./-]+(1[0-2]|0?[1-9])[\\s./-]+((?:19|20)\\d\\d)(?!\\d)`,
);

/** Vrai si ce jour existe dans ce mois — « 31 02 2026 » n'est pas une date. */
function dateExiste(annee: number, mois: number, jour: number): boolean {
  const d = new Date(Date.UTC(annee, mois - 1, jour));
  return d.getUTCFullYear() === annee && d.getUTCMonth() === mois - 1 && d.getUTCDate() === jour;
}

/** Ce qui traine en fin de titre une fois la date retiree, et qui n'est pas le titre. */
function nettoyerFin(titre: string): string {
  let t = titre.trim();
  for (;;) {
    const avant = t;
    // Un numero de parution : « N°46 ». Il n'est pas une date, et il n'est pas le titre.
    t = t.replace(/\s*n\s*[°ºo]\s*\d+\s*$/i, '');
    t = t.replace(/\s*[-–—,:]\s*$/, '');
    t = t.trim();
    if (t === avant) return t;
  }
}

/**
 * Le titre et sa date de parution.
 *
 * `date` vaut `2026-08-28` quand le jour est donne, `2026-09` quand seul le mois l'est.
 * UN INTERVALLE GARDE SA BORNE BASSE : « Mai-juillet 2026 » vaut `2026-05`, parce que
 * c'est la date de PARUTION, pas celle de peremption.
 *
 * SANS DATE RECONNUE, `date` VAUT `null` ET LE TITRE RESTE ENTIER. Deviner vaut moins que
 * rendre la ligne telle quelle : un numero mal date doit rester visible et cliquable, et
 * il ira simplement en fin de liste.
 */
export function separerTitreDate(brut: string): { titre: string; date: string | null } {
  // Le suffixe de rubrique que Wawacity ajoute : « [Magazines] », « [Journaux] ».
  const sansRubrique = String(brut || '').replace(/\s*\[[^\]]*\]\s*$/, '').trim();

  const plie = plier(sansRubrique);
  const m = RE_DATE.exec(plie);
  if (!m || m.index === undefined) {
    // En second, la date en chiffres : voir `RE_DATE_NUM`.
    const n = RE_DATE_NUM.exec(plie);
    if (n && n.index !== undefined) {
      const [jour, mois, annee] = [Number(n[1]), Number(n[2]), Number(n[3])];
      if (dateExiste(annee, mois, jour)) {
        const date = `${annee}-${String(mois).padStart(2, '0')}-${String(jour).padStart(2, '0')}`;
        const titre = nettoyerFin(sansRubrique.slice(0, n.index));
        return { titre: titre || sansRubrique, date };
      }
    }
    return { titre: sansRubrique, date: null };
  }

  const mois = String(MOIS.indexOf(m[2]) + 1).padStart(2, '0');
  // `m[1]` peut valoir « 1er » : on lit le nombre, pas la chaine.
  const date = m[1]
    ? `${m[3]}-${mois}-${String(parseInt(m[1], 10)).padStart(2, '0')}`
    : `${m[3]}-${mois}`;

  const titre = nettoyerFin(sansRubrique.slice(0, m.index));
  // Un titre vide voudrait dire que la ligne n'est QUE une date : on rend alors le brut,
  // qui reste plus informatif que rien.
  return { titre: titre || sansRubrique, date };
}
