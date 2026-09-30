// Masquage des secrets dans tout ce qui sort du serveur vers un humain.
//
// La page d'administration affiche « l'operateur ne detient aucune cle d'utilisateur ».
// C'est vrai du stockage : rien n'est conserve, la configuration voyage chiffree dans
// le lien de chacun. Mais un JOURNAL peut trahir cette promesse par accident — il
// suffit qu'une ligne recopie l'adresse complete d'un indexeur, et la passkey de
// l'utilisateur s'affiche dans une page web.
//
// Le risque devient concret des lors qu'on conserve les traces sur disque et qu'on les
// rattache a une personne. Ce fichier est donc la condition d'entree de ce travail, pas
// une precaution ajoutee apres.
//
// PRINCIPE : ne masquer que ce qu'on RECONNAIT comme secret, jamais par ressemblance.
// Une empreinte de torrent fait quarante caracteres hexadecimaux, exactement comme
// certaines cles d'API : masquer « ce qui ressemble a une cle » rendrait les traces
// illisibles pour le seul usage qui les justifie, le diagnostic. On s'en tient donc aux
// parametres NOMMES et aux formes que ce projet produit lui-meme.

/**
 * Parametres d'URL qui portent un secret. Le nom est la preuve : personne n'appelle
 * « passkey » autre chose qu'une passkey.
 */
const PARAMETRES = [
  'apikey',
  'api_key',
  'apiKey',
  'passkey',
  'token',
  'access_token',
  'agent',
  'key',
  'password',
  'secret',
  'auth',
];

const RE_PARAMETRE = new RegExp(`\\b(${PARAMETRES.join('|')})=([^&\\s"'\\\\]{4,})`, 'gi');

/** « Authorization: Bearer xxx », et la forme abregee qu'on trouve dans les traces. */
const RE_PORTEUR = /\b(bearer|basic)\s+([A-Za-z0-9._~+/=-]{8,})/gi;

/**
 * Configuration d'un utilisateur : « e1. » suivi du chiffre. Elle ne livre pas les
 * cles a qui la lit — c'est tout l'interet du chiffrement — mais elle reste un
 * laissez-passer vers son compte debrid. Elle n'a donc rien a faire dans une page.
 */
// Alphabet base64 POUR URL (`-` et `_`), sans la barre oblique : elle separe les
// segments du chemin, et l'inclure ferait avaler la fin de l'adresse — donc la partie
// utile de la ligne.
const RE_CONFIG = /\be1\.[A-Za-z0-9_-]{16,}/g;

/**
 * En-tetes porteurs de secret : « X-Facade-Secret: xxx ».
 *
 * `RE_PARAMETRE` ne couvre que la forme `nom=valeur` d'une URL ou d'un corps. Le secret
 * de la facade Telegram, lui, ne voyage QUE dans un en-tete — il serait donc passe en
 * clair dans une trace axios, qui recopie volontiers la configuration de la requete.
 */
const RE_ENTETE = /\b(x-[a-z0-9-]*(?:secret|token|key))\s*:\s*([^\s"',}]{4,})/gi;

/**
 * Remplace les secrets par des points de suspension, en gardant assez de contexte
 * pour que la ligne reste diagnostiquable.
 *
 * Idempotent : masquer deux fois donne le meme resultat, ce qui compte quand une ligne
 * traverse a la fois le journal en memoire et la trace persistee.
 */
export function masquer(texte: string): string {
  return texte
    .replace(RE_PARAMETRE, (_, nom: string) => `${nom}=***`)
    .replace(RE_PORTEUR, (_, schema: string) => `${schema} ***`)
    .replace(RE_ENTETE, (_, nom: string) => `${nom}: ***`)
    .replace(RE_CONFIG, 'e1.***');
}
