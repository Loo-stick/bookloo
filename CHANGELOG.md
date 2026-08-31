# Journal des versions

Les notes complètes, avec les liens vers le code, sont sur
https://github.com/Loo-stick/bookloo/releases

## v1.6.0 — Les CBR de Telegram, et une revue jusqu'au bout

### Les CBR de Telegram se lisent

**80,9 % de l'index Telegram est en `.cbr`, et aucun ne s'ouvrait.** Le lecteur RAR savait pourtant les lire — il le faisait déjà sur les releases débridées. C'est l'interface qui cachait le bouton, avec une liste de formats écrite avant que ce lecteur existe, et cette porte ne s'appliquait qu'à Telegram.

Derrière, un second verrou masqué par le premier : la préparation était coupée au bout de 45 secondes, alors qu'elle en demande davantage.

**Elle en demande davantage parce qu'un CBR n'a pas de sommaire.** Un `.cbz` range son index à la fin du fichier : deux lectures suffisent. Un `.cbr` entrelace ses en-têtes avec les données, et la position de chacun ne se déduit que du précédent — il faut donc les parcourir un par un. Mesuré sur *I''s T01*, 287 Mo, 189 planches : **66 secondes**, et rien ne peut rendre ce parcours parallèle.

Soixante-six secondes derrière un bouton muet, c'est un bouton cassé. La préparation affiche donc son avancée — « préparation de l'archive — 41 %, 75 planches trouvées » — et le sommaire est retenu trente minutes : le coût se paie une fois, pas à chaque ouverture.

**Et la lecture des archives RAR est deux fois plus rapide, partout.** Le lecteur demandait 64 Ko pour analyser un en-tête d'une cinquantaine d'octets : 12,6 Mo transférés là où 256 Ko suffisent. Le gain vaut aussi pour les CBR débridés.

### TorBox : la lecture était cassée, et c'était notre faute

« Aucun lien de téléchargement obtenu » sur une release pourtant en cache, et 502 en demandant l'archive. Les deux passent par le même appel, dont un paramètre d'authentification avait été retiré deux jours plus tôt en le croyant redondant — pour corriger une fuite de journaux qui, vérification faite ensuite, n'existait pas. La vraie protection était ailleurs dans le même correctif, et elle tient toujours.

**Une panne TorBox n'efface plus ce qu'on savait.** Quand le service ne répondait pas, chaque release recevait « état inconnu » — et cette absence de réponse était enregistrée par-dessus les verdicts connus. Quelques minutes d'indisponibilité faisaient perdre la pastille « en cache » de contenus lisibles la veille.

### La revue de code, jusqu'au bout

Les quarante-deux points de la revue externe sont traités. Trente-six étaient réels, et les plus visibles à l'usage :

**Un livre au titre court ne se rapprochait jamais de sa release.** *It*, de Stephen King, ne pouvait pas correspondre à `It.T01.FR.CBZ` : un garde-fou de longueur s'exécutait avant le test d'égalité.

**« v2 » était pris pour « tome 2 ».** Un scan corrigé écrasait la position de lecture du deuxième tome.

**Deux fichiers de même nom dans des dossiers différents se confondaient** — mauvais tome affiché, progression enregistrée sur le mauvais contenu.

**Au-delà de 4 Go, une archive RAR déraillait.** La taille tronquée servait aussi à sauter au bloc suivant : le parcours atterrissait au milieu des données, et tout ce qui suivait était lu dans du bruit.

**Une archive de plus de 65 535 fichiers plantait** — en toute fin de génération, après l'attente.

**Un service en panne ne se fait plus passer pour un service qui ne connaît pas.** « MangaDex ne connaît pas ce titre » s'affichait pendant que MangaDex était hors service : le seul diagnostic disponible, et il était faux. Les quatre catalogues et Z-Library distinguent désormais l'échec du vide.

**Corriger ses identifiants Z-Library a enfin un effet immédiat.** L'ancienne session servait jusqu'à ce que le service la refuse : on corrigeait un mot de passe faux et on relisait la même erreur.

**Et le reste** : un plafond de résultats qui valait 500 au lieu des 2000 annoncés, une clé de cache Knaben qui mélangeait les catégories entre familles, des releases sans identifiant qui partageaient toutes la même — cliquer sur la première ouvrait la dernière.

