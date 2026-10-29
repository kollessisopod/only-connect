#!/usr/bin/env sh
# Headless Linux check of the real Electron app (docs/DESKTOP.md §6.5): builds shared + client + desktop in a
# throwaway copy of the repo inside the Playwright image, then drives the window with Playwright's `_electron`
# under xvfb-run (desktop-smoke.mjs): waits for "running" on port $PORT, checks /api/health and the SPA at
# /admin, clicks Copy on the buzzer link and reads the clipboard back, screenshots the window, stops the
# server from the UI and checks the port is released.
#
#   scripts/desktop-smoke.sh                 # output: $WORK/desktop-smoke/{window.png,smoke-log.txt,electron-*.txt}
#
# Environment:
#   WORK   host directory for tools + output (default ~/.cache/oc-e2e; must be mountable by Docker)
#   PORT   port the app is told to use through its settings.json (default 8089)
#   IMAGE  Playwright image (default mcr.microsoft.com/playwright:v1.47.2-jammy — has xvfb; its Node 20 is too old
#          for Electron 44, so a Node tarball is downloaded once into $WORK/desktop-smoke-tools)
#   NODE_VERSION  Node used inside the container (default 22.12.0)
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${WORK:-$HOME/.cache/oc-e2e}"
IMAGE="${IMAGE:-mcr.microsoft.com/playwright:v1.47.2-jammy}"
PORT="${PORT:-8089}"
NODE_VERSION="${NODE_VERSION:-22.12.0}"
OUT="$WORK/desktop-smoke"
TOOLS="$WORK/desktop-smoke-tools"

mkdir -p "$OUT" "$TOOLS"
cp "$ROOT/scripts/desktop-smoke.mjs" "$TOOLS/desktop-smoke.mjs"

docker run --rm --network host \
  -v "$ROOT":/src:ro \
  -v "$WORK":/work \
  -v oc-npm-cache:/root/.npm \
  -v oc-electron-cache:/root/.cache/electron \
  -e OUT_DIR=/work/desktop-smoke -e PORT="$PORT" -e NODE_VERSION="$NODE_VERSION" \
  -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
  "$IMAGE" bash -c '
    set -eu
    trap "chown -R $HOST_UID:$HOST_GID /work/desktop-smoke /work/desktop-smoke-tools 2>/dev/null || true" EXIT
    echo "--- copying the repo into a throwaway /app"
    mkdir -p /app
    (cd /src && tar --exclude=./node_modules --exclude="./*/node_modules" --exclude="./packages/*/node_modules" \
        --exclude=./.git --exclude=./screenshots -cf - . | tar -xf - -C /app)
    # The v1.47.2 Playwright image ships Node 20; Electron >= 44 needs Node >= 22.12 to install and run its
    # tooling. A Node 22 tarball is fetched once into the work dir and reused.
    NODE_DIR=/work/desktop-smoke-tools/node-v$NODE_VERSION
    if [ ! -x "$NODE_DIR/bin/node" ]; then
      echo "--- fetching Node $NODE_VERSION (image has $(node --version))"
      rm -rf "$NODE_DIR" && mkdir -p "$NODE_DIR"
      curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.gz" | tar -xz --no-same-owner --strip-components=1 -C "$NODE_DIR"
    fi
    export PATH="$NODE_DIR/bin:$PATH"
    cd /app
    echo "--- npm install (node $(node --version))"
    npm install --no-audit --no-fund
    echo "--- building shared, client and desktop"
    npm run build -w packages/shared
    npm run build -w client
    npm run build -w desktop
    cd /work/desktop-smoke-tools
    if [ ! -d node_modules/playwright ]; then
      echo "--- installing playwright@1.47.2 for the smoke script"
      npm init -y >/dev/null 2>&1 || true
      npm install --no-audit --no-fund playwright@1.47.2 >/dev/null
    fi
    # Electron >= 44 has no postinstall: the binary is downloaded on the first require (cached in ~/.cache/electron).
    echo "--- resolving the Electron binary"
    (cd /app && node -e "require(\"electron\")")
    ELECTRON_PATH="$(cd /app && node -p "require(\"electron\")")"
    echo "electron: $ELECTRON_PATH"
    echo "--- running the Electron smoke under xvfb"
    APP_DIR=/app/desktop ELECTRON_PATH="$ELECTRON_PATH" \
      xvfb-run -a --server-args="-screen 0 1280x900x24" node /work/desktop-smoke-tools/desktop-smoke.mjs
  '

echo "--- output in $OUT (window.png, smoke-log.txt)"
