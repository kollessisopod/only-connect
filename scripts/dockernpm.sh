#!/usr/bin/env sh
# Run npm/node commands inside a Node 22 container against a THROWAWAY COPY of the repo.
# node_modules and build outputs never touch the host tree, so several of these can run concurrently.
#
#   scripts/dockernpm.sh "npm ci && npm run build -w packages/shared && npm test -w packages/shared"
#
# Optional: IMAGE=mcr.microsoft.com/playwright:v1.47.2-jammy scripts/dockernpm.sh "..."   (browser available)
# Optional: OUT=/abs/host/dir  -> mounted at /out inside the container for screenshots/artifacts.
# Optional: PORTS="-p 4173:4173" to publish ports.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="${IMAGE:-node:22-alpine}"
OUTMOUNT=""
if [ -n "${OUT:-}" ]; then
  mkdir -p "$OUT"
  OUTMOUNT="-v $OUT:/out"
fi
exec docker run --rm ${PORTS:-} \
  -v "$ROOT":/src:ro \
  -v oc-npm-cache:/root/.npm \
  $OUTMOUNT \
  -w /app \
  "$IMAGE" sh -c "mkdir -p /app && cd /src && tar --exclude=./node_modules --exclude='./*/node_modules' --exclude='./packages/*/node_modules' --exclude=./.git --exclude=./screenshots -cf - . | tar -xf - -C /app && cd /app && $1"
