# Build en deux etapes : better-sqlite3 et @node-rs/argon2 se compilent nativement, et
# ni les outils de compilation ni les dependances de developpement n'ont a suivre dans
# l'image finale.

FROM node:22-trixie-slim AS build
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json ./
COPY scripts ./scripts
COPY src ./src
RUN npm run build && npm prune --omit=dev


FROM node:22-trixie-slim
WORKDIR /app
ENV NODE_ENV=production

# `/app/data` DOIT exister ici et appartenir a `node`. Docker n'attribue la propriete
# d'un volume nomme au dossier de l'image que si ce dossier EXISTE : sinon il le cree a
# la volee, en root, et le conteneur ne peut plus y ecrire — SQLITE_CANTOPEN au
# demarrage, sans rien pour l'expliquer.
# curl, POUR UNE SEULE RAISON, et elle est mesurable. Le CDN de Booknode rejette toutes
# les piles HTTP de Node — axios, undici, node:https — avec un 403, en HTTP/1.1 comme en
# HTTP/2, a en-tetes identiques. curl passe. La difference n'est ni le protocole ni les
# en-tetes mais l'empreinte TLS, que Cloudflare reconnait.
#
# ET C'EST AUSSI POURQUOI L'IMAGE EST EN TRIXIE. Le curl 7.88 / OpenSSL 3.0 de bookworm
# recoit 403 lui aussi, quelles que soient les options TLS essayees (--http2, --tlsv1.3,
# --curves). Le curl 8.14 / OpenSSL 3.5 de trixie rend 200. C'est la version d'OpenSSL
# qui decide, pas curl. Sans elle, la famille Livres n'a pas de couverture.
# Voir src/routes/couverture.ts.
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /app/config /app/data && chown -R node:node /app

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./

USER node
EXPOSE 8480

# /sante : leger, sans base ni reseau sortant, et volontairement non protege.
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:'+(process.env.PORT||8480)+'/sante',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "dist/index.js"]
