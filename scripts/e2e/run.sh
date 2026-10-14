#!/usr/bin/env sh
# Runs the browser end-to-end game (e2e.mjs) inside the Playwright image against a running stack, and acts as
# the "host runner" for the api-restart test: when the script drops $OUT/restart.request this runner
# executes `docker compose restart api` and touches restart.done.
#
#   APP_PORT=8089 docker compose up --build -d          # the stack must be running
#   scripts/e2e/run.sh                                  # demo scenario: screenshots + e2e-log.txt in $WORK/e2e
#   E2E_SCENARIO=big scripts/e2e/run.sh                 # 12+12 questions / 4 walls scenario, output in $WORK/e2e-big
#
# Environment:
#   WORK          host directory for node_modules + output (default ~/.cache/oc-e2e; must be mountable by Docker)
#   BASE_URL      stack URL as seen from the container (default http://localhost:${APP_PORT:-8089}, --network host)
#   RESTART       "file" (default: restart the api mid-game through this runner) or "skip"
#   E2E_SCENARIO  "demo" (default, the seeded Demo pack) or "big" (creates "E2E big pack" through the admin API)
#   IMAGE         Playwright image (default mcr.microsoft.com/playwright:v1.47.2-jammy)
set -eu
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="${WORK:-$HOME/.cache/oc-e2e}"
IMAGE="${IMAGE:-mcr.microsoft.com/playwright:v1.47.2-jammy}"
BASE_URL="${BASE_URL:-http://localhost:${APP_PORT:-8089}}"
RESTART="${RESTART:-file}"
E2E_SCENARIO="${E2E_SCENARIO:-demo}"
case "$E2E_SCENARIO" in
  big) OUTSUB=e2e-big ;;
  *) OUTSUB=e2e ;;
esac
OUT="$WORK/$OUTSUB"

mkdir -p "$OUT"
cp "$ROOT/scripts/e2e/e2e.mjs" "$WORK/e2e.mjs"
rm -f "$OUT/restart.request" "$OUT/restart.done"

docker run --rm --network host \
  -v "$WORK":/work -w /work \
  -e BASE_URL="$BASE_URL" -e OUT_DIR="/work/$OUTSUB" -e RESTART_MODE="$RESTART" -e E2E_SCENARIO="$E2E_SCENARIO" \
  "$IMAGE" sh -c '
    if [ ! -d node_modules/playwright ] || [ ! -d node_modules/socket.io-client ]; then
      npm init -y >/dev/null 2>&1 || true
      npm install --no-audit --no-fund playwright@1.47.2 socket.io-client@4.8.1 >/dev/null
    fi
    node e2e.mjs' &
RUNNER=$!

# Restart handshake: the browser script cannot reach Docker, so it asks us through a file.
while kill -0 "$RUNNER" 2>/dev/null; do
  if [ -f "$OUT/restart.request" ]; then
    rm -f "$OUT/restart.request"
    echo "--- restart request received: docker compose restart api"
    (cd "$ROOT" && docker compose restart api)
    touch "$OUT/restart.done"
  fi
  sleep 1
done
wait "$RUNNER"
