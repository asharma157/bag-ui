FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production

# Dependencies first so source-only changes reuse the cached layer.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server.js ./
COPY src ./src
COPY public ./public

USER node

# APP_VERSION is supplied at runtime (downward API in Kubernetes, env in compose)
# so the same image can be deployed as any version.
EXPOSE 8080
CMD ["node", "server.js"]
