# Only Connect

> **Version 4 — 2026-10-29 (uncommitted: Windows app without Docker, pack bundles with media)**

A self-hosted simulation of the BBC quiz show *Only Connect*: a public monitor screen, a touch panel for the
Connecting Wall, phone buzzers for Missing Vowels and a game-master console with a question-pack editor
(images and audio go into an S3-compatible bucket, or into plain files in the Windows app). Everything runs
from one `docker compose up` on a server — or, since Version 4, from **one Windows executable** with no Docker
and no Node on the machine (see *Windows app (no Docker)*); both serve the same screens over the network.

What it does: four rounds for two to four teams driven from `/admin` (Connections and Sequences with a
40-second clock per question, a 2:30 Connecting Wall tapped on a touch panel, Missing Vowels with phone
buzzers, final scores; the host queues the teams before every round); the monitor
shows the show's hieroglyph boards, clue tiles with a large view of the latest picture clue, the wall, the
buzz banner and the scores, and plays the show's sound effects, thinking music and opening titles / clip on
the host's cue; undo, pausing and resuming rounds, pack editor with media uploads, export / import; the game
survives an API restart.

## Run it

Requirements: Docker with the Compose plugin. Nothing else — Node is not needed on the host. (On a Windows PC
without Docker, skip to *Windows app (no Docker)* below.)

```sh
docker compose up --build -d        # first start: builds the images, migrates the DB, creates the bucket,
                                    # seeds the "Demo pack" (a complete playable game) and its media
docker compose ps                   # wait until api and client are "healthy" (~30 s on first boot)
```

Then open (replace `<host>` with `localhost`, or the VM's IP; all URLs are relative so any host works):

| Screen   | URL                      | Who / what                                                      |
| -------- | ------------------------ | --------------------------------------------------------------- |
| Monitor  | `http://<host>/monitor`  | the big screen everyone watches (click once to enable sound: clues, effects, music) |
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

The API's driver variables of Version 4 (`DATABASE_DRIVER`, `PGLITE_DIR`, `STORAGE_DRIVER`, `MEDIA_DIR`,
`SERVE_CLIENT_DIR`, `MAX_IMPORT_BYTES`) are listed, commented, at the end of `.env.example`: compose does not
read them (it always runs Postgres + MinIO + nginx) and the Windows app sets them itself; they matter only when
you run `node api/dist/server.js` by hand (see *Architecture* and `scripts/standalone-e2e.sh`).

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

## Windows app (no Docker)

Version 4 ships the same game as one portable Windows executable, `OnlyConnect-<version>.exe` (x64, no
installer, no Docker, no Node). It embeds the API (Fastify + socket.io), a Postgres database (PGlite, files on
disk), the media store (files on disk) and the built screens, and shows a small control window: server status,
the addresses players can use, Copy / Open buttons for the four screens, live statistics, settings and the
server log. Everything in *Playing a game* and *Adding your own questions* applies unchanged; only the
differences are described here. Players still connect over the network — the exe does not change the
host-and-players architecture, it only removes Docker from the host.

### Get the exe

* download `OnlyConnect-<version>.exe` from the project's releases, or
* build it: on any machine with Docker, `scripts/dist-win.sh` (builds inside `electronuserland/builder:22-wine`,
  output `desktop/release/OnlyConnect-<version>.exe`); on Windows with Node 22 installed,
  `npm ci && npm run build && npm run build -w desktop && npm run dist:win -w desktop` (same output path).

### First start

1. Put the exe in a folder of its own — it creates `OnlyConnect-data` next to itself — and double-click it.
   Windows SmartScreen warns about an unknown publisher because the exe is not code-signed: *More info → Run
   anyway* (see *Troubleshooting* below).
2. The window opens and starts the server on port 80 (*Start server when the app opens* is on by default). The
   first start takes a few seconds longer: it creates the database, runs the migrations and seeds the *Demo
   pack* with its media.
