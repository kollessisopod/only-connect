#!/usr/bin/env sh
# Standalone end-to-end check (docs/DESKTOP.md §6.5): runs the API the way the Windows exe runs it — embedded
# PGlite database, media files on disk, the built client served by the API itself, no Postgres / MinIO / nginx —
# but under plain Node in a node:22-alpine container, then plays the browser end-to-end scenarios of
# scripts/e2e/run.sh against it.
#
#   scripts/standalone-e2e.sh                       # build, start, run demo + big + teams4, stop
#   SCENARIOS="demo" scripts/standalone-e2e.sh      # a subset (space separated: demo big teams4)
#   SKIP_BUILD=1 scripts/standalone-e2e.sh          # reuse the previous build (volume oc-standalone-app)
#   KEEP=1 scripts/standalone-e2e.sh                # leave the server running afterwards (stop: docker rm -f oc-standalone-api)
#   KEEP_DATA=1 scripts/standalone-e2e.sh           # keep the previous run's database + media (volume oc-standalone-data)
#
# Steps:
#   1. build  — like scripts/dockernpm.sh, a THROWAWAY COPY of the repo is tar-copied into a container (npm cache
#               volume oc-npm-cache), `npm ci` (falls back to `npm install` when package-lock.json is stale), root
#               `npm run build` (shared → api → client). The output lives in the named volume oc-standalone-app, so
#               nothing is written to the host tree.
#   2. server — `node api/dist/server.js` from that volume with DATABASE_DRIVER=pglite PGLITE_DIR=/data/db
#               STORAGE_DRIVER=fs MEDIA_DIR=/data/media SERVE_CLIENT_DIR=/app/client/dist PORT=8089 (data in the named
#               volume oc-standalone-data, wiped first unless KEEP_DATA=1); ADMIN_USERNAME / ADMIN_PASSWORD /
#               JWT_SECRET come from the repo .env (documented defaults when missing). Waits for /api/health and
#               checks that /admin is served as the SPA.
#   3. e2e    — scripts/e2e/run.sh with RESTART=skip for every scenario; output under $WORK/standalone-<scenario>/
#               (run.sh's own layout inside it: e2e/, e2e-big/, e2e-teams4/ with the screenshots and e2e-log.txt,
#               plus run-<scenario>.log). The last 3 log lines of every scenario are printed; exit 1 if any failed.
#   The server container is always removed at the end (trap), its log is kept in $WORK/standalone-server.log.
#
# Environment:
#   WORK       host directory for the runner's node_modules and the output (default ~/.cache/oc-e2e)
#   PORT       port the server listens on and publishes (default 8089)
#   IMAGE      Node image for the build and the server (default node:22-alpine)
#   NETWORK    `publish` (default, `-p PORT:PORT`, works with Docker Engine and Docker Desktop) or `host`
#              (`--network host`; on Docker Desktop that is a plain bridge namespace and the host cannot reach it)
#   BASE_URL   how the e2e runner container (`--network host`) reaches the server; probed when unset:
#              localhost, then host.docker.internal (Docker Desktop), then 172.17.0.1
#   LOG_LEVEL  API log level (default info)
#   Docker is used as is: with Docker Desktop export DOCKER_HOST=unix://$HOME/.docker/desktop/docker.sock first.
# The e2e script logs in as admin / 12346789 (ADMIN_USER / ADMIN_PASS are not forwarded by run.sh): with other
# credentials in .env the login step fails — a warning is printed.
set -eu
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${WORK:-$HOME/.cache/oc-e2e}"
PORT="${PORT:-8089}"
IMAGE="${IMAGE:-node:22-alpine}"
SCENARIOS="${SCENARIOS:-demo big teams4}"
NETWORK="${NETWORK:-publish}"
NAME=oc-standalone-api
APPVOL=oc-standalone-app
DATAVOL=oc-standalone-data

