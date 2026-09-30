# Book Loo Store

Moteur de recherche et liseuse en ligne pour livres, bandes dessinées, mangas, comics et
livres audio. Auto-hébergé, multi-utilisateur.

**Book Loo Store ne stocke et ne distribue aucun contenu.** C'est un moteur de recherche
et un résolveur de liens : il interroge des index tiers et s'appuie sur les services de
débridage de l'utilisateur.

---

## Avertissement / Disclaimer

**À LIRE AVANT TOUTE UTILISATION**

Ce projet est publié **à des fins éducatives et de recherche uniquement**. L'auteur et les
contributeurs :

- **n'hébergent, ne stockent et ne distribuent aucun fichier** — le logiciel ne fait
  qu'interroger des index tiers et présenter ce qu'ils renvoient ;
- **ne cautionnent aucune violation du droit d'auteur** ;
- **déclinent toute responsabilité** quant à l'usage qui est fait de ce logiciel et à ses
  conséquences, y compris légales ;
- **ne garantissent ni le fonctionnement, ni la disponibilité, ni la légalité** des
  services tiers interrogés.

**L'utilisateur est seul responsable** de s'assurer que son usage est licite dans sa
juridiction, et de détenir les droits ou autorisations nécessaires pour accéder aux
contenus qu'il consulte.

Ce projet dépend de services tiers sur lesquels il n'a aucun contrôle : il peut cesser de
fonctionner à tout moment, sans préavis.

---

## Ce qu'il fait

- **Cinq rayons** — livres, mangas, comics, BD, livres audio — chacun avec son catalogue
  et ses sources.
- **Recherche par titre ou par auteur**, avec fiche d'œuvre, couverture et résumé.
- **Résultats au fil de l'eau** : chaque source apparaît dès qu'elle répond, et une source
  lente reste visible au lieu de bloquer l'affichage.
- **Une disponibilité en trois états** — présent, absent, ou *inconnu*. Le troisième n'est
  pas un défaut d'affichage : c'est l'information exacte, et la donner évite d'en inventer
  une.
- **Lecture et écoute en ligne** : les bandes dessinées planche à planche, les livres
  chapitre par chapitre, les livres audio piste par piste — avec reprise là où l'on s'est
  arrêté.
- **Multi-utilisateur.** Chacun renseigne ses propres clés de service, chiffrées avec une
  clé dérivée de son mot de passe. L'opérateur n'en détient aucune.

## Démarrer

L'image est publiée sur GitHub Container Registry : **`ghcr.io/loo-stick/bookloo`**. Il n'y
a rien à construire.

Un `docker-compose.yml` minimal :

```yaml
services:
  bookloo:
    image: ghcr.io/loo-stick/bookloo:latest
    container_name: bookloo
    restart: unless-stopped
    ports:
      - "127.0.0.1:8480:8480"
    environment:
      - NODE_ENV=production
      - PORT=8480
      - ADMIN_LOGIN=admin
    volumes:
      - ./config:/app/config
      - bookloo-etat:/app/data

volumes:
  bookloo-etat:
```

```bash
docker compose up -d
docker compose logs bookloo   # le mot de passe administrateur s'y affiche UNE SEULE FOIS
```

**HTTPS est nécessaire.** Le cookie de session est `Secure` : un navigateur le rejette
sans bruit sur une page en HTTP simple, et la connexion échoue sans message. Placez un
reverse proxy HTTPS devant l'application — elle vous le dira clairement si vous l'oubliez.
Pour un essai local uniquement, ajoutez `COOKIE_NON_SECURISE=1` aux variables
d'environnement.

Le port n'est exposé que sur la boucle locale : mettez un reverse proxy devant si vous
l'ouvrez sur le réseau. Le `docker-compose.yml` de ce dépôt, lui, construit depuis les
sources — utile pour développer, inutile pour s'auto-héberger.

Il n'y a pas d'inscription ouverte : les comptes se créent depuis l'administration.

Ensuite, page **Compte** : renseignez vos clés de service. Une source sans clé n'est jamais
interrogée, et l'interface le dit.