3. **Windows Firewall** asks whether to allow the app on private / public networks — allow it, or other machines
   cannot connect. If the prompt was dismissed, Settings → *Allow through Windows Firewall* adds the rule
   (asks for administrator rights once; it runs
   `netsh advfirewall firewall add rule name="Only Connect" dir=in action=allow protocol=TCP localport=<port>`)
   and shows the outcome.
4. The status strip reads *Server running on port 80 since 14:02*. *Open* next to **Admin** opens the console
   in your browser (default login **admin / 12346789**, shown next to the admin link with a reveal button;
   change it in Settings, applied at the next restart); *Open* next to **Monitor** is the big screen; **Wall**
   goes on the touch panel; send the **Buzzer** link to the players — *Copy* copies the bare URL, the fifth
   button copies a one-line invitation ("Join the quiz: http://…/button").

### Which address to give the players

The window lists every IPv4 address of the PC with its adapter name and a badge: **`vpn`** (Hamachi, NetBird,
Tailscale, ZeroTier and WireGuard adapters, or their address ranges 25.x / 5.x / 100.64–127.x), **`lan`**
(10.x, 172.16–31.x, 192.168.x) and **`other`**. Adapters of virtual machines and containers on the PC itself
(Hyper-V / WSL *vEthernet*, VirtualBox, VMware, Docker) are `other` even when their address looks like a LAN:
nobody but this PC can reach them, so they are listed last and never chosen by default. Pick the one your
players can reach and the four links are rebuilt from it (the choice is remembered; the default is the first
`vpn` address, else the first `lan` one):

* players on the same Wi-Fi / LAN: the `lan` address;
* remote players: a VPN such as **Hamachi, NetBird or Tailscale** on the host *and* on every player's phone or
  laptop, then the `vpn` address. The game is plain HTTP on one port and nothing is exposed to the internet.

The port must be reachable on that address (firewall, above). Port 80 is omitted from the links; any other port
is written as `http://<address>:<port>/…`.

### Where the data lives, backup

Everything is in `OnlyConnect-data` next to the exe (Settings → *Open data folder*):

```
OnlyConnect-data/
  settings.json     port, admin login, token secret, auto-start, chosen address
  db/               the database (packs, games) — PGlite, treat as opaque
  media/            uploaded images and audio
  logs/server.log   the server log (rotated at 5 MB, one previous file kept)
```

**Backup**: stop the server (or close the app) and copy the folder. **Restore** / **move to another PC**: put
the folder back next to the exe. Deleting `db/` and `media/` starts from scratch (the demo pack is seeded
again); deleting `settings.json` recreates it with the defaults and a new token secret (admin sessions expire).

### Moving packs from the Docker version (and back)

Both deployments export and import the same **pack bundle**: Admin → Packs → *Export with media (.zip)*
downloads `<name>.only-connect.zip` (pack + every image and audio file it uses); on the other side *Import…*
accepts the file and creates the pack with its media ("Imported "<name>" (N media files)"). It works in both
directions and between two Windows PCs. The media-less `.only-connect.json` export still exists — see *Export,
import and backup*.

### Updating

Replace the exe with the new one and keep `OnlyConnect-data` next to it; the first start of the new version
runs any new migrations. A copy of the folder before updating costs nothing.

### Troubleshooting (Windows)

* **"Failed: port 80 is in use"** or **"Failed: port 80 is reserved by Windows or another service"** —
  something else owns port 80: Skype, another web server, a Docker publish (*in use*), or Windows itself —
  IIS / http.sys, Web Deploy, SQL Reporting Services, a Hyper-V / WSL excluded port range (*reserved*; running
  the app as administrator does not help). Click *Use port 8080 instead* in the status strip (or set another
  port in Settings and *Restart*); the links then carry `:8080`, and the firewall rule has to be added again
  for the new port.
* **Nothing opens when the exe is double-clicked, or a dialog says "Only Connect cannot start"** — the app
  could not create `OnlyConnect-data` next to the exe (`C:\Program Files`, a read-only share or stick, a folder
  of another user). Move the exe to a folder you can write to, for example *Documents*, and start it again.
