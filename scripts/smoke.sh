#!/usr/bin/env sh
# End-to-end smoke test: builds and starts the whole stack, waits for health, hits /api/health through nginx.
#
#   scripts/smoke.sh                 # uses APP_PORT from .env (80 needs root / CAP_NET_BIND_SERVICE)
#   APP_PORT=8088 scripts/smoke.sh   # override the published port without editing .env
#   KEEP=1 scripts/smoke.sh          # leave the stack running afterwards
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

port="${APP_PORT:-$(grep -E '^APP_PORT=' .env | cut -d= -f2)}"
port="${port:-80}"

cleanup() {
  if [ -z "${KEEP:-}" ]; then
    echo "--- docker compose down (volumes kept)"
    docker compose down --remove-orphans >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

echo "--- docker compose up --build -d (APP_PORT=$port)"
APP_PORT="$port" docker compose up --build -d

echo "--- waiting for api health"
i=0
until docker compose ps --format '{{.Service}} {{.Health}}' | grep -q '^api healthy$'; do
  i=$((i + 1))
  if [ "$i" -gt 60 ]; then
    echo "api did not become healthy in time" >&2
    docker compose ps
    docker compose logs --no-color api | tail -50
    exit 1
  fi
  sleep 2
done

echo "--- docker compose ps"
docker compose ps

echo "--- GET http://localhost:$port/api/health (via nginx)"
body="$(curl -sS --max-time 10 "http://localhost:$port/api/health")"
echo "$body"
case "$body" in
  *'"ok":true'*) ;;
  *) echo "unexpected health response" >&2; exit 1 ;;
esac

echo "--- api logs (migrations / bucket)"
docker compose logs --no-color api | grep -Ei 'migration|bucket|listening' || true
echo "SMOKE OK"