### Sous le capot

**La suite de tests se déclarait verte en sautant des fichiers.** Quatre exécutions sur un code identique donnaient 1109, 1114, 1118 puis 1124 tests — sans jamais le moindre échec. Un fichier entier disparaissait en silence, et un test qui ne tourne pas ne peut pas rougir. La cause est corrigée ; la suite est déterministe, et deux tests empêchent le retour du contournement qui la masquait.

## v1.5.0 — Securite, et une page Log

### Neuf correctifs de sécurité

Un utilisateur a fait relire le code de la 1.4.0 et transmis une revue détaillée. Chaque point a été vérifié contre le code avant correction — et les quatre plus graves étaient réels.

**Une route qui débridait sur un simple lien.** `GET /api/release/:hash/fichiers` n'était protégée que par la connexion, mais pour une release en lien direct elle débride réellement chez AllDebrid ou TorBox. Le cookie étant en `sameSite: lax`, un lien piégé suffisait à déclencher l'action sur votre compte. Elle passe en `POST` avec jeton anti-CSRF, et un test refuse désormais **toute** route en `GET` capable de débrider — la règle, pas le cas.

**Une archive piégée pouvait faire tomber le serveur.** Le plafond de lecture portait sur la taille *compressée* : une entrée d'un mégaoctet peut se dégonfler en plusieurs gigaoctets. Il porte maintenant sur la taille annoncée **et** sur ce qui sort réellement de la décompression.

**Le filtre anti-script des EPUB se contournait.** Il cherchait `javascript:` en toutes lettres sans décoder les entités HTML, alors que le navigateur les décode avant d'interpréter le lien. Trois variantes sur quatre passaient. La liste noire est remplacée par une **liste blanche** de schémas : `http`, `https`, et les adresses internes au livre. Une liste noire ne peut pas gagner cette course.

**Un tracker pouvait faire lire une adresse interne.** Le téléchargement du `.torrent` n'avait ni limite de redirection ni contrôle d'hôte. Les adresses privées, de bouclage et de métadonnées d'hébergeur sont refusées, et les redirections ne sont plus suivies.

**Aucune clé ne s'écrit plus dans le cache partagé.** Le cache est persistant sur disque et volontairement mutualisé entre comptes — mais les liens de téléchargement qu'il stockait portaient la clé de tracker de celui qui avait lancé la recherche. Le cache stocke désormais un lien anonyme, et chacun y remet la sienne au moment de s'en servir : la mutualisation est conservée, la fuite disparaît. Les entrées antérieures sont effacées au démarrage.

**Et quatre points plus discrets.** Un refus de connexion ne révèle plus l'existence d'un compte. Le dernier administrateur ne peut plus être supprimé. Les couvertures et les vérifications de cache sont plafonnées. Un index manquant faisait balayer toute la table des sessions à chaque requête.

### Une page « Log »

Un utilisateur qui s'auto-héberge voyait « Invalid API key » sur trois trackers alors que la même clé passait ailleurs. Impossible de l'aider : l'application ne disait pas ce qu'elle faisait.

Elle le dit maintenant. Chaque appel sortant laisse une trace — l'hôte, le statut, la durée, le nombre de résultats, et le motif d'erreur **tel que le service le formule** :

```
error  c411 chez c411.org · HTTP 200 · 412 ms · Invalid API key
info   tr4ker chez tr4ker.net · HTTP 200 · 12 resultat(s) · 388 ms
```

Réservée aux administrateurs, filtrable par niveau et par source. **Rien de brut n'y entre** : les traces n'acceptent que des champs nommés, jamais une URL — un secret ne peut pas fuiter par un champ qu'on n'a pas ouvert. Mille lignes en mémoire, jamais sur disque.

### Le formulaire de clés enregistrait autre chose

Signalé par un utilisateur dont les clés étaient refusées alors qu'elles fonctionnaient partout ailleurs. La cause : `autocomplete="off"` est **ignoré** par les navigateurs sur un champ masqué, et leur gestionnaire de mots de passe remplissait les champs de clé. C'est donc le mot de passe du navigateur qui était enregistré.

Corrigé — et surtout, **un bouton « Afficher la clé »** : un secret qu'on ne peut pas relire est un secret qu'on ne peut pas vérifier.

