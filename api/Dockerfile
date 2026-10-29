# syntax=docker/dockerfile:1.7
# Only Connect API. Build context is the repository root (see docker-compose.yml).

# ---------- build: install all deps, compile shared + api ----------
FROM node:22-alpine AS build
WORKDIR /app
ENV NPM_CONFIG_UPDATE_NOTIFIER=false

# Manifests first so the dependency layer is cached independently of source changes.
# client/ and desktop/ package.json are copied only because the root workspaces list names them; their deps are not installed.
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY api/package.json api/
COPY client/package.json client/
COPY desktop/package.json desktop/
RUN npm ci --no-audit --no-fund --workspace packages/shared --workspace api

COPY packages/shared/ packages/shared/
COPY api/ api/
RUN npm run build -w packages/shared && npm run build -w api

# ---------- runtime: production deps + compiled output only ----------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    PORT=3000

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY api/package.json api/
COPY client/package.json client/
COPY desktop/package.json desktop/
RUN npm ci --no-audit --no-fund --omit=dev --workspace packages/shared --workspace api \
    && npm cache clean --force

COPY --chown=node:node --from=build /app/packages/shared/dist/ packages/shared/dist/
COPY --chown=node:node --from=build /app/api/dist/ api/dist/
COPY --chown=node:node api/migrations/ api/migrations/

# The process never writes under /app (uploads go to the bucket, state to Postgres), so root-owned,
# read-only node_modules are fine for the unprivileged user; a `chown -R` here would duplicate that layer.
USER node

EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=6 \
  CMD wget -qO- http://127.0.0.1:3000/api/health >/dev/null || exit 1

CMD ["node", "api/dist/server.js"]
