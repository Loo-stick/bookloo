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