### Aussi

Un **journal des versions** dans l'application, une version par volet. La **suppression d'un compte** depuis l'administration, absente de l'interface alors que le serveur savait le faire. Les entrées d'administration ne s'affichent plus que pour un administrateur.

## v1.4.0 — Les releases d'appoint

### Un tome manquant n'est plus un cul-de-sac

Un pack est rarement complet. Jusqu'ici, la bibliothèque le disait — « ce tome n'est pas dans la release mémorisée » — sans rien offrir de plus.

**Les releases d'appoint** comblent ce vide. La grille des tomes montre les trous, vous cliquez sur celui qui manque, et le panneau s'ouvre déjà ciblé sur lui. La release choisie sert ce tome **et les autres qu'elle couvre**, sans jamais reprendre un tome que votre pack sert déjà : ajouter une release ne peut pas dégrader ce qui marchait.

Chaque appoint se voit sous la carte, avec ce qu'il sert et un bouton pour le retirer. Le retrait ne touche pas à votre avancée — elle appartient au tome, jamais à la release qui l'a servi.

**La grille ne ment pas.** Elle va de 1 au dernier tome que le catalogue annonce — `lastVolume` chez MangaDex, et son agrégat quand la série est en cours, où le champ reste vide ; `count_of_issues` chez ComicVine. Quand aucun ne sait, elle s'arrête au plus grand tome connu. Jamais de tome inventé.

### Trois formats de plus

- **Un CBZ contenu dans un ZIP.** Les octets d'une entrée stockée sont contigus : lire une planche n'est qu'un décalage d'offset. Rien n'est décompressé, rien n'est chargé.
- **Les CBR**, RAR4 comme RAR5, par le même mécanisme. Un CBR contient des JPEG déjà compressés, que les archiveurs stockent presque toujours.
- **Les packs d'archives par volume** — plusieurs archives sont autant de tomes, une seule est un contenant dans lequel il faut regarder.

Plus la numérotation `Tome #003` et `第042巻`, que rien ne lisait.

### Le panneau des releases

Un **filtre par source**, comme sur la page de recherche : une pastille par source avec son compte, un clic pour basculer. Le filtre masque, il ne réordonne pas.

Chercher pour un tome précis **écarte ce qui ne peut pas le servir** — « Tome 112 » ne rendra jamais le 105 — sans jamais masquer une release dont la plage est illisible.

### Lister ne dépose plus

Afficher ce qu'une release contient ajoutait le torrent sur votre compte. TorBox sait répondre depuis son cache sans rien déposer : c'est désormais ce chemin qui est pris, le dépôt n'étant plus que le repli.

## v1.3.0 — La release choisie commande

### La release choisie commande

Choisir une release voulait dire « je lis celle-ci désormais » — mais c'était l'inverse qui se produisait : la position commandait, et lire ré-enregistrait le raccourci par-dessus. Un choix fait à la main était effacé au premier « Reprendre ».

**Ce qui change.** La release mémorisée décide de ce que « Reprendre » ouvre, sa description la suit, et l'avancée de chaque fichier lui reste attachée. Changer de release ne fait plus perdre où vous en étiez.

### Les liens directs s'ouvrent depuis l'étagère

Une release en lien direct refusait de s'ouvrir depuis la bibliothèque et renvoyait vers la recherche. Elle sonde désormais ses hébergeurs, retient le premier débrideur qui sait en débloquer un vivant, et le serveur rechoisit tout seul si le lien meurt en pleine lecture.

Quand ça ne peut pas aboutir, le message dit **laquelle** des trois pannes : aucune clé enregistrée, aucun hébergeur pris en charge — avec leur liste — ou des liens qui ne répondent plus.

### Correctifs

- **La fermeture enregistre avant de rafraîchir.** `sendBeacon` ne s'attend pas : l'étagère se redessinait sur la position d'avant, et un livre lu trois minutes plus tôt réaffichait « Commencer ».
- **Fermer l'onglet en pleine lecture** ne perdait rien dans la visionneuse, mais tout dans la liseuse et l'écoute. Elles ont le même filet.
- **La description suit sa release.** `source` et `titre_release` pouvaient rester ceux de la précédente : la bibliothèque affichait « telegram » sur une release de tracker.