## Les sources Telegram, avec votre compte

Les canaux Telegram qui publient des fichiers sont une des meilleures sources de ce projet.
Book Loo s'y connecte **avec votre propre compte** : aucun service tiers, aucun compte prêté.

### 1. Déclarer une application chez Telegram

Sur **my.telegram.org** → *API development tools*, créez une application. Vous obtenez un
`api_id` (un nombre) et un `api_hash` (une chaîne). Ce ne sont pas des secrets partagés : ils
identifient votre application, pas vous.

### 2. Connecter le compte

Dans **Admin → Telegram**, renseignez :

- l'`api_id` et l'`api_hash` ;
- votre **numéro de téléphone**, avec l'indicatif (`+33…`) ;
- vos **canaux**, un par ligne. Un canal public s'écrit **sans arobase** (`N_art_Mangas`). Un
  canal privé, qui n'a pas de nom public, s'écrit `id:<numéro>`.

Puis **Enregistrer**, puis **Connecter**. Telegram envoie un code **dans Telegram** — pas sur
la page. Saisissez-le. Si votre compte a la vérification en deux étapes, l'écran vous demande
le mot de passe à ce moment-là, et pas avant.

La session obtenue reste sur le serveur : elle n'est **jamais** renvoyée au navigateur, parce
qu'elle ouvre le compte entier et non une clé limitée. L'`api_hash` et le numéro non plus —
l'écran n'en dit que la présence.

### 3. Indexer

**Indexer maintenant** lance un passage **en fond** : vous pouvez fermer l'onglet, revenir,
annuler. L'écran montre le canal en cours, les messages lus, ceux écrits, et l'attente que
Telegram impose parfois.

Il n'y a aucune limite de profondeur : le passage remonte chaque canal jusqu'à son premier
message. Comptez du temps — un canal de 645 000 fichiers demande quelques milliers de requêtes.
Chaque canal retient où il en est, donc une interruption ne coûte que les deux cents derniers
messages, jamais le travail entier.

Trois choses à savoir :

- **Les fichiers les plus anciens arrivent d'abord.** La lecture remonte le canal, donc les
  parutions récentes ferment la marche.
- **Retirer un canal de la liste efface son index.** C'est voulu — un canal retiré ne doit plus
  être cherchable — mais il faudra tout réindexer pour le remettre. Ajouter ne risque rien.
- **Ensuite, plus rien à faire.** Une recherche suffit : si l'index a plus de douze heures, un
  rattrapage part tout seul à côté, sans jamais faire attendre la recherche.

### 4. Allumer la lecture

La case **« Lire les sources Telegram avec ce compte »** ne devient cliquable qu'une fois un
compte connecté **et** un index non vide — sinon l'écran affiche ce qui manque. La décocher
revient à l'état précédent au clic suivant.

Comme partout dans Book Loo, **rien n'est rapatrié** : une planche se lit en demandant au canal
les seuls octets utiles.

### Ce que ça coûte au serveur

Mesuré dans un conteneur plafonné à 512 Mo, avec un index d'un million de messages : la moisson
tient entre 106 et 128 Mo, ouvrir une planche monte à 164 Mo, télécharger un fichier de 254 Mo
monte à 185 Mo — et le serveur continue de répondre en deux millisecondes pendant ce temps. Rien
ne dépend de la taille des données.

### Si quelque chose ne va pas

Les messages d'erreur disent quoi faire : « reconnectez le compte dans Admin » si la session a
été révoquée, « Telegram impose une attente de N s » si le compte est momentanément limité. Ce
que la bibliothèque Telegram raconte n'est jamais recopié tel quel — ni dans une réponse, ni dans
les journaux, où ni votre numéro, ni votre code, ni votre session, ni le nom du titulaire du
compte n'entrent.

## Développement

```bash
npm install
COOKIE_NON_SECURISE=1 npm run dev
npm run build
```

`COOKIE_NON_SECURISE=1` est nécessaire en local : sans HTTPS, un cookie `__Host-` est
rejeté par le navigateur et la connexion échoue sans message.


## Licence

MIT. Voir [LICENSE](LICENSE).