* **SmartScreen / antivirus** — the exe is not code-signed (out of scope for now), so Windows warns at the
  first start (*More info → Run anyway*) and some antivirus products quarantine it or slow the first start
  while they scan it. If you prefer not to trust a download, build the exe yourself with `scripts/dist-win.sh`.
* **No `vpn` address listed** — the VPN client is not running or not connected on this PC; connect it and the
  list refreshes. The badge comes from the adapter name and the address range, so a VPN the app does not
  recognise appears as `other` — it works all the same, just pick it.
* **Players cannot connect** — check in this order: are they on the same network / VPN as the address you gave
  them (remote players need the `vpn` address, local ones the `lan` one)? Is the server running (status strip)?
  Is the firewall rule in place for the port in use (*Allow through Windows Firewall*, or the Windows prompt at
  the first start)? From a player's phone, `http://<address>:<port>/api/health` must answer `{"ok":true}`; from
  the host itself every link must open.
* **The window shows "Stopped" at start** — *Start server when the app opens* is off; click *Start*.
* **Log** — the *Log* section shows the last 300 server lines (*Copy log*); the whole file is
  `OnlyConnect-data/logs/server.log`.

## Playing a game

1. **Admin → Game → New game**: pick a pack (only *playable* packs can be started), choose how many teams
   play — **2 (the default), 3 or 4** — and name them (pink and blue are the show's colours; green and orange
   are the extra two), *Start game*. The monitor shows the lobby with the playing teams. A pack must hold at
   least one wall per team, so the two-wall Demo pack plays two teams and a four-wall pack up to four. There
   is no "who picks first" choice any more: you queue the teams before every round (next step).
2. Players open `/button` on their phones, enter a name and pick one of the playing teams. They appear in the
   admin status panel and on the monitor's player count; a reload or a dropped connection re-joins them
   automatically.
3. **Starting a round — the order**: every round button (*1. Connections* … *4. Missing Vowels*) first opens
   a small panel listing the teams in the order the engine suggests — the team with the **lowest score
   first**, ties keeping the order of the round you are coming from, so the team that fell behind in
   Connections opens Sequences — with *up* / *down* buttons to rearrange them, then *Start*. The order holds
   for the whole round: in Connections and Sequences the teams pick in turn (question 1 to the first team,
   question 2 to the second, …, wrapping round), in the Connecting Wall they choose their walls in that
   order, in Missing Vowels it is only the order the teams are shown in (the buzzers decide who answers).
   Resuming a paused round keeps the order it was started with.
4. **Round 1 Connections / Round 2 Sequences**: click the hieroglyph the team chose, *Reveal next clue* (R),
   *Correct* (C) / *Incorrect / pass* (X) → the other team may steal for 1 point (with three or four teams the
   steal buttons name the teams: press the one that stole, or *Steal incorrect* when nobody did), *Next
   question* (N). After
   the pick the audience sees the show's intro on the hieroglyph board (about 5 seconds, as in the real
   programme): the chosen glyph pulses cyan for a few seconds, folds away with a flash, the first clue unfolds
   in its slot and sits there for a moment, then the screen cuts to the question layout — the *N Points* pill
   and the first clue; clues that are not revealed yet are not drawn at all — and only now does the
   **40-second clock** start (the console shows "intro · clock in N s" until then). Every newly revealed clue unfolds the same
   way. As on the show, the *N Points* pill above the active clue **is** the timer: its light-blue part is the
   time left, shrinking from the left as the navy part grows, and the pill glides to the next column as clues
   are revealed (the admin console counts down in seconds); the question's thinking music plays from the pick.
   When the clock runs out the server
   calls time by itself — the pill is all navy, a small red *Time's up* appears beside the team bar, the sting
   plays and the music stops, no more clues can be revealed and the team must answer for the points still on
   offer; *Time up* in the console does the same early. You then judge
   *Correct* / *Incorrect* as usual (the steal has no clock). Audio clues play on the monitor when revealed (a
   judgement that reveals several at once plays the first and offers a *Play clue N* button for each); *Play
   audio again* replays them. When a clue is a **picture**, the most recently revealed one is also shown large
   above the clue row until the answer is revealed, so the players see it clearly the first time. The host
   panel shows the answer and the note for every question. *Void question* skips a broken question (missing
   media, pack error): nothing is revealed, no steal, the question still counts towards the round. A round has
   as many questions as the pack holds for it (1 to 12, one hieroglyph each; the monitor shows a 3-column board
   for up to six and a 4-column board above that) and ends when every one has been played.
