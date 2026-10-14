# Only Connect

> **Version 2 — pushed 2026-10-14 08:09 +03**

A self-hosted simulation of the BBC quiz show *Only Connect*: a public monitor screen, a touch panel for the
Connecting Wall, phone buzzers for Missing Vowels and a game-master console with a question-pack editor
(images and audio go into an S3-compatible bucket). Everything runs from one `docker compose up`.

## Run it

Requirements: Docker with the Compose plugin. Nothing else — Node is not needed on the host.

```sh
docker compose up --build -d        # first start: builds the images, migrates the DB, creates the bucket,
                                    # seeds the "Demo pack" (a complete playable game) and its media
docker compose ps                   # wait until api and client are "healthy" (~30 s on first boot)
```

Then open (replace `<host>` with `localhost`, or the VM's IP; all URLs are relative so any host works):

| Screen   | URL                      | Who / what                                                      |
| -------- | ------------------------ | --------------------------------------------------------------- |
| Monitor  | `http://<host>/monitor`  | the big screen everyone watches (click once to enable sound)    |
| Wall     | `http://<host>/wall`     | touch panel the playing team taps during the Connecting Wall    |
| Button   | `http://<host>/button`   | every player's phone: name + team, then a buzzer (Missing Vowels)|
| Admin    | `http://<host>/admin`    | the game master: login, drive the game, edit question packs     |

`http://<host>/` redirects to `/monitor`. Default login for `/admin`: **admin / 12346789**.

Stop with `docker compose down` (data is kept in the named volumes `pgdata` and `miniodata`; add `-v` to wipe
the database and bucket, which also re-seeds the demo pack on the next start).

### Ports and credentials (`.env`)

Everything lives in the root `.env` file (tracked in the repo on purpose so you can edit it in place; `.env.example`
mirrors it). Change every password there before exposing the app. (Without a `.env` the stack still starts with the documented defaults
below; the API logs a warning at boot for every default password it finds.) Change the credentials **before
the first start** if you can — see *Changing credentials* for the Postgres caveat.

| Variable                                | Default      | Purpose                                             |
| --------------------------------------- | ------------ | --------------------------------------------------- |
| `APP_PORT`                              | `80`         | the only port the app publishes on all interfaces   |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD`     | `admin` / `12346789` | `/admin` login (5 wrong guesses per client, then one per 12 s) |
| `JWT_SECRET`                            | `12346789`   | signs admin session tokens (12 h); use 32+ random characters (`openssl rand -base64 32`) |
| `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` | `admin` / `12346789` / `onlyconnect` | database |
| `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` | `admin` / `12346789` | object store (also used by the API as S3 keys) |
| `MINIO_BUCKET`                          | `media`      | bucket for uploaded images/audio                    |
| `MINIO_CONSOLE_PORT` / `MINIO_CONSOLE_BIND` | `9001` / `127.0.0.1` | MinIO web console, published on the loopback interface only (`ssh -L 9001:127.0.0.1:9001 <vm>` to reach it; `MINIO_CONSOLE_BIND=0.0.0.0` publishes it to everyone) |
| `LOG_LEVEL`                             | `info`       | API log level (`debug`, `info`, `warn`, `error`, `silent`) |
| `ALLOWED_ORIGINS`                       | *(empty)*    | extra browser origins allowed to call the API; the app's own origin always is |

#### Changing credentials

* `ADMIN_*`, `JWT_SECRET`, `MINIO_*`: edit `.env` and `docker compose up -d` (the API and MinIO pick the new
  values up; admin sessions are invalidated by a new `JWT_SECRET`).
* `POSTGRES_PASSWORD` is applied by the Postgres image **only when the data volume is created**. Changing it in
  `.env` after the first start makes the API fail with `password authentication failed` (it retries for 60 s,
  then the container restarts and `docker compose up` reports `dependency failed to start`). Either change it
  before the first boot, or change it in the database first and then in `.env`:
  ```sh
  docker compose exec db psql -U admin -d onlyconnect -c "ALTER USER admin PASSWORD 'new-password';"
  # now put the same password in .env, then
  docker compose up -d
  ```
  (`docker compose down -v` also works but wipes the database and the bucket.)

#### HTTPS

The stack serves plain HTTP on `APP_PORT`; on a public VM put a TLS terminator in front of it so the admin
password and session token do not cross the internet in clear. Everything is proxy-ready (relative URLs,
websocket upgrade, `trustProxy`). The simplest option is a Caddy sidecar — add to `docker-compose.yml`:

```yaml
  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports: ["80:80", "443:443"]
    command: caddy reverse-proxy --from quiz.example.com --to client:80
    volumes: [caddydata:/data]
    depends_on: [client]
# and add `caddydata:` under volumes
```

then set `APP_PORT=127.0.0.1:8080` (so nginx is not published directly) and point the DNS name at the VM; Caddy
obtains and renews the certificate itself. A GCP HTTPS load balancer in front of `APP_PORT` works the same way.

## Playing a game

1. **Admin → Game → New game**: pick a pack (only *playable* packs can be started), name the two teams, choose
   who picks first, *Start game*. The monitor shows the lobby.
2. Players open `/button` on their phones, enter a name and pick pink or blue. They appear in the admin status
   panel and on the monitor's player count; a reload or a dropped connection re-joins them automatically.
3. **Round 1 Connections / Round 2 Sequences**: click the hieroglyph the team chose, *Reveal next clue* (R),
   *Correct* (C) / *Incorrect / pass* (X) → the other team may steal for 1 point, *Next question* (N). Audio
   clues play on the monitor when revealed (a judgement that reveals several at once plays the first and offers
   a *Play clue N* button for each); *Play audio again* replays them. The host panel shows the answer and the
   note for every question. *Void question* skips a broken question (missing media, pack error): nothing is
   revealed, no steal, the question still counts towards the round. A round has as many questions as the
   pack holds for it (1 to 12, one hieroglyph each; the monitor shows a 3-column board for up to six and a
   4-column board above that) and ends when every one has been played.
4. **Round 3 Connecting Wall**: the walls are chosen by hieroglyph exactly like the questions. The monitor shows
   the pack's wall glyphs (2 or 4 large tiles); the team behind on score (a tie goes to the team that picked
   first) chooses one, you click it in the admin's wall picker, then *Start wall*. The team taps tiles on
   `/wall` (3 minutes, 3 lives after two groups). When the wall ends, *Resolve wall* reveals the remaining
   groups, you ask the team for each connection and mark it correct/incorrect, then *Finish wall* awards the
   points (1 per group + 1 per connection, +2 for a perfect wall) and *Clear wall* brings the glyph board back
   for the other team (chosen walls are dark). Teams strictly alternate (A, B with 2 walls; A, B, A, B with 4)
   and the round ends when every wall has been played. *Time up* asks for a confirmation; *Abort wall* hands a
   wall that was chosen or started by mistake back without scoring it (its glyph lights up again and the same
   team chooses again).
5. **Round 4 Missing Vowels**: *Show clue* (Space) opens the buzzers; the first buzz the server receives wins
   and locks the others out. *Correct* (+1) / *Incorrect* (−1, then *Other team correct* or *Nobody*),
   *Reopen buzzers* for a false buzz, *Next clue*, *Skip category*. Players cannot switch teams during this
   round.
6. **Final scores** shows both scores and the winner on the monitor. Scores can be corrected with ±1 / ±5 at
   any time.

**Mistakes**: *Undo* (Z) reverts the last admin action (a wrong judgement, a stray *Next*, an accidental round
switch…); up to 20 steps, until the API restarts. Players who joined in the meantime are kept.

**Leaving a round**: the round buttons switch rounds at any time between questions, but a round that is under
way asks for a confirmation and is *paused*, not lost: its button reads *resume* and brings it back exactly
where it was (used hieroglyphs, score, walls already played, current category). *Back to lobby* behaves the same.
A round that is already in progress cannot be restarted from its own button, and a finished round never can.

## Adding your own questions

**Admin → Packs**. *New pack* creates an empty pack; *Duplicate* copies an existing one (the demo pack is a
good starting point). A pack is playable when it has:

* 1 to 12 Connections questions and 1 to 12 Sequences questions, each tagged with a different hieroglyph
  within its round (Two Reeds, Lion, Twisted Flax, Horned Viper, Water, Eye of Horus — the show's six — then
  Ankh, Scarab, Feather, Owl, Cobra, Sun for bigger rounds), each with 4 clues (for Sequences the 4th clue is
  the hidden answer tile) and an answer (plus an optional host note);
* exactly 2 or 4 walls of 4 groups × 4 clues with a connection per group, each wall tagged with its own
  hieroglyph (new walls get Lion, Water, then the rest) — the glyph the team chooses it by;
* at least one Missing Vowels category with at least one clue (the vowel-less display is generated from the
  answer and can be hand-edited).

Clues can be text, an image or an audio file: choose the kind on the clue row and *Upload* (PNG/JPEG/WebP/GIF
images and audio up to 25 MB — SVG is refused; they are stored in the bucket and streamed through
`/api/media/...`). The editor shows the remaining problems until the pack is playable, and *Save* writes the
whole pack. Clue text is written as you want it shown on screen (the show uses short, title-case clues: the
editor warns above 60 characters and for wall words over 13 letters, which are shrunk to fit their tile).

### Export, import and backup

*Export* on the packs page downloads a pack as `<name>.only-connect.json`; *Import…* creates a new pack from
such a file (also `GET /api/admin/packs/:id/export` and `POST /api/admin/packs/import`). Images and audio are
referenced by key, so a pack moved to another instance needs its media copied too — or simply back up and
restore both volumes:

```sh
# database (packs, games) and bucket (media), run from the repo directory
docker compose exec db pg_dump -U admin onlyconnect > backup.sql
docker run --rm -v only-connect_miniodata:/data -v "$PWD":/b alpine tar czf /b/miniodata.tgz -C /data .

# restore on a fresh instance (after `docker compose up -d` created the volumes)
docker compose exec -T db psql -U admin onlyconnect < backup.sql
docker run --rm -v only-connect_miniodata:/data -v "$PWD":/b alpine sh -c "cd /data && tar xzf /b/miniodata.tgz"
```

Uploads that no pack uses any more are deleted when their pack is deleted; `POST /api/admin/media/sweep`
(with the admin token) removes any other orphaned uploads older than an hour, and
`GET /api/admin/media/orphans` lists them first.

## Architecture

```
browser ──:80──> client (nginx) ──/api, /socket.io──> api (Node 22 + Fastify + socket.io)
                                                         ├──> db (Postgres 16)
                                                         └──> minio (S3-compatible bucket "media")
```

* **client** — Vite + React single-page app built to static files and served by nginx, which proxies `/api/`
  and `/socket.io/` to the API. Nothing is loaded from the internet at runtime (fonts and assets are vendored).
* **api** — Fastify 4 + socket.io 4. Holds the authoritative game state in memory, persists every change to
  Postgres and broadcasts a public projection (monitor / wall / button) and a full projection (`/admin`
  namespace, JWT required). Runs `api/migrations/*.sql` on boot, creates the bucket if it is missing and seeds
  the demo pack when there are no packs. The wall timer and buzz order are decided by the server.
* **db** — `postgres:16-alpine`, named volume `pgdata`. The current game survives an API restart.
* **minio** — S3-compatible object store for images and audio, named volume `miniodata`. Media is always
  streamed through the API (`/api/media/<key>`), never served from the bucket directly.
* **packages/shared** — the TypeScript contract (`src/types.ts`) and the pure, deterministic game engine
  used by both api and client.

The full specification (rules, state model, HTTP/socket API, design tokens) is in [`docs/SPEC.md`](docs/SPEC.md).

## Development and tests

Node is not required on the host; `scripts/dockernpm.sh` runs any npm command inside a `node:22-alpine`
container against a throwaway copy of the repository (dependencies are pinned by `package-lock.json`):

```sh
# install, build everything and run the unit tests (shared engine + api)
scripts/dockernpm.sh "npm ci --no-audit --no-fund && npm run build && npm test"

# only the engine tests
scripts/dockernpm.sh "npm ci --no-audit --no-fund && npm run build -w packages/shared && npm test -w packages/shared"

# type-check all workspaces
scripts/dockernpm.sh "npm ci --no-audit --no-fund && npm run typecheck"
```

Browser end-to-end test (plays a whole game through all five screens in headless Chromium, restarts the API
mid-game, screenshots every stage — see [`scripts/e2e/README.md`](scripts/e2e/README.md)):

```sh
APP_PORT=8089 docker compose up --build -d
scripts/e2e/run.sh                   # Demo pack (6 + 6 questions, 2 walls): ~/.cache/oc-e2e/e2e/
E2E_SCENARIO=big scripts/e2e/run.sh  # creates a 12 + 12 question / 4 wall pack and plays it: ~/.cache/oc-e2e/e2e-big/
```

Stack smoke test (builds, starts, waits for health, hits `/api/health` through nginx, stops the stack):

```sh
scripts/smoke.sh                 # or: APP_PORT=8088 scripts/smoke.sh
```

Component gallery and fixture pages (no API needed, useful for styling): `/gallery`, `/dev/monitor?fixture=all`,
`/dev/wall?fixture=all`, `/dev/button?fixture=all`, `/dev/admin?fixture=all`.

## Troubleshooting

* **`bind: permission denied` / port 80 in use** — port 80 needs root (or `CAP_NET_BIND_SERVICE`) on Linux.
  Set `APP_PORT=8080` (or any free port) in `.env`, or `APP_PORT=8080 docker compose up --build -d`, and open
  `http://<host>:8080/monitor`.
* **Stack health** — `docker compose ps` shows every service; `docker compose logs -f api` shows migrations,
  bucket creation, seeding and requests. The API only starts once Postgres and MinIO are healthy.
* **No sound on the monitor** — browsers need a gesture before audio can play: click or press a key once on
  the monitor page ("Tap to enable sound" overlay). Audio clips are requested from `/api/media/...`.
* **A phone shows "You are not in the game"** — a new game was started while the phone was offline; tap
  *Rejoin*. A player the host removed is told so and has to join again as a new player; a phone whose stored
  identity belongs to another device (same name is fine, the id is what counts) is asked to join afresh.
* **Login says "Too many failed logins"** — five wrong passwords from one client (or sixty overall) throttle
  `/api/admin/login` to one attempt per 12 s; wait for the `Retry-After` and try again.
* **`password authentication failed` in the api log after changing `POSTGRES_PASSWORD`** — see *Changing
  credentials* above: the database keeps the password it was created with.
* **Wall taps are ignored** — the wall only accepts taps while it is live (after *Start wall*, before the
  timer ends or the lives run out). The `/wall` page shows "Time's up" / "No lives left" when frozen.
* **Reset everything** — `docker compose down -v` wipes the database and bucket; the next start re-seeds the
  demo pack.
* **Admin "session expired"** — tokens last 12 h; log in again. Changing `JWT_SECRET` invalidates sessions.
* **Database shell** — `docker compose exec db psql -U admin onlyconnect`.

## Repository layout

```
docker-compose.yml   .env (+ .env.example mirror)   package.json + package-lock.json   tsconfig.base.json
docs/SPEC.md         the specification
packages/shared/     types + game engine (+ vitest tests)
api/                 Fastify API: Dockerfile, migrations/, src/ (game store, packs, routes, sockets, seed)
client/              Vite/React app: Dockerfile, nginx/default.conf, src/ (components, lib, screens)
scripts/             dockernpm.sh (npm in Docker), smoke.sh (stack smoke test), e2e/ (browser end-to-end)
screenshots/         reference frames from the show
```