## v1.2.0 — « Ouvrir » ne touche plus au tracker

### Correctif important pour les trackers privés

**« Ouvrir » ne télécharge plus jamais le fichier `.torrent` d'une release.**

Récupérer un `.torrent` sur un tracker privé y enregistre un téléchargement, et son annonceur porte votre passkey : le débrideur télécharge ensuite en votre nom, avec l'obligation de seed qui va avec.

Huit chemins le faisaient. La v1.1.0 en avait fermé sept, tous liés au débrideur. Le huitième n'en dépendait pas : « Ouvrir » lisait le `.torrent` **uniquement pour énumérer les tomes**, ce qui le rendait invisible aux audits centrés sur le débrideur.

**Ce que fait « Ouvrir » désormais** : il interroge les deux débrideurs — TorBox par consultation en lecture seule, AllDebrid en déposant l'empreinte une seconde puis en la retirant. Ni l'un ni l'autre n'exige d'annonceur, donc aucun ne sollicite le tracker.

- **En cache** → la liste des tomes vient du débrideur.
- **Sinon** → seul « Déposer » est proposé. Vous restez maître du moment où un téléchargement est enregistré.

Quatre traces nomment désormais tout chemin sortant vers un tracker — l'hôte seulement, jamais l'URL. Trois tests gèlent la règle, dont un qui parcourt l'ensemble du code source.

## v1.1.0 — le .torrent ne part que sur un dépôt assumé

### Le correctif qui compte

**Le fichier `.torrent` n'est plus récupéré que sur un dépôt assumé.**

Sur un tracker privé, récupérer un `.torrent` enregistre un téléchargement chez lui, et son annonceur porte votre passkey : le débrideur télécharge ensuite en votre nom, avec l'obligation de seed qui va avec.

Six chemins le faisaient sans rien déposer — lister les fichiers, obtenir des liens, l'archive, la lecture, l'archive assemblée et le sommaire audio. Ils se contentent désormais de l'empreinte, ce qui suffit dès lors que la release est dans le cache du débrideur : c'est tout l'intérêt d'un cache.

Le seed anti-H&R suit maintenant le geste « Déposer », et ne se déclenche que sur une release réellement absente du cache. Une route capable de solliciter le tracker sans qu'aucun bouton n'y mène a été retirée.

Trois traces nomment l'hôte sollicité — jamais l'URL, qui porte le passkey.

### Nouveautés

- **Changer de release sans quitter la bibliothèque** : un panneau liste les releases, vérifie le cache et pose le raccourci sur place.
- **Livres audio** : la position d'écoute s'enregistre enfin (un cookie mal nommé la rejetait en silence), et une piste ouvre le lecteur audio au lieu de la visionneuse.
- **Archives** : le fichier porte le titre de la release au lieu du dossier du torrent.
- **Apparence** : hiérarchie typographique retravaillée, cartes, verre, et un accent de marque distinct des couleurs d'état.

## v1.0.0 — première version publique

Première version publique de **Book Loo Store** — moteur de recherche et liseuse en ligne, auto-hébergée, pour livres, mangas, comics, BD et livres audio.

### Ce que contient cette version

- **Cinq rayons** avec catalogue : recherche par titre ou par auteur, couvertures, résumés, fiches d'œuvre.
- **Résultats au fil de l'eau**, source par source — une source lente reste visible au lieu de bloquer l'affichage.
- **Disponibilité en trois états** : présent, absent, ou *inconnu*. Le troisième est une vraie réponse.
- **Lecture en ligne** : bandes dessinées planche à planche, livres chapitre par chapitre.
- **Écoute en ligne** : livres audio piste par piste, enchaînement automatique, réglage de vitesse, reprise là où l'on s'est arrêté.
- **Téléchargement groupé** : archive assemblée à la volée quand le service ne sait pas la produire lui-même.
- **Multi-utilisateur** : chacun ses propres clés, chiffrées avec une clé dérivée de son mot de passe.

### Ce qu'il vous faut

- Docker
- Un **reverse proxy HTTPS** — le cookie de session l'exige, et l'application vous le dira clairement si vous l'oubliez
- **Vos propres clés** de services : sans clé, une source n'est jamais interrogée
