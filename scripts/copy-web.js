// Recopie les fichiers statiques dans dist/, en apposant une EMPREINTE aux scripts et
// feuilles de style que les pages referencent.
//
// POURQUOI L'EMPREINTE. Cloudflare sert les .js et .css avec `max-age=14400` : quatre
// heures pendant lesquelles le navigateur garde l'ancienne version. Les pages HTML, elles,
// sont en `max-age=0` et donc toujours fraiches. Sans empreinte, un deploiement etait donc
// invisible — verifie : un correctif livre restait sans effet et se faisait signaler comme
// un bug encore present, le message affiche etant celui du code precedent.
//
// L'empreinte resout les deux besoins a la fois : le HTML frais pointe vers une URL qui
// change des que le fichier change, et tant qu'il ne change pas les quatre heures de cache
// continuent de servir.
//
// Il n'y a toujours PAS de build frontend : on ne transforme aucun contenu, on ne fait
// qu'ajouter `?v=` aux references. C'est ce qui garde la CSP stricte tenable sans effort.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const source = path.join(__dirname, '..', 'src', 'web');
const cible = path.join(__dirname, '..', 'dist', 'web');

const empreinte = (chemin) =>
  crypto.createHash('sha256').update(fs.readFileSync(chemin)).digest('hex').slice(0, 8);

fs.mkdirSync(cible, { recursive: true });

// LE JOURNAL DES VERSIONS VOYAGE AVEC L'IMAGE. Il est a la racine du depot — c'est la
// qu'un depot public le cherche — et l'application le sert comme un actif ordinaire. Aucun
// appel sortant : le journal montre ce que cette version-la connaissait, ce qui est exact
// meme sans reseau. Qui met a jour l'image met a jour son journal.
const journal = path.join(__dirname, '..', 'CHANGELOG.md');
if (fs.existsSync(journal)) fs.copyFileSync(journal, path.join(cible, 'CHANGELOG.md'));

const fichiers = fs.readdirSync(source).filter((f) => !f.endsWith('.test.ts'));

// Les empreintes d'abord : une page peut referencer n'importe quel actif.
const versions = new Map();
for (const f of fichiers) {
  // `.mjs` compte comme `.js` : un module ES est un actif servi au navigateur comme un
  // autre, et l'oublier laisserait le navigateur garder sa version d'avant jusqu'a
  // expiration du cache.
  if (/\.(?:js|mjs|css)$/.test(f)) versions.set(f, empreinte(path.join(source, f)));
}

let n = 0;
let references = 0;
for (const f of fichiers) {
  const entree = path.join(source, f);
  const sortie = path.join(cible, f);

  if (f.endsWith('.html')) {
    let html = fs.readFileSync(entree, 'utf8');
    // On ne touche qu'aux chemins ABSOLUS servis par nous : rien d'externe, et la CSP
    // interdit de toute facon le reste.
    html = html.replace(/(src|href)="\/([\w.-]+\.(?:js|mjs|css))"/g, (tout, attr, nom) => {
      const v = versions.get(nom);
      if (!v) return tout;
      references++;
      return `${attr}="/${nom}?v=${v}"`;
    });
    fs.writeFileSync(sortie, html);
  } else {
    fs.copyFileSync(entree, sortie);
  }
  n++;
}

console.log(`[build] ${n} fichier(s) statique(s) recopie(s), ${references} reference(s) versionnee(s)`);
