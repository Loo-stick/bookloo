// Ouverture d'une base SQLite, avec un message qui sert a quelque chose quand ça rate.
//
// POURQUOI CE FICHIER EXISTE. Une amie a voulu heberger l'addon et a recu ceci :
//
//     SqliteError: unable to open database file
//         at new Database (/app/node_modules/better-sqlite3/lib/database.js:69:26)
//     { code: 'SQLITE_CANTOPEN' }
//
// Rien la-dedans ne dit quoi faire. La cause, elle, est simple et se reproduit a
// volonte : `docker-compose.yml` monte `./config` dans `/app/config`, et un montage
// REMPLACE le dossier de l'image — le `chown node:node` du Dockerfile avec. Le
// conteneur, lui, tourne sous `node`, dont l'uid vaut **1000 en dur** dans les images
// Node. Il faut donc que le dossier de l'hote soit accessible en ecriture a l'uid 1000.
//
// Cela fonctionnait chez l'operateur par pure coincidence : son utilisateur hote a
// l'uid 1000. Verifie en lançant la MEME image sur le MEME dossier — uid 1000 :
// la base s'ouvre ; uid 1001 : SQLITE_CANTOPEN.
//
// On ne peut pas corriger la permission depuis le processus : il n'a precisement pas
// le droit d'ecrire. Ce qu'on peut faire, c'est arreter de laisser quelqu'un seul
// devant une trace d'appels, et lui donner la commande.

import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Ou vivent les bases : dans l'ETAT, jamais dans la configuration.
 *
 * Les deux n'ont pas le meme proprietaire ni le meme cycle de vie. `config/` est monte
 * depuis l'hote pour etre lisible et modifiable a la main ; il appartient donc a
 * l'utilisateur de l'hote. Les bases, elles, sont ecrites par le conteneur a chaque
 * requete — les loger dans un dossier qui ne lui appartient pas etait la cause du
 * `SQLITE_CANTOPEN` au demarrage, et cela ne se voyait pas quand les deux uid
 * coincidaient.
 *
 * `/app/data` est un volume NOMME : Docker en confie la propriete a l'utilisateur du
 * conteneur, sans que personne ait a poser un `chown`.
 */
export function cheminEtat(nomFichier: string, variable?: string): string {
  const impose = variable ? (process.env[variable] || '').trim() : '';
  if (impose) return impose;
  if (fs.existsSync('/app/data')) return path.join('/app/data', nomFichier);
  // Hors conteneur (developpement), a cote du projet.
  return path.join(process.cwd(), 'data', nomFichier);
}

/** Ancien emplacement des bases, conserve pour les reprendre une seule fois. */
export function dossierConfigHistorique(): string {
  return fs.existsSync('/app/config') ? '/app/config' : path.join(process.cwd(), 'config');
}

/**
 * Reprend une base restee dans l'ancien emplacement.
 *
 * Sans cela, la mise a jour repartirait sur une base vide : le cache se reconstruirait
 * tout seul, mais l'activite par utilisateur — trente jours de traces — serait perdue
 * sans un mot. On COPIE au lieu de deplacer : le dossier d'origine n'est peut-etre pas
 * inscriptible, et c'est precisement le cas qu'on est en train de corriger.
 *
 * Les fichiers `-wal` et `-shm` suivent : une base WAL peut porter dans son journal des
 * ecritures que le fichier principal n'a pas encore. Rien n'est encore ouvert a cet
 * instant, la copie est donc coherente.
 */
export function reprendreAncienneBase(destination: string, ancien: string): void {
  if (fs.existsSync(destination) || !fs.existsSync(ancien)) return;
  try {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    for (const suffixe of ['', '-wal', '-shm']) {
      if (fs.existsSync(ancien + suffixe)) fs.copyFileSync(ancien + suffixe, destination + suffixe);
    }
    console.log(`[Base] reprise de ${ancien} vers ${destination} — l'ancien fichier peut etre supprime`);
  } catch (e) {
    // Une reprise ratee ne doit pas empecher de demarrer : on repart a vide, en le disant.
    console.error(`[Base] reprise impossible depuis ${ancien} : ${(e as Error).message}`);
  }
}

/**
 * Ouvre la base, ou echoue en expliquant.
 *
 * Le diagnostic est etabli au moment de l'erreur, pas devine : on relit l'uid effectif
 * du processus et le proprietaire reel du dossier, et on n'affirme que ce qu'on a
 * constate.
 */
export function ouvrirBase(fichier: string): Database.Database {
  const dossier = path.dirname(fichier);
  try {
    fs.mkdirSync(dossier, { recursive: true });
    return new Database(fichier);
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { code?: string };
    const permission = err.code === 'SQLITE_CANTOPEN' || err.code === 'EACCES' || err.code === 'EPERM';
    if (!permission) throw e;

    const moi = typeof process.getuid === 'function' ? process.getuid() : -1;
    let proprietaire: number | null = null;
    let mode = '';
    try {
      const st = fs.statSync(dossier);
      proprietaire = st.uid;
      mode = (st.mode & 0o777).toString(8);
    } catch {
      /* dossier absent ou illisible : on le dira autrement */
    }

    // Deux causes distinctes, deux commandes differentes. Proposer un `chown` quand le
    // dossier appartient DEJA au bon utilisateur enverrait chercher au mauvais endroit.
    const remede =
      proprietaire === null
        ? [`  ${dossier} est introuvable ou illisible depuis le conteneur.`, '  Verifiez le montage declare dans docker-compose.yml.']
        : proprietaire !== moi
          ? [
              `  Le processus tourne sous l'uid ${moi}, et ${dossier} appartient a l'uid ${proprietaire}.`,
              '',
              "  En Docker, le dossier monte depuis l'hote garde SES permissions : celles que",
              "  l'image avait posees sont remplacees. Depuis le dossier du projet, sur l'HOTE :",
              '',
              `      sudo chown -R ${moi}:${moi} config`,
            ]
          : [
              `  Le dossier appartient bien a l'uid ${moi}, mais ses permissions (${mode}) interdisent`,
              '  l ecriture. Depuis le dossier du projet, sur l HOTE :',
              '',
              '      chmod u+rwX config',
            ];

    console.error(
      ['', `[Base] Impossible d'ouvrir ${fichier}.`, '', ...remede, '', '  puis relancez : docker compose up -d', ''].join('\n'),
    );
    throw e;
  }
}
