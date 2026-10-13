# Build context: the repository root (the client depends on packages/shared).
#   docker build -f client/Dockerfile -t only-connect-client .
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY client/package.json client/
# api/package.json is copied only because the root workspaces list names it; its deps are not installed.
COPY api/package.json api/
RUN npm ci --no-audit --no-fund --workspace packages/shared --workspace client
COPY packages/shared packages/shared
COPY client client
RUN npm run build -w packages/shared && npm run build -w client

FROM nginx:1.27-alpine
COPY client/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/client/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1
