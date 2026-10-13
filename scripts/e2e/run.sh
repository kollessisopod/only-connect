#!/usr/bin/env sh
# Runs the browser end-to-end game (e2e.mjs) inside the Playwright image against a running stack, and acts as
# the "host runner" for the api-restart test: when the script drops $WORK/e2e/restart.request this runner
# executes `docker compose restart api` and touches restart.done.
#
#   APP_PORT=8089 docker compose up --build -d          # the stack must be running
#   scripts/e2e/run.sh                                  # screenshots + e2e-log.txt in $WORK/e2e
#
# Environment:
#   WORK        host directory for node_modules + output (default ~/.cache/oc-e2e; must be mountable by Docker)
#   BASE_URL    stack URL as seen from the container (default http://localhost:${APP_PORT:-8089}, --network host)
#   RESTART     "file" (default: restart the api mid-game through this runner) or "skip"
#   IMAGE       Playwright image (default mcr.microsoft.com/playwright:v1.47.2-jammy)
set -eu
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="${WORK:-$HOME/.cache/oc-e2e}"
IMAGE="${IMAGE:-mcr.microsoft.com/playwright:v1.47.2-jammy}"
BASE_URL="${BASE_URL:-http://localhost:${APP_PORT:-8089}}"
RESTART="${RESTART:-file}"

mkdir -p "$WORK/e2e"
cp "$ROOT/scripts/e2e/e2e.mjs" "$WORK/e2e.mjs"
rm -f "$WORK/e2e/restart.request" "$WORK/e2e/restart.done"

docker run --rm --network host \
  -v "$WORK":/work -w /work \
  -e BASE_URL="$BASE_URL" -e OUT_DIR=/work/e2e -e RESTART_MODE="$RESTART" \
  "$IMAGE" sh -c '
    if [ ! -d node_modules/playwright ] || [ ! -d node_modules/socket.io-client ]; then
      npm init -y >/dev/null 2>&1 || true
      npm install --no-audit --no-fund playwright@1.47.2 socket.io-client@4.8.1 >/dev/null
    fi
    node e2e.mjs' &
RUNNER=$!

# Restart handshake: the browser script cannot reach Docker, so it asks us through a file.
while kill -0 "$RUNNER" 2>/dev/null; do
  if [ -f "$WORK/e2e/restart.request" ]; then
    rm -f "$WORK/e2e/restart.request"
    echo "--- restart request received: docker compose restart api"
    (cd "$ROOT" && docker compose restart api)
    touch "$WORK/e2e/restart.done"
  fi
  sleep 1
done
wait "$RUNNER"
