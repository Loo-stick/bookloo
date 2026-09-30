#!/bin/sh
# LE CONTENEUR REPARE SES MONTAGES, PUIS ABANDONNE SES PRIVILEGES.
#
# POURQUOI. `/app/config` et `/app/data` sont montes depuis l'hote, et un montage lie garde la
# propriete de l'hote : le `chown -R node:node /app` du Dockerfile ne s'y applique pas. Docker
# cree un dossier de montage manquant en ROOT — donc l'application, qui tourne sous un
# utilisateur non privilegie, ne peut y ecrire aucun reglage.
#
# Le symptome etait muet : l'application demarrait, servait les pages, lisait ses valeurs par
# defaut, et « Enregistrer » rendait « erreur interne ». Signale le 2026-09-30 par un hebergeur
# qui a perdu une heure dessus. Chez l'auteur cela passait par coincidence — son utilisateur a
# l'uid 1000, celui de `node`.
#
# Demander un `chown` dans le README aurait deplace le probleme chez chaque personne qui
# installe. On le corrige ici, une fois.
#
# CE QUI TOURNE EN ROOT : ces quelques lignes, et rien d'autre. `setpriv` — deja dans l'image,
# aucune dependance ajoutee — rend la main a `node` avant le premier octet servi. Le processus
# qui repond aux requetes est donc exactement celui d'avant.
set -e

utilisateur=node
uid="$(id -u "$utilisateur")"
gid="$(id -g "$utilisateur")"

if [ "$(id -u)" = 0 ]; then
  for d in /app/config /app/data; do
    [ -d "$d" ] || mkdir -p "$d"
    # On teste ce qui compte VRAIMENT — l'ecriture par l'utilisateur final — plutot que de
    # deduire des droits : un dossier en 0777 appartenant a root est deja utilisable.
    if ! setpriv --reuid="$uid" --regid="$gid" --init-groups /usr/bin/test -w "$d"; then
      echo "[Entree] $d n'etait pas accessible en ecriture par $utilisateur : propriete corrigee"
      chown -R "$uid:$gid" "$d" || echo "[Entree] ATTENTION : correction impossible sur $d"
    fi
  done
  exec setpriv --reuid="$uid" --regid="$gid" --init-groups -- "$@"
fi

# DEJA NON-ROOT : l'hebergeur a impose `user:` dans son compose, et c'est son droit. On ne peut
# rien corriger, donc on lance tel quel — l'application dira au demarrage ce qui n'est pas
# inscriptible, au lieu de le decouvrir au premier enregistrement.
exec "$@"
