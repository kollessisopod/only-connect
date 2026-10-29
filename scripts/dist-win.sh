#!/usr/bin/env sh
# Builds the portable Windows executable in Docker (docs/DESKTOP.md §6.5) — no Node, wine or Windows needed on
# the host. The repo is mounted read-write at /project because electron-builder writes desktop/release and
# npm writes node_modules; downloads are cached in named volumes so a rebuild is quick.
#
#   scripts/dist-win.sh                      # -> desktop/release/OnlyConnect-<version>.exe
#   IMAGE=electronuserland/builder:wine scripts/dist-win.sh      # another builder image tag (needs Node >= 22.12)
#
# On a Windows machine with Node 22 the same steps are:
#   npm ci && npm run build && npm run build -w desktop && npm run dist:win -w desktop
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="${IMAGE:-electronuserland/builder:22-wine}"

echo "--- building the Windows exe in $IMAGE"
docker run --rm \
  -v "$ROOT":/project \
  -v oc-npm-cache:/root/.npm \
  -v oc-electron-cache:/root/.cache/electron \
  -v oc-electron-builder-cache:/root/.cache/electron-builder \
  -e ELECTRON_CACHE=/root/.cache/electron \
  -e ELECTRON_BUILDER_CACHE=/root/.cache/electron-builder \
  -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
  -w /project \
  "$IMAGE" sh -c '
    set -eu
    # Everything npm / electron-builder wrote belongs to the host user afterwards, not root.
    trap "chown -R $HOST_UID:$HOST_GID /project/node_modules /project/*/node_modules /project/packages/*/node_modules /project/*/dist /project/packages/*/dist /project/desktop/release 2>/dev/null || true" EXIT
    echo "--- node $(node --version), npm $(npm --version)"
    echo "--- npm ci"
    if ! npm ci --no-audit --no-fund; then
      echo "--- npm ci failed (stale package-lock.json?), falling back to npm install"
      npm install --no-audit --no-fund
    fi
    echo "--- npm run build (shared, api, client)"
    npm run build
    echo "--- npm run build -w desktop"
    npm run build -w desktop
    echo "--- npm run dist:win -w desktop"
    npm run dist:win -w desktop
  '

EXE="$(ls -t "$ROOT"/desktop/release/OnlyConnect-*.exe 2>/dev/null | head -n 1 || true)"
if [ -z "$EXE" ]; then
  echo "no OnlyConnect-*.exe found under desktop/release" >&2
  exit 1
fi
SIZE="$(du -h "$EXE" | cut -f1)"
echo "--- built $EXE ($SIZE)"