# Value of KEY in the repo .env (first match, surrounding double quotes stripped), or DEFAULT.
envval() {
  v="$(grep -E "^$1=" "$ROOT/.env" 2>/dev/null | head -1 | cut -d= -f2- | sed 's/^"\(.*\)"$/\1/')"
  printf '%s' "${v:-$2}"
}
ADMIN_USERNAME="$(envval ADMIN_USERNAME admin)"
ADMIN_PASSWORD="$(envval ADMIN_PASSWORD 12346789)"
JWT_SECRET="$(envval JWT_SECRET 12346789)"
if [ "$ADMIN_USERNAME" != admin ] || [ "$ADMIN_PASSWORD" != 12346789 ]; then
  echo "WARNING: .env has non-default admin credentials; scripts/e2e/e2e.mjs logs in as admin / 12346789 and will fail" >&2
fi

mkdir -p "$WORK"

cleanup() {
  status=$?
  if docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "$NAME"; then
    docker logs "$NAME" > "$WORK/standalone-server.log" 2>&1 || true
    echo "--- server log saved to $WORK/standalone-server.log"
    if [ -n "${KEEP:-}" ]; then
      echo "--- KEEP=1: $NAME left running on port $PORT (docker rm -f $NAME to stop it)"
    else
      echo "--- stopping server container $NAME"
      docker rm -f "$NAME" >/dev/null 2>&1 || true
    fi
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# ---------- 1. build ----------
TAR_COPY="cd /src && tar --exclude=./node_modules --exclude='./*/node_modules' --exclude='./packages/*/node_modules' --exclude=./.git --exclude=./screenshots -cf - . | tar -xf - -C /app && cd /app"
if [ -z "${SKIP_BUILD:-}" ]; then
  echo "--- building shared + api + client in $IMAGE (throwaway copy → volume $APPVOL)"
  docker run --rm \
    -v "$ROOT":/src:ro \
    -v oc-npm-cache:/root/.npm \
    -v "$APPVOL":/app \
    -w /app \
    "$IMAGE" sh -c "find /app -mindepth 1 -maxdepth 1 -exec rm -rf {} + && $TAR_COPY \
      && (npm ci --no-audit --no-fund || { echo '--- npm ci failed (package-lock.json out of date?); using npm install'; npm install --no-audit --no-fund; }) \
      && npm run build" || { echo "BUILD FAILED" >&2; exit 1; }
fi
if ! docker run --rm -v "$APPVOL":/app "$IMAGE" sh -c 'test -f /app/api/dist/server.js && test -f /app/client/dist/index.html'; then
  echo "no build in volume $APPVOL (api/dist/server.js or client/dist/index.html missing); run without SKIP_BUILD" >&2
  exit 1
fi

# ---------- 2. server ----------
if [ -z "${KEEP_DATA:-}" ]; then
  echo "--- wiping data volume $DATAVOL (KEEP_DATA=1 keeps it)"
  docker run --rm -v "$DATAVOL":/data "$IMAGE" sh -c 'find /data -mindepth 1 -maxdepth 1 -exec rm -rf {} +'
fi
docker rm -f "$NAME" >/dev/null 2>&1 || true
case "$NETWORK" in
  host) NETOPT="--network host" ;;
  *) NETOPT="-p $PORT:$PORT" ;;
esac
echo "--- starting $NAME: node api/dist/server.js (pglite + fs + SERVE_CLIENT_DIR, port $PORT, $NETOPT)"
# shellcheck disable=SC2086 # NETOPT is meant to split
docker run -d --name "$NAME" $NETOPT \
  -v "$APPVOL":/app -v "$DATAVOL":/data -w /app \
  -e NODE_ENV=production -e PORT="$PORT" -e HOST=0.0.0.0 -e LOG_LEVEL="${LOG_LEVEL:-info}" \
  -e DATABASE_DRIVER=pglite -e PGLITE_DIR=/data/db \
  -e STORAGE_DRIVER=fs -e MEDIA_DIR=/data/media \
  -e SERVE_CLIENT_DIR=/app/client/dist \
  -e ADMIN_USERNAME="$ADMIN_USERNAME" -e ADMIN_PASSWORD="$ADMIN_PASSWORD" -e JWT_SECRET="$JWT_SECRET" \
  "$IMAGE" node api/dist/server.js >/dev/null

