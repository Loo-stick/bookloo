# pdf.js embarque

`pdfjs.mjs` et `pdfjs-worker.mjs` sont les fichiers `build/pdf.min.mjs` et
`build/pdf.worker.min.mjs` du paquet **pdfjs-dist 4.10.38**, sous licence Apache 2.0
(`PDFJS-LICENSE.txt`). Ils sont recopies tels quels, sans modification.

## Pourquoi embarques et non charges d'un CDN

La CSP de l'application est `default-src 'self'; script-src 'self'` : aucun script externe
ne peut s'executer. La servir depuis `src/web/` est donc la seule facon de la charger — et
c'est aussi la bonne : une bibliotheque qui vient d'ailleurs peut changer sous nos pieds.

## Pourquoi une dependance de production n'a PAS ete ajoutee

Le projet en compte six, deliberement. pdf.js ne s'execute que dans le NAVIGATEUR : c'est
un actif statique, au meme titre que `app.js`. Rien ne l'importe cote serveur, et
`package.json` n'a pas bouge.

## Pourquoi le rendu est cote client

Rasteriser un PDF sur le serveur demanderait une bibliotheque native dans l'image Docker,
et du processeur et de la memoire a chaque page. Cette machine a gele deux fois pour cause
de memoire. Le navigateur de l'utilisateur, lui, a exactement ce qu'il faut.

## Pourquoi l'extension `.mjs`

Ce sont des MODULES ES, et l'extension le dit. Nommes `.js`, ils passaient pour des
scripts classiques : le controle de syntaxe echouait sur leur premier `export`, et rien —
dans un fichier minifie sur une seule ligne — ne permettait de deviner leur nature depuis
leur contenu. L'extension porte la verite, ce qui evite d'avoir a la reconstituer.

## Mise a jour

Recuperer le paquet (`npm pack pdfjs-dist@<version>`), recopier les deux fichiers, mettre
a jour la version ci-dessus. Le worker et le moteur doivent venir de la MEME version : ils
partagent un protocole interne qui n'est pas stable entre versions.