5. **Round 3 Connecting Wall**: the walls are chosen by hieroglyph exactly like the questions. The monitor shows
   the pack's wall glyphs (2 or 4 large tiles); the first team of the order you set when starting the round
   (the suggestion is the team behind on score, as on the show) chooses one, you click it in the admin's wall
   picker. The wall is now *ready* but **its tiles are not
   shown anywhere yet**: the monitor keeps the glyph board with a "get ready" bar and `/wall` shows a *Get
   ready* screen, so the team can walk up to the panel without seeing the words. *Start wall (2:30)* puts the
   tiles on the monitor and the panel at the same moment and starts the **2 minute 30 second** clock. The team
   taps tiles on `/wall` (3 lives after two groups; the panel clicks on every tap, the monitor plays the
   group-found / wrong-group / life-lost stings). When the wall ends, *Resolve wall* reveals the remaining
   groups, you ask the team for each connection and mark it correct/incorrect, then *Finish wall* awards the
   points (1 per group + 1 per connection, +2 for a perfect wall) and *Clear wall* brings the glyph board back
   for the next team in the order (chosen walls are dark). Every team plays the same number of walls: with two
   teams A, B (2 walls) or A, B, A, B (4 walls); with four teams one wall each; with three teams and a
   four-wall pack three walls are played and one glyph stays unused. The round ends when they have all been
   played. *Time up* asks for a confirmation; *Abort wall* hands a wall that was chosen or started by mistake
   back without scoring it (its glyph lights up again and the same team chooses again).
6. **Round 4 Missing Vowels**: *Show clue* (Space) opens the buzzers; the first buzz the server receives wins
   and locks the others out — the winning team's buzzer sounds on the monitor and on the phone that pressed
   (see *Sounds* for which file each team gets). *Correct* (+1) / *Incorrect* (−1, then *Other team correct*
   or *Nobody*; with three or four teams one button per team that could have answered — press the one that
   did), *Reopen buzzers* for a false buzz, *Next clue*, *Skip category*. Players cannot switch teams during
   this round.
7. **Final scores** shows every playing team's score (highest first) and the winner on the monitor. Scores can
   be corrected with ±1 / ±5 at any time.

**Opening titles and clip**: the admin's *Show cues* panel has *Opening titles (music)* and *Opening clip
(video)* — they play on the monitor (the clip full screen, with its own sound) from any phase, so the show can
open before *Start game*; *Stop* ends either. The monitor needs its one-time "tap to enable sound" click first.

**Sounds**: the monitor plays the show's effects by itself: the flurry when a round starts and at the final
scores, the question music while a 40-second clock runs and the thinking bed while the wall clock runs (both
ducked under an audio clue), the correct / incorrect stings on every judgement, group found / wrong group /
life lost on the wall, the time-up sting when a clock runs out, a click per tile selected (the `/wall` panel
clicks locally too), the Missing Vowels correct / new-category stings and the team buzzers. The files are
plain static assets in `client/public/assets/sfx/` (plus `client/public/assets/clips/opening.mp4`, the
opening clip):