HEALTH="http://localhost:$PORT/api/health"
echo "--- waiting for $HEALTH"
i=0
while ! curl -sf --max-time 3 "$HEALTH" 2>/dev/null | grep -q '"ok":true'; do
  if ! docker ps --format '{{.Names}}' | grep -qx "$NAME"; then
    echo "SERVER EXITED before becoming healthy — last log lines:" >&2
    docker logs --tail 40 "$NAME" >&2 || true
    exit 1
  fi
  i=$((i + 1))
  if [ "$i" -gt 90 ]; then
    echo "SERVER NOT HEALTHY after 90 s ($HEALTH) — last log lines:" >&2
    docker logs --tail 40 "$NAME" >&2 || true
    exit 1
  fi
  sleep 1
done
echo "--- healthy after ${i}s: $(curl -s --max-time 3 "$HEALTH")"

spa="$(curl -s --max-time 5 -o /dev/null -w '%{http_code} %{content_type}' "http://localhost:$PORT/admin" || true)"
case "$spa" in
  200\ text/html*) echo "--- GET /admin → $spa (SPA served by the API)" ;;
  *) echo "GET /admin → '$spa': the API does not serve the client (SERVE_CLIENT_DIR); last log lines:" >&2
     docker logs --tail 20 "$NAME" >&2 || true
     exit 1 ;;
esac

# ---------- 3. e2e ----------
if [ -z "${BASE_URL:-}" ]; then
  for cand in "http://localhost:$PORT" "http://host.docker.internal:$PORT" "http://172.17.0.1:$PORT"; do
    if docker run --rm --network host "$IMAGE" wget -qO- --timeout=3 "$cand/api/health" 2>/dev/null | grep -q '"ok":true'; then
      BASE_URL="$cand"
      break
    fi
  done
  if [ -z "${BASE_URL:-}" ]; then
    echo "the e2e runner container (--network host) cannot reach the server (tried localhost, host.docker.internal, 172.17.0.1); set BASE_URL" >&2
    exit 1
  fi
fi
echo "--- e2e runner will use BASE_URL=$BASE_URL"

failed=""
summary=""
for s in $SCENARIOS; do
  case "$s" in
    demo) sub=e2e ;;
    big) sub=e2e-big ;;
    teams4) sub=e2e-teams4 ;;
    *) echo "unknown scenario '$s' (demo, big, teams4)" >&2; exit 2 ;;
  esac
  RW="$WORK/standalone-$s"
  mkdir -p "$RW"
  # Reuse the Playwright runner's node_modules from the compose e2e runs instead of installing them again.
  if [ ! -d "$RW/node_modules/playwright" ] && [ -d "$WORK/node_modules/playwright" ]; then
    cp -a "$WORK/node_modules" "$RW/node_modules"
    [ -f "$WORK/package.json" ] && cp "$WORK/package.json" "$RW/package.json"
  fi
  echo "=== scenario $s → $RW/$sub"
  rm -f "$RW/.status"
  { E2E_SCENARIO="$s" WORK="$RW" BASE_URL="$BASE_URL" RESTART=skip APP_PORT="$PORT" "$ROOT/scripts/e2e/run.sh" 2>&1; echo "$?" > "$RW/.status"; } | tee "$RW/run-$s.log"
  st="$(cat "$RW/.status" 2>/dev/null || echo 1)"
  echo "--- $s exit $st; last 3 lines of $RW/$sub/e2e-log.txt:"
  tail -3 "$RW/$sub/e2e-log.txt" 2>/dev/null || tail -3 "$RW/run-$s.log"
  if [ "$st" = 0 ]; then summary="$summary\n  ok      $s"; else summary="$summary\n  FAILED  $s"; failed="$failed $s"; fi
done

printf '=== standalone e2e summary%b\n' "$summary"
if [ -n "$failed" ]; then
  echo "FAILED:$failed" >&2
  exit 1
fi
echo "STANDALONE E2E OK"
