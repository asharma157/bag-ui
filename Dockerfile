FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

# Dependencies first so source-only changes reuse the cached layer.
# `npm ci` installs exactly what the lockfile pins and fails if the two have drifted,
# so a CI build can never quietly resolve a different dependency tree than a local one.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY server.js ./
COPY src ./src
COPY public ./public

# Numeric, not `USER node`. Kubernetes' runAsNonRoot check cannot verify that a
# *named* user is non-root and refuses to start the container; 1000 is the uid of
# the image's built-in `node` user.
USER 1000

# APP_VERSION is supplied at runtime (downward API in Kubernetes, env in compose)
# so the same image can be deployed as any version.
EXPOSE 8080
CMD ["node", "server.js"]