| File | When it plays |
| --- | --- |
| `ocFlurry.mp3` | a round starts; the final scores come up |
| `openingTitlesWithFlurry.mp3` | the *Opening titles (music)* cue |
| `solving45.mp3` | Connections / Sequences: once per question, from the end of the pick intro (when the clock starts) until the judgement, a void or time up |
| `gameplayBedLong.mp3` | the Connecting Wall only: loops while the 2:30 clock runs |
| `solveClue.mp3` | a correct answer; a wall group found |
| `incorrectGroup.mp3` | an incorrect judgement; a wrong wall group |
| `loseLife.mp3` | a wrong wall group that cost a life |
| `timeUp.mp3` | a question or wall clock ran out (or the host called time) |
| `wallBtnClick.mp3` | a wall tile selected (monitor and `/wall` panel) |
| `correctVowel.mp3` / `nextVowelGame.mp3` | Missing Vowels: a correct answer / a new category |
| `buzzerBlue.mp3` / `buzzerPink.mp3` | Missing Vowels: the winning buzz, on the monitor and on the phone that pressed — blue and pink each have their own; **green reuses `buzzerBlue.mp3` played a little higher (rate 1.15) and orange reuses `buzzerPink.mp3` a little lower (rate 0.85)**. There are no `buzzerGreen.mp3` / `buzzerOrange.mp3` files and dropping such files in does nothing: to give the extra teams their own sound, add the files and extend the team→buzzer map in `client/src/lib/sfx.ts`. |

To replace one, drop a file with the same name there and rebuild the client image (`docker compose up
--build -d client`); the exact mapping is in `client/src/lib/sfx.ts` and `docs/SPEC.md` §4.

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
  hieroglyph (new walls get Lion, Water, then the rest) — the glyph the team chooses it by (a pack needs at
  least one wall per team, so a 2-wall pack plays two teams and a 4-wall pack up to four);
* at least one Missing Vowels category with at least one clue (the vowel-less display is generated from the
  answer and can be hand-edited).

Clues can be text, an image or an audio file: choose the kind on the clue row and *Upload* (PNG/JPEG/WebP/GIF
images and audio up to 25 MB — SVG is refused; they are stored in the bucket and streamed through
`/api/media/...`). The editor shows the remaining problems until the pack is playable, and *Save* writes the
whole pack. Clue text is written as you want it shown on screen (the show uses short, title-case clues: the
editor warns above 60 characters and for wall words over 13 letters, which are shrunk to fit their tile).

### Export, import and backup

Admin → Packs offers two exports per pack and one import; the same three in the Docker stack and in the
Windows app, so packs move freely between them:

* **Export with media (.zip)** downloads `<name>.only-connect.zip`, the **pack bundle**: `manifest.json`, the
  pack JSON and every image / audio file the pack references (`GET /api/admin/packs/:id/export.zip`, streamed).
  This is the file to move a pack to another instance — Docker ⇄ Windows app, or any two instances. A media
  file missing from the store is skipped and listed under `warnings` in the manifest.
* **Export JSON** downloads `<name>.only-connect.json`, the pack alone (`GET /api/admin/packs/:id/export`).
  Media is referenced by key, not copied, so this file only plays on an instance that already holds the same
  uploads (the same instance, or one restored from its backup).
* **Import…** accepts either file (`POST /api/admin/packs/import`: the JSON body as before, or
  `multipart/form-data` with a `file` field, sniffed by content) and creates a **new** pack (new id, same
  content). For a bundle the media files are written too — files the instance already holds are skipped (keys
  are unique per upload), anything that is not an image or an audio file is skipped with a warning — and the
  page reads "Imported "<name>" (N media files)". Bundles are capped at `MAX_IMPORT_BYTES` (512 MiB).

Whole-instance backup (every pack, all media, the game history). Docker stack, from the repo directory:

```sh
# database (packs, games) and bucket (media)
docker compose exec db pg_dump -U admin onlyconnect > backup.sql
docker run --rm -v only-connect_miniodata:/data -v "$PWD":/b alpine tar czf /b/miniodata.tgz -C /data .

# restore on a fresh instance (after `docker compose up -d` created the volumes)
docker compose exec -T db psql -U admin onlyconnect < backup.sql
docker run --rm -v only-connect_miniodata:/data -v "$PWD":/b alpine sh -c "cd /data && tar xzf /b/miniodata.tgz"
```

Windows app: stop the server and copy the `OnlyConnect-data` folder (see *Windows app → Where the data lives*).
To carry packs from a Docker instance into the Windows app (or back), use the bundle export above — the
database dump of one deployment is not meant to be loaded into the other.

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

### Drivers and the Windows shape (Version 4)

The API picks its database, its media store and who serves the client files from three variables; the
compose stack keeps today's choices, the Windows app takes the other column. Same SQL, same migrations,
same routes and the same screens either way.

| Piece         | Docker compose (`.env` defaults)                       | Windows app                                                              | Variables |
| ------------- | ------------------------------------------------------- | ------------------------------------------------------------------------ | --------- |
| database      | `pg` — the Postgres 16 container                        | `pglite` — embedded Postgres 17 (WASM) writing to `OnlyConnect-data/db/` | `DATABASE_DRIVER`, `DATABASE_URL` / `PGLITE_DIR` |
| media store   | `s3` — the MinIO bucket                                 | `fs` — files under `OnlyConnect-data/media/` (`objects/<key>` + `meta/<key>.json`) | `STORAGE_DRIVER`, `S3_*` / `MEDIA_DIR` |
| client files  | nginx container, proxies `/api/` and `/socket.io/`      | the API serves `client/dist` itself, same security headers and SPA fallback | `SERVE_CLIENT_DIR` |

```
OnlyConnect-<version>.exe (Electron, portable, no installer)
browser ──:80──> Fastify API + socket.io (api/src bundled with esbuild, started in the Electron main process)
 /admin /monitor      ├── serves client/dist (SPA)            ── PGlite: OnlyConnect-data/db/
 /wall /button        └── /api, /socket.io                     ── media files: OnlyConnect-data/media/
                 control window (status · addresses · links · statistics · settings · log) ── IPC ── main process
```

* **desktop** — the Electron app (`desktop/`): bundles `api/src/embed.ts` (`startEmbedded()`, the same boot as
  the CLI: migrate → ensure storage → seed demo → load game → timers → sockets) with esbuild, ships the
  migrations and the built client, and shows the control window (`src/renderer`, plain HTML/CSS/TS) that talks
  to the main process over a small IPC contract (`src/shared/ipc.ts`). PGlite stays outside the bundle because
  of its `.wasm` files. Design record: [`docs/DESKTOP.md`](docs/DESKTOP.md).

The full specification (rules, state model, HTTP/socket API, design tokens, the desktop app in §11) is in
[`docs/SPEC.md`](docs/SPEC.md).

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
mid-game, checks the question clock and the pick intro, the hidden-until-start wall, the big picture clue
and the show cues, screenshots every stage — see [`scripts/e2e/README.md`](scripts/e2e/README.md)):

```sh
APP_PORT=8089 docker compose up --build -d
scripts/e2e/run.sh                      # Demo pack (6 + 6 questions, 2 walls): ~/.cache/oc-e2e/e2e/
E2E_SCENARIO=big scripts/e2e/run.sh     # creates a 12 + 12 question / 4 wall pack and plays it: ~/.cache/oc-e2e/e2e-big/
E2E_SCENARIO=teams4 scripts/e2e/run.sh  # the same pack with four teams and four phones: ~/.cache/oc-e2e/e2e-teams4/
```

Stack smoke test (builds, starts, waits for health, hits `/api/health` through nginx, stops the stack):

```sh
scripts/smoke.sh                 # or: APP_PORT=8088 scripts/smoke.sh
```

Desktop workspace (`desktop/`, Version 4) — its npm scripts are `build` (esbuild bundle of the API + copy of
the migrations and `client/dist` + compile of main / preload / renderer; needs the root build first), `start`
(`electron .` after a build, for development on a machine with a display), `dist:win` (electron-builder,
portable x64 exe) and `test` (vitest: address classification, settings defaults and corrupt-file recovery,
link building):

```sh
# unit tests and typecheck of the desktop workspace, in Docker like everything else
scripts/dockernpm.sh "npm ci --no-audit --no-fund && npm run build && npm run build -w desktop && npm test -w desktop"

scripts/dist-win.sh            # the Windows exe, built in electronuserland/builder:22-wine with cached npm / Electron
                               # downloads → desktop/release/OnlyConnect-<version>.exe
scripts/desktop-smoke.sh       # headless check of the real Electron app on Linux (Playwright image, xvfb): starts it
                               # with a temp data dir on port 8089, waits for "running", GET /api/health and /admin,
                               # clicks Copy on the buzzer link, takes window.png, stops the server through the UI
scripts/standalone-e2e.sh      # the API exactly as the exe runs it (pglite + fs + SERVE_CLIENT_DIR, plain Node in a
                               # container, port 8089) and the demo, big and teams4 e2e scenarios against it →
                               # ~/.cache/oc-e2e/standalone-<scenario>/ ; SCENARIOS="demo" / SKIP_BUILD=1 / KEEP=1
```

On Windows with Node 22 the same steps are `npm ci && npm run build && npm run build -w desktop && npm run dist:win -w desktop`.

Component gallery and fixture pages (no API needed, useful for styling): `/gallery`, `/dev/monitor?fixture=all`,
`/dev/wall?fixture=all`, `/dev/button?fixture=all`, `/dev/admin?fixture=all`.

## Troubleshooting

* **`bind: permission denied` / port 80 in use** — port 80 needs root (or `CAP_NET_BIND_SERVICE`) on Linux.
  Set `APP_PORT=8080` (or any free port) in `.env`, or `APP_PORT=8080 docker compose up --build -d`, and open
  `http://<host>:8080/monitor`.
* **Stack health** — `docker compose ps` shows every service; `docker compose logs -f api` shows migrations,
  bucket creation, seeding and requests. The API only starts once Postgres and MinIO are healthy.
* **No sound on the monitor** — browsers need a gesture before audio can play: click or press a key once on
  the monitor page ("Tap to enable sound" overlay). Audio clips are requested from `/api/media/...`; the sound
  effects, the opening music and the clip are static files under `/assets/sfx/` and `/assets/clips/`.
* **The clock ran out before the team answered** — that is the rule: after 40 s (question) or 2:30 (wall) the
  server calls time. For a question the team still answers for the points on offer; judge it as usual.
* **A phone shows "You are not in the game"** — a new game was started while the phone was offline; tap
  *Rejoin*. A player the host removed is told so and has to join again as a new player; a phone whose stored
  identity belongs to another device (same name is fine, the id is what counts) is asked to join afresh.
* **Login says "Too many failed logins"** — five wrong passwords from one client (or sixty overall) throttle
  `/api/admin/login` to one attempt per 12 s; wait for the `Retry-After` and try again.
* **`password authentication failed` in the api log after changing `POSTGRES_PASSWORD`** — see *Changing
  credentials* above: the database keeps the password it was created with.
* **Wall taps are ignored / the wall shows "Get ready"** — the wall only accepts taps while it is live (after
  *Start wall (2:30)*, before the timer ends or the lives run out); until then the tiles are hidden on purpose.
  The `/wall` page shows "Time's up" / "No lives left" when frozen.
* **Reset everything** — `docker compose down -v` wipes the database and bucket; the next start re-seeds the
  demo pack.
* **Admin "session expired"** — tokens last 12 h; log in again. Changing `JWT_SECRET` invalidates sessions.
* **Database shell** — `docker compose exec db psql -U admin onlyconnect`.

## Repository layout

```
docker-compose.yml   .env (+ .env.example mirror)   package.json + package-lock.json   tsconfig.base.json
docs/SPEC.md         the specification
docs/DESKTOP.md      design record of Version 4: drivers, embedded start, pack bundle, the Windows app
packages/shared/     types + game engine (+ vitest tests)
api/                 Fastify API: Dockerfile, migrations/, src/ (game store, packs, routes, sockets, seed,
                     db/ + storage/ drivers, embed.ts for the desktop app)
client/              Vite/React app: Dockerfile, nginx/default.conf, src/ (components, lib, screens)
desktop/             Electron app (Windows exe): esbuild.mjs, electron-builder.yml, src/ (main, preload,
                     renderer, shared/ipc.ts), test/
scripts/             dockernpm.sh (npm in Docker), smoke.sh (stack smoke test), e2e/ (browser end-to-end),
                     dist-win.sh (Windows exe in Docker), desktop-smoke.sh (headless Electron check),
                     standalone-e2e.sh (API as the exe runs it + e2e)
screenshots/         reference frames from the show
```
