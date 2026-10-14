# Only Connect — Build Specification

This document is the single source of truth for the architecture, game rules, visual design tokens, and the
contract between services. Every agent working on this repository must follow it. The TypeScript contract in
`packages/shared/src/types.ts` is normative — if this document and the types disagree, the types win and this
document must be fixed.

## 1. Goals

* A self-hosted simulation of the BBC quiz "Only Connect" that runs with a single `docker compose up`.
* Screens (all served by the `client` container, behind one port, default `80`):
  * `/monitor` — public big screen the audience and both teams watch. No auth.
  * `/wall` — touch panel for the Connecting Wall; the playing team taps tiles here. No auth, but it is inert until
    the admin starts a wall.
  * `/button` — phone screen for the Missing Vowels buzzer. Players enter a name and pick a team (pink or blue),
    then get a big buzzer.
  * `/admin` — game master console. Username/password login (`admin` / `12346789`, from `.env`). Drives the
    game, and contains the question-pack editor (with image/audio uploads to the bucket).
  * `/` — redirects to `/monitor`.
* Credentials for everything are `admin` / `12346789`. They live in the root `.env` (tracked on purpose; `.env.example`
  is the committed template and `docker-compose.yml` carries the same defaults so a fresh clone starts without
  it). The API warns at boot for every default password it finds.
* The owner will later run this on a GCP VM, so the app must work with any host/IP: all URLs are relative, and
  media is served through the API (never by a direct bucket URL).

## 2. Architecture

```
browser ──:80──> client (nginx) ──/api, /socket.io──> api (Node 22 + Fastify + socket.io)
                                                         ├──> db (Postgres 16)
                                                         └──> minio (S3-compatible bucket "media")
```

* **Monorepo with npm workspaces**: `packages/shared`, `api`, `client`. Node 22, TypeScript everywhere, ESM.
* **`packages/shared`** — types (`src/types.ts`), the pure game engine (`src/engine/*`: reducers and selectors,
  no I/O), the public-state projection, and vitest unit tests. Both api and client import it as
  `@only-connect/shared`.
* **`api`** — Fastify 4 + socket.io 4 + `pg` + `@aws-sdk/client-s3` + `@fastify/multipart` + `jsonwebtoken` +
  `zod`. Holds the authoritative in-memory `GameState`, persists every change to Postgres (`games.state` JSONB),
  and broadcasts projections over socket.io. Runs SQL migrations from `api/migrations/*.sql` on boot and seeds a
  demo pack if the `packs` table is empty.
* **`client`** — Vite 5 + React 18 + react-router 6 + socket.io-client. Plain CSS with custom properties (no UI
  framework). Built to static files and served by nginx, which proxies `/api/` and `/socket.io/` to `api:3000`.
* **`db`** — `postgres:16-alpine`, user `admin`, password `12346789`, db `onlyconnect`, named volume.
* **`minio`** — `minio/minio`, root user `admin` / `12346789`, named volume. A one-shot `minio-init` service
  (`minio/mc`) creates the `media` bucket. Console published on `9001` **on the loopback interface only**
  (`MINIO_CONSOLE_BIND`, default `127.0.0.1`).
* Only the `client` port is published on all interfaces (`APP_PORT`, default `80`). Container logs are rotated
  (json-file, 3 × 10 MB).

### 2.1 Repository layout

```
.
├── docker-compose.yml
├── .env / .env.example          # all credentials and ports (edit .env in place)
├── package.json                 # workspaces root, scripts: build, test, typecheck
├── tsconfig.base.json
├── docs/SPEC.md                 # this file
├── packages/shared/
│   ├── package.json  tsconfig.json  vitest.config.ts
│   └── src/
│       ├── index.ts             # re-exports
│       ├── types.ts             # THE CONTRACT
│       ├── engine/              # pure reducers: game.ts, questions.ts, wall.ts, vowels.ts, project.ts
│       └── engine/__tests__/
├── api/
│   ├── Dockerfile  package.json  tsconfig.json
│   ├── migrations/001_init.sql  002_hieroglyphs.sql
│   └── src/ (server.ts, config.ts, db.ts, storage.ts, auth.ts, game/, routes/, sockets/, seed/)
├── client/
│   ├── Dockerfile  package.json  tsconfig.json  vite.config.ts  index.html
│   ├── nginx/default.conf
│   ├── public/
│   │   ├── fonts/               # Titillium Web woff2 (OFL)
│   │   └── assets/              # hieroglyph SVGs, gramophone.svg, picture.svg
│   └── src/
│       ├── main.tsx  App.tsx    # router
│       ├── styles/              # tokens.css, base.css
│       ├── lib/                 # socket.ts, api.ts, hooks
│       ├── components/          # Tile, Background, PointsBadge, TeamBar, ScoreStrip, Hieroglyph, ...
│       └── screens/ monitor/ wall/ button/ admin/
└── screenshots/                 # reference frames from the real show (do not modify)
```

### 2.2 Dev / build commands

* Node is **not** installed on the host — everything runs in Docker. For local iteration use
  `docker run --rm -v "$PWD":/app -w /app node:22-alpine sh -c "npm ci && npm run build && npm test"`.
* Root scripts: `npm run build` (shared → api → client), `npm test` (shared + api), `npm run typecheck`.
* `docker compose up --build` must bring the full stack up with no manual steps.

## 3. Game rules (as implemented)

Two teams: `pink` and `blue` (ids are fixed; names are editable). Scores are integers, can go negative.

### 3.1 Round 1 — Connections
* A pack holds **1 to 12** questions for this round (`MIN_QUESTIONS_PER_ROUND` / `MAX_QUESTIONS_PER_ROUND`),
  each tagged with a different one of the twelve hieroglyphs, in grid order: `twoReeds`, `lion`, `twistedFlax`,
  `hornedViper`, `water`, `eyeOfHorus` (the show's six), then `ankh`, `scarab`, `feather`, `owl`, `cobra`, `sun`
  (used only when a round has more than six questions). The round has exactly as many questions as the pack
  holds for it; `QuestionRoundState.available` lists the round's hieroglyphs in `HIEROGLYPHS` order and
  `questionsTotal` their count.
* The hieroglyph grid (monitor and admin) shows only `available`: 3 columns when there are up to 6 glyphs,
  4 columns for 7–12 (at most 3 rows).
* Teams alternate. The admin chooses which team starts the round. The team "picks" a hieroglyph (the admin
  clicks it on their behalf); used hieroglyphs are shown dark/unavailable.
* A question has 4 clues; each clue is text, image, or audio (with a text caption used on reveal).
* Clue 1 is shown immediately. The admin reveals clues one at a time. Points available: 5 after 1 clue, 3 after
  2, 2 after 3, 1 after 4. The monitor shows a "N Points" badge.
* **40-second clock (V3).** `q:select` starts a `QUESTION_SECONDS = 40` clock (`QuestionRoundState.startedAt` /
  `endsAt`, server timestamps). It runs while the team is buying clues (stage `question`); the monitor shows
  it in the points pill (next bullet), the admin console shows the countdown in seconds. When it runs out the
  server fires `q:timeUp` (the host may also press it early): `timeUp = true`, `q:reveal` is no longer allowed
  and the team must answer for the points on offer (the host then judges correct / incorrect as usual). A
  judgement (`steal` / `answer`) clears the clock; the steal has no clock. The monitor plays the time-up sting
  and stops the question's thinking music.
* **The points pill is the timer (V3.1).** On the monitor the "N Points" pill above the active clue *is* the
  40 s clock, as on the show (reference frames `screenshots/Screenshot From 2026-10-13 09-25-54.png` and
  `09-24-04.png`): two flat tones, the light blue being the time remaining — anchored at the pill's **right**
  end and shrinking towards it as the navy part grows from the left, so early in a question the pill is mostly
  light blue and late it is mostly navy. Not much of a gradient: only the subtle top-light / bottom-shadow
  overlay of the badge is kept, and the text stays "N Points". There is **no** separate timer bar under the
  tiles. When a clue is revealed the pill glides (~400 ms ease) to the column above the newly revealed clue
  instead of jumping, and its fill keeps running while it moves. At time up the pill is fully navy and the
  monitor still shows the words in a small discreet red **"Time's up"** caption at the right end of the
  team-bar row (test id `question-timeup`): the host relies on the words, not on the fill.
* **First-clue intro (V3.1).** On the actual transition `selecting` → `question` (the pick) the monitor shows,
  for about 1.5 s, only the first clue tile, sliding into its place (tile 1, left column) from off-screen left
  with an ease-out; then the rest of the question frame — the three dark tiles, the pill, the team bar, the
  big picture if any — fades in and the normal question screen is shown. The server clock already runs during
  the intro (`q:select` starts it). A page load that lands mid-question draws the frame at once, no intro.
* **Big picture (V3).** While a question is being played (`question` / `steal`), the most recently revealed
  picture clue is also shown large above the clue row (in the free upper part of the frame) so the players can
  see it clearly the first time it appears. It is hidden on the answer reveal (the tiles show the captions).
* Admin judges: **correct** → award the current points, reveal all remaining clues and the answer.
  **incorrect / pass** → reveal all clues; the other team gets one steal attempt worth **1** point. Admin judges
  the steal, then the answer is shown. **next** → back to hieroglyph selection for the other team.
  **void** (`q:void`, from `question` or `steal`) → the question is abandoned without revealing anything and
  without a steal: no points, the hieroglyph stays used, it counts towards the round's total (for a broken clue).
* When a judgement reveals several clues at once, the first newly revealed audio clue is queued on the monitor
  (as on `q:reveal`); every visible audio clue can be replayed individually (`media:play {clueIndex}`).
* Round ends when all of the round's questions (`questionsTotal`) have been played. With an odd count the
  team that opened the round plays one question more.

### 3.2 Round 2 — Sequences
* Same as Connections except: only the first **3** clues can be revealed; the 4th tile is a `?`. The team must
  name the 4th item (and, implicitly, the sequence). Points: 5 after 1 clue, 3 after 2, 2 after 3. On answer
  reveal the 4th tile shows the real 4th clue.
* Steal worth 1 point, as above.

### 3.3 Round 3 — Connecting Wall
* A pack has exactly **2 or 4** walls (`MIN_WALLS = 2`, `MAX_WALLS = 4`; an even number so both teams play the
  same number). Each wall is tagged with a **hieroglyph** (`Wall.hieroglyph`, unique among the pack's walls, any
  of the twelve). The demo pack's walls are `lion` and `water` (the show's two wall glyphs); the editor gives a
  new wall the first unused glyph in the order lion, water, then the rest of `HIEROGLYPHS`
  (`WALL_HIEROGLYPH_ORDER`, `nextWallHieroglyph`).
* Walls are chosen **by hieroglyph, exactly like questions**. `round:start` of `wall` shows the wall grid
  (`WallRoundState.available` = the pack's wall glyphs in `HIEROGLYPHS` order, `wallsTotal` their count) in stage
  `selecting`, with `team` = the team that is *behind* on score (a tie goes to the team that started the game).
  The admin clicks the glyph the team chooses (`wall:select {hieroglyph}`): the wall goes on screen in stage
  `ready` for that team, the glyph joins `used` and the round is in stage `playing`.
* After the wall is scored and cleared (`wall:clear`) `wallsDone` goes up by one and the **other** team chooses
  from the glyphs left (used ones are shown dark): teams strictly alternate — A, B with 2 walls; A, B, A, B with
  4. When one glyph remains the grid still shows it (lit, the rest dark) and the admin selects it.
* The round is finished when every wall has been chosen and scored (`used.length === wallsTotal` and the last
  wall is `done`); after its `wall:clear` the round sits on the empty grid (`wallsDone === wallsTotal`) and
  `allowedActions` offers the next round.
* 16 tiles, 4 hidden groups of 4. The tiles are shuffled when the wall is chosen (deterministically from a seed
  stored in state so every client sees the same layout).
* Choosing a wall puts it in stage `ready` **without showing its tiles anywhere** (V3): the public projection
  sends `tiles: []` while `ready`, the monitor keeps the glyph grid up with a "get ready" bar and the `/wall` panel
  shows a "get ready" screen. `wall:start` makes the panel live and starts a **2 minute 30 second**
  (`WALL_SECONDS = 150`) timer (server `endsAt` timestamp); the tiles reach the monitor and the panel in the
  same broadcast, so the wall appears on both at the same time.
* The team taps tiles to select up to 4. Tapping a selected tile deselects it. When 4 are selected the server
  checks them: if they form a group, they lock in (they move to the next free row and take the group colour,
  in solve order); otherwise the selection flashes and clears.
* After 2 groups are found the team has **3 lives**; each further wrong guess costs one. At 0 lives the wall
  freezes. When 3 groups are found the 4th locks automatically.
* The wall ends when: all 4 found, lives reach 0, or time is up. The wall panel is then frozen. The admin's
  "time up" asks for a confirmation in the console.
* **Abort** (`wall:abort`, from `ready` / `live` / `frozen` / `resolving`): the wall is **handed back** — it goes
  off screen, nothing is awarded, its glyph is removed from `used` and the **same** team chooses again (stage
  `selecting`), so the wall can be chosen again (freshly shuffled) or another one picked instead.
* **Resolution** (admin driven, shown on the monitor): any unfound groups are revealed one by one (all tiles end
  up grouped and coloured). For each group, in order, the admin asks the team for the connection and marks it
  correct or incorrect; the group's connection text is then revealed on the monitor.
* Scoring: 1 point per group found by the team + 1 point per connection correctly identified; if all 8
  (4 groups + 4 connections) → bonus 2 → max 10. Points are added when the admin finishes the wall.
* Group colours (in solve order): 1 `#4daee9` (light blue), 2 `#5db85d` (green), 3 `#b16ed6` (purple),
  4 `#1d4f9e` (dark blue). Text on all group tiles is white.

### 3.4 Round 4 — Missing Vowels
* The pack has N vowel groups (categories), each with 4 clues: a `answer` (the full text) and a `display`
  string (the answer with vowels removed and re-spaced, e.g. `PL RCC P` for `POLE ARC CAP`). `display` is
  auto-generated from the answer in the editor but can be edited.
* All players are on `/button`. The monitor shows the category bar and then each clue in turn.
* Buzzing: the first `player:buzz` the server receives after the clue goes live wins (server receipt order is
  authoritative). The buzzer locks for everyone; the monitor shows which team (and player) buzzed. Latency is
  mitigated by sending the clue to the monitor and buttons in the same broadcast and by measuring buzzes with
  server receipt time; no client-side timestamps are trusted.
* Admin judges: **correct** → +1 to that team. **incorrect** → −1 to that team, and the other team may answer
  (no buzz needed): admin marks **other team correct** (+1) or **nobody**. Then the answer is revealed.
* **next** moves to the next clue (or next category); the admin can end the round any time.
* Players cannot change team during this round (`team_locked`). Lock-outs are per player (SPEC §10).

### 3.5 Final
* The monitor shows both teams with scores and declares the winner (or a tie).

### 3.6 Scores, undo, leaving rounds
* The admin can adjust either score by ±1 / ±5 at any time (for corrections).
* **Undo** (`game:undo`): the host (API store, not the engine) keeps the states that preceded the last 20 admin
  actions and restores the previous one; player presence (`players`, `removedPlayers`) and the show cue (`cue`)
  are carried over from the current state (an undo never replays or cuts the titles / clip on the monitor),
  `version` is bumped. `GameState.undoable` names the action the next undo would revert (`null`
  when none). Player, timer, show-cue and `game:new` actions are not undoable; the history is in memory only.
* **Leaving a round**: `round:start` of another round, `game:lobby` and `round:final` are allowed between
  questions (not while a question / live wall / buzz is being played). A round left with progress is stored in
  `suspended[round]` and `round:start` of that round **resumes** it (used hieroglyphs, `questionsDone`,
  used walls / `wallsDone` and the next chooser, vowels position; a live clue comes back at its category bar). A round in progress cannot be
  restarted from its own `round:start`; a finished round never can.

## 4. Realtime and state model

* The API holds one **current game** (`GameState`) in memory, persisted to `games` on every mutation. On boot
  it reloads the most recent game. The admin can start a new game at any time (old ones stay in the DB).
* `GameState` is reduced by a pure function `applyAction(state, action, ctx): GameState` in `packages/shared`.
  `ctx` provides `now` (ms) and a random seed so the engine stays deterministic/testable. Invalid actions throw
  `GameError` (never crash the server — the API returns 400 with the message).
* Two projections are broadcast by socket.io:
  * namespace `/` event `state` → `PublicGameState` (answers, unrevealed clues, wall group membership and
    connections are stripped until revealed). Monitor, wall and button screens consume this.
  * namespace `/admin` (handshake `auth.token` = JWT) event `state` → full `GameState`.
* Client → server socket events (namespace `/`): `player:join`, `player:leave`, `player:buzz`, `wall:select`.
  Each uses an ack callback. See `ClientToServerEvents` in the types. The tile tap (`wall:select {tileId}`,
  a `PlayerAction`) shares its type name with the admin's wall pick (`wall:select {hieroglyph}`, an
  `AdminAction`); the engine tells them apart by the payload. The server must build the tile action itself from
  the validated `{ tileId }` (never forward a socket payload as an action), and the admin zod schema accepts only
  the `hieroglyph` form, so a phone can never choose a wall.
* **Identity**: a socket acts only as the player it joined as. `player:join` with `playerId: null` creates a
  player (fresh uuid + a random `secret`, both in the ack; the phone stores them); a join with an existing id
  must carry that secret (`not_owner` otherwise); an unknown id is kept as is (a phone keeps its identity
  across games). `player:buzz` / `player:leave` ignore the payload id and use the socket's own player
  (`not_joined` when none). Ids removed by the host are refused (`player_removed`), the game holds at most
  `MAX_PLAYERS` (40, `game_full`). The secret is in the full state only, never in the public projection.
* Rate limits (in memory): `/api/admin/login` 5 wrong guesses per client then 1 per 12 s and 60 per minute
  overall (429 + `Retry-After`; a correct password costs nothing); per socket 6 join/leave (refill 1 per 4 s) and
  15 buzz/tap (refill 8/s); 40 joins per client address (refill 1/s). Browser origins other than the app's own
  host (and `ALLOWED_ORIGINS`) are refused by CORS and by the socket handshake.
* The engine's `ctx.now` is the time the action was **received** by the store, not the time the FIFO queue
  applied it, so a slow database write before a wall tap or a buzz does not change its outcome or timestamp.
* Presence-only changes (`player:join`, `player:connected`) are coalesced into one broadcast after ~40 ms; every
  other change is broadcast immediately. On `game:new` the server re-joins every connected phone itself (the
  phone only joins on connect).
* Admin actions go through REST `POST /api/admin/actions` with `Authorization: Bearer <jwt>`; body is an
  `AdminAction`. The server applies it, persists, broadcasts both projections, and returns the full state.
* Timers: the wall `endsAt` is set by the engine from `ctx.now`; the API schedules a `wall:timeUp` action at
  that instant (and re-arms it on boot if a wall is live). Clients render countdowns from `endsAt` and the
  server-provided `serverNow` in each broadcast (so phone clocks don't matter).
* Audio clues: the monitor plays the clue audio when a clue of type `audio` is revealed, and re-plays it when the
  admin sends `media:play`. The monitor has a one-time "tap to enable sound" overlay because browsers require a
  gesture for audio.
* **Show cues (V3).** `cue:play {cue}` sets `GameState.cue = { name, nonce }` (`CUE_NAMES`: `openingTitles` =
  the opening titles music, `introClip` = the opening title clip shown full screen with its own sound);
  `cue:stop` sets it to null. The files are static client assets (`client/public/assets/sfx/`,
  `client/public/assets/clips/opening.mp4`), not bucket media. Both are allowed in any phase (the host plays
  them from the admin console before the game starts); `cue:play` is always allowed, `cue:stop` while a cue is
  set. The monitor acts on a changed nonce (like `playMedia`), hides the clip when it ends, and ignores a cue
  that was already set when the page loaded.
* **Sound effects (V3, mapping revised in V3.1).** The monitor derives sound effects client-side from state
  changes (no server field):
  * `ocFlurry` when a round starts / the final scores come up;
  * `solving45` (49 s) — the thinking music of Connections and Sequences: played once from the start of a
    question (the state reaches stage `question`), stopped when the question leaves that stage (judged / void)
    or when `timeUp` becomes true (the `timeUp` sting still plays); ducked under an audio clue;
  * `gameplayBedLong` — the thinking bed, now for the **wall only**: loops while `wall.current.stage === 'live'`
    (ducked under an audio clue, stopped when the wall freezes);
  * `solveClue` on a correct answer / a group found; `incorrectGroup` on an incorrect judgement / a wrong
    group; `loseLife` when a wrong group costs a life; `timeUp` when a clock runs out;
  * `wallBtnClick` when a tile is selected (also played locally by the `/wall` panel; the fourth tap of a
    guess resolves it in the same broadcast and still clicks);
  * `correctVowel` / `nextVowelGame` in Missing Vowels (`nextVowelGame` on a new category or a resume, not on
    the round start itself, which already has the flurry);
  * `buzzerBlue` / `buzzerPink` — the team buzzers of Missing Vowels: on the monitor when a buzz is accepted
    (`vowels.stage` → `buzzed`, the file chosen by `buzz.team`), and on the phone that pressed (`/button`, on
    its own winning buzz ack, see §8) for instant feedback; a lost buzz, a lockout or an error stays silent.

  The first state after a page load *or a socket reconnect* is only recorded, never diffed, so transitions
  missed while offline do not play late. See `client/src/lib/sfx.ts`.
* Players (`/button`) get a `playerId` + `secret` stored in `localStorage` so a reload rejoins the same player.
  The server keeps `players` in the game state (name, team, connected, secret).

## 5. HTTP API (all JSON unless noted)

Public:
* `GET  /api/health` → `{ ok: true }`
* `GET  /api/state` → `PublicGameState` (initial load before the socket connects)
* `GET  /api/media/:key` → streams the object from the bucket with its content-type (cache headers OK), with
  `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'; sandbox` so an object
  opened as a document can never run script in the app's origin. nginx adds a CSP / `X-Frame-Options: DENY` /
  nosniff to the app pages.

Admin (`Authorization: Bearer <jwt>`; obtained from `POST /api/admin/login {username, password}` → `{ token }`;
JWT secret from `.env`, 12 h expiry):
* `GET  /api/admin/state` → `GameState`
* `POST /api/admin/actions` body `AdminAction` → `GameState` (400 `{ error }` on `GameError`)
* `GET  /api/admin/packs` → `PackSummary[]`
* `POST /api/admin/packs` body `{ name }` → `Pack`
* `GET  /api/admin/packs/:id` → `Pack` (full, with questions, walls, vowel groups)
* `PUT  /api/admin/packs/:id` body `Pack` (full replace; validated with zod) → `Pack`
* `DELETE /api/admin/packs/:id`
* `POST /api/admin/media` multipart (`file`) → `MediaRef` (`{ key, url, mime, name }`); images and audio only
  (no SVG), max 25 MB. Objects are stored under `uploads/<uuid>.<ext>`.
* `POST /api/admin/packs/:id/duplicate` → `Pack`
* `GET  /api/admin/packs/:id/export` → the `Pack` JSON as a download; `POST /api/admin/packs/import` body `Pack`
  (same schema as PUT) → `Pack` (new ids). Media is referenced by key, not copied.
* `DELETE /api/admin/packs/:id` also deletes the `uploads/` objects only that pack referenced.
  `GET /api/admin/media/orphans` lists unreferenced uploads older than an hour, `POST /api/admin/media/sweep`
  deletes them → `{ removed, keys }`.
* `POST /api/admin/login` answers `429` + `Retry-After` while throttled (see §4).

Validation: a pack is **playable** when it has 1–12 connections questions and 1–12 sequences questions (within
a round each hieroglyph at most once, positions `0..n-1` each used once, 4 valid clues and an answer each),
exactly 2 or 4 walls (each with a known hieroglyph unique among the pack's walls, 4 groups × 4 clues, no clue
twice in a wall), and ≥1 vowel group with ≥1 clue.
`GET /api/admin/packs` returns `playable` + `problems: string[]` per pack. `game:new` rejects unplayable packs.
The demo pack keeps 6 + 6 questions and 2 walls.

Hard caps on `PUT /api/admin/packs/:id` and `POST /api/admin/packs/import` (`400 validation` instead of a saved
draft): more than `MAX_QUESTIONS_PER_ROUND` (12) questions in one round and more than `MAX_WALLS` (4) walls.
Every lower bound (at least one question per round, 2 or 4 walls, a unique hieroglyph per wall, 4 clues, …) is
a soft playability problem so the editor can save drafts. On save the server renumbers `position` to `0..n-1`
per round (questions) and per pack (walls, vowel groups), ordered by the positions sent (payload order for
ties); a wall sent without `hieroglyph` is given the first free one (`nextWallHieroglyph`: lion, water, then
the rest of `HIEROGLYPHS`), while duplicate wall glyphs are stored and reported as problems.

## 6. Database

```sql
packs(id uuid pk, name text, created_at, updated_at)
questions(id uuid pk, pack_id fk cascade, round text check in ('connections','sequences'),
          hieroglyph text, position int, clues jsonb, answer text, note text)
walls(id uuid pk, pack_id fk cascade, position int, hieroglyph text, groups jsonb)   -- WallGroup[4]
vowel_groups(id uuid pk, pack_id fk cascade, position int, category text, clues jsonb)
games(id uuid pk, pack_id fk, state jsonb, created_at, updated_at)
media(key text pk, mime text, size bigint, original_name text, created_at)
```
Migrations are plain SQL files applied in order and recorded in `schema_migrations`.
`002_hieroglyphs.sql` widens the `questions.hieroglyph` CHECK to the twelve glyphs, adds `walls.hieroglyph`
(CHECK over the same twelve; existing walls are backfilled per pack in position order: lion, water, then the
rest of `HIEROGLYPHS`) and an index on `walls(pack_id, position)`.

A persisted game whose state predates this contract (pack walls without `hieroglyph`, question state without
`available` / `questionsTotal`, wall state with `assignment` / `completed`) is **not resumed** on boot: the API
logs a warning and starts without a game; the host starts a new one.

## 7. Visual design — exact tokens

The look must match the reference screenshots in `screenshots/`. Colours below were sampled from them.

Font: **Titillium Web** (closest match to the show's graphics; self-hosted woff2 in `client/public/fonts`,
weights 400, 600, 700). All text uses it. Clue/answer text is weight 600; team bars 600; headings 700.

```css
:root {
  /* backgrounds */
  --oc-bg-blue-deep:   #000044;   /* outer field of the blue ring background */
  --oc-bg-blue-glow:   #0a118c;   /* centre glow of the ring background */
  --oc-bg-blue-ring:   #1d2471;   /* ring segment highlight */
  --oc-bg-blue-bright: #0037eb;   /* flat blue zone (blue team) */
  --oc-bg-purple:      #a100e0;   /* purple/pink zone (pink team) */
  --oc-bg-purple-deep: #59007b;
  --oc-panel-grey:     #e1e5e4;   /* lower grey panel on answer reveal & final scores */
  --oc-strip-grey:     #dee5e3;   /* contestant name strip */

  /* light clue tile: vertical gradient with a glossy upper half */
  --oc-tile-top:       #bee5fb;
  --oc-tile-bottom:    #aeddf9;
  --oc-tile-edge:      #6fa3d3;   /* 1-2px darker rim */
  --oc-tile-text:      #001b3a;   /* navy text on light tiles */

  /* dark (selected / used / unknown) tile */
  --oc-dark-top:       #043366;
  --oc-dark-bottom:    #042d5b;
  --oc-dark-edge:      #022351;
  --oc-dark-text:      #ffffff;

  /* bars and badges */
  --oc-bar-navy:       #043061;   /* team-name bar under clues, category bar */
  --oc-bar-navy-top:   #134686;
  --oc-badge-navy:     #052e60;   /* "N Points" badge: elapsed time, grows from the left */
  --oc-badge-blue:     #4679b7;   /* "N Points" badge: time remaining, anchored on the right */
  --oc-score-blue-top: #2975dc;   /* final score team bar */
  --oc-score-blue:     #1462d0;
  --oc-score-blue-bot: #0c42a9;
  --oc-score-tile-top: #b9e1fc;   /* final score number tile */
  --oc-score-tile-bot: #9acdf1;
  --oc-score-text:     #000000;

  /* wall */
  --oc-timer-fill:     #052b55;   /* elapsed part of the wall timer bar */
  --oc-timer-rest:     #3471bf;   /* remaining part */
  --oc-group-1: #4daee9;  --oc-group-2: #5db85d;  --oc-group-3: #b16ed6;  --oc-group-4: #1d4f9e;

  /* icons */
  --oc-icon-navy:      #0b2a5a;   /* gramophone / picture silhouettes */
  --oc-team-pink:      #d02ac8;   /* UI accent for pink team (buttons, lobby) */
  --oc-team-blue:      #0037eb;
}
```

Tile geometry: rounded corners ~10px at 1080p, two flat bands (`--oc-tile-top` for the upper third,
`--oc-tile-bottom` below, no white wash), a soft darker fade along the top edge and a dark inner bottom rim, 2px
rim in `--oc-tile-edge`, subtle drop shadow. Clue text is centred, navy, wraps to 2 lines, ~49px at 1080p
(`clamp()` with `vw`); clues longer than ~45 characters are shrunk to fit (`Tile.textFit`). 4 clue tiles span
~82% of the width with 8px gaps. The "N Points" badge sits centred above the **last revealed** tile (5 points →
tile 1, 3 → 2, 2 → 3, 1 → 4) and glides there (~400 ms) on a reveal; it is the 40 s question timer (§3.1): two
flat tones under its top-light / bottom-shadow overlay, `--oc-badge-navy` growing from the left over
`--oc-badge-blue`, the remaining time anchored on the right, fully navy at time up (a plain two-tone badge
when no clock runs: steal / answer). Nothing sits between the tiles and the team-name bar — the team-name bar
sits directly below the tiles, full tile row width, ~92px tall with the name at ~62px; the small red "Time's
up" caption sits at the right end of that row. The hieroglyph grid is 3×2 tiles centred on the blue ring
background. The wall is a 4×4 grid on the right ~half with the timer bar below it: a bar of *remaining* time
anchored to the grid's right edge that shrinks towards it, with a dark navy cap on its left end and no track
for the elapsed part; wall tile text ~39px at 1080p, single words over 11 letters shrunk to fit. Missing
vowels: a navy category bar (white text) above a light answer bar
(navy text, letter-spaced, uppercase), both ~75% width near the bottom. Final: grey panel with the blue team bar
(white uppercase name) and the light score tile (black number). Pink team variant of the score bar uses
`--oc-bg-purple`→`--oc-bg-purple-deep`. The hieroglyph grid shows only the round's `available` glyphs: 3 columns
(up to 2 rows) for 1–6 glyphs, 4 columns (up to 3 rows) for 7–12, centred on the ring background.

The blue "ring" background is drawn in CSS/SVG: a narrow bright centre glow (`#1728f5`) falling to
`--oc-bg-blue-glow` within ~17% of the width and to flat `--oc-bg-blue-deep` at the frame edges, overlaid with
a big ring of trapezoid segments (concentric rings, ~18–22 segments each) in a slightly lighter blue at **low**
opacity (~0.1: the segments are barely lighter than the gaps in the reference frames; the glow is the feature). When the pink team is "in
control" the monitor uses the purple variant for the connections/sequences rounds (as in the Nightwearers
screenshot); the blue team uses the blue variant.

Assets (SVG, in `client/public/assets/`): `hieroglyph-two-reeds.svg`, `hieroglyph-lion.svg`,
`hieroglyph-twisted-flax.svg`, `hieroglyph-horned-viper.svg`, `hieroglyph-water.svg`, `hieroglyph-eye-of-horus.svg`,
and for rounds with more than six questions `hieroglyph-ankh.svg`, `hieroglyph-scarab.svg`,
`hieroglyph-feather.svg`, `hieroglyph-owl.svg`, `hieroglyph-cobra.svg`, `hieroglyph-sun.svg`
(white strokes, `stroke: #fff`, `fill: none` outline style like the show, drawn in a 200×120 viewBox),
`gramophone.svg` (solid navy silhouette, horn pointing up-left, box base), `picture.svg` (navy framed-photo
silhouette), `question-mark.svg` (optional — the `?` can be text).

## 8. Screens

### /monitor
States rendered from `PublicGameState.phase`:
* `lobby` — blue ring background, title "ONLY CONNECT", both team names, connected player count.
* `connections` / `sequences`:
  * `selecting` — the hieroglyph grid of the round's `available` glyphs (3 columns up to 6, 4 columns for
    7–12); used ones dark; a small bar "<Team> to choose".
  * `question` — 4 tiles (unrevealed = dark navy blank; sequences' 4th = `?`), points pill, team bar with the
    answering team's name; background in the team's colour variant. **Question clock (V3.1)**: the "N Points"
    pill above the active clue is the clock (test id `question-timer`, `data-time-up="false" | "true"`): its
    light-blue part is the time remaining, anchored at the pill's right end and shrinking towards it while the
    navy part grows from the left (rendered from `endsAt` and the server clock); it glides to the column above
    a newly revealed clue (~400 ms) with the fill still running; at `timeUp` it is fully navy and a small red
    "Time's up" caption (test id `question-timeup`) sits at the right end of the team-bar row. There is no
    timer bar under the tiles and nothing with `role="progressbar"` on this screen. In `steal` / `answer`
    (clock fields null) the pill carries no clock. **First-clue intro (V3.1)**: on the pick (`selecting` →
    `question`) only tile 1 is drawn for ~1.5 s, sliding in from off-screen left (ease-out); then the rest of
    the frame (dark tiles, pill, team bar, big picture) fades in. Not on a page load that lands mid-question.
    **Big picture (V3)**: in `question` / `steal` the most recently revealed picture clue is also drawn large
    in the free upper part of the frame above the clue row (test id `big-image`, at least ~30 %
    of the frame height), hidden at `answer`.
  * `steal` — all 4 tiles revealed, badge "1 Point", team bar shows the stealing team (no clock).
  * `answer` — all clues (captions for media) + answer in the team bar; grey lower panel like the screenshot
    (no outcome caption: the show says it aloud; the text is kept for screen readers only).
* `wall`:
  * `selecting` — the hieroglyph grid with **only** the walls' glyphs (`wall.available`: 2 or 4 large tiles,
    centred; `wall.used` ones dark, the rest lit — including a single last one) and a team bar caption
    "<Team> to choose a wall" (`wall.team`). Once `wallsDone === wallsTotal` the round is over (no caption).
  * `playing`, `current.stage === 'ready'` (V3) — the glyph grid stays up (the chosen glyph dark) with a
    "<Team> — get ready" bar; **no tiles** are drawn (the projection sends `tiles: []`).
  * `playing`, from `live` — spectator wall mirror (tiles, colours, timer bar for the 2:30 clock, lives dots);
    the tiles appear with the `wall:start` broadcast, at the same moment as on `/wall`; resolution shows the
    connection text.
* `vowels` — category bar + answer bar; buzz banner (team colour) with player name; score strip.
* `final` — both score bars; winner banner.
* Persistent small score strip in a corner (pink / blue scores) except on lobby/final.
* **Sound (V3)**: one "tap to enable sound" overlay unlocks audio for clue playback, the sound effects and the
  cues. Effects are derived client-side from state changes (`MonitorSfx`, mapping in §4; files in
  `client/src/lib/sfx.ts`); `solving45` plays once per question while the 40 s clock runs (stopped by the
  judgement, a void or time up), the bed loops while the wall clock runs, both ducked under an audio clue; the
  team buzzer (`buzzerBlue` / `buzzerPink`, by `buzz.team`) plays when a Missing Vowels buzz is accepted.
  **Cues**: on a changed `cue.nonce` the monitor plays the opening titles music or shows
  the opening clip full screen (`<video>` with its own sound), hides the clip when it ends or on `cue:stop`, and
  ignores a cue that was already set when the page loaded (the same UNSEEN-nonce pattern as `playMedia`).

### /wall
* Inert "Waiting for the game master…" when no wall is on screen (including while a wall is being chosen,
  stage `selecting`).
* `ready` (V3): a "Get ready — <Team>" screen; the panel reads no tiles in this stage (the public projection
  sends `tiles: []`, see §10) and the board is not mounted.
* Live (from the `wall:start` broadcast): 4×4 tiles filling the screen, large touch targets, timer bar and
  m:ss countdown for the 2:30 clock (`WALL_SECONDS`, rendered from `endsAt` and the server clock), lives,
  team name. Wrong guess shake. Every accepted tap plays `wallBtnClick` locally (the panel is touched, so
  audio is unlocked; the file is preloaded on mount) — the monitor plays the same click when the broadcast
  lands. Taps are refused client-side once `now >= endsAt`, before the server's `wall:timeUp` arrives.
* Frozen after the wall ends (shows "Time's up" / "Wall complete" / "No lives left").

### /button
* Join form: name + team toggle (pink / blue), saved in localStorage. Joins via socket on submit.
* Buzzer: a giant round button in the team colour; disabled/grey when buzzers are not live; shows "You buzzed!"
  or "<name> (<team>) buzzed first" and the clue's category. Vibrates on buzz where supported. **Buzzer sound
  (V3.1)**: on its own winning buzz (the server's ack says it won) the phone plays its team's buzzer
  (`buzzerBlue` / `buzzerPink`, preloaded once the join is confirmed; the press is the gesture that unlocks
  audio) — never on a lost buzz, a lockout or an error. The monitor plays the same sound from the broadcast.
* Reconnects automatically (socket.io) and rejoins with the stored playerId.

### /admin
* Login page. Token in localStorage. Full `GameState` via `/admin` socket.
* **Game tab**: new game (pick pack, team names, who starts), phase controls, the full action set with buttons
  that are only enabled when the action is valid for the current state (use `allowedActions(state)` from the
  engine; `game:undo` when `state.undoable`), score ±1/±5, live preview of what the monitor shows (text summary
  is fine), player list, and the current question's answer/clues visible to the host. Destructive one-click
  actions ask for an inline confirmation: leaving a round with progress (round buttons, *Back to lobby*), the
  wall's *Time up*, *Abort wall*, starting a new game over one in progress.
* **Game tab, question rounds (V3)**: the 40 s countdown next to the clue controls (`questionSecondsRemaining`)
  and a *Time up* button (`q:timeUp`, enabled while the clock runs) for calling time early; after time up
  *Reveal next clue* is disabled and the judgement buttons stay. The wall's *Start wall* button is labelled
  with the clock length, "Start wall (2:30)".
* **Show cues panel (V3)**: *Opening titles (music)* and *Opening clip (video)* (`cue:play {cue}`, labels from
  `CUE_LABELS`, enabled in every phase) plus *Stop* (`cue:stop`, enabled while a cue is set); shows which cue
  is set and when it was fired ("cue set: …"), never "playing" — the monitor ends a clip / the music on its own
  without a state change. Playback happens on the monitor only.
* **Game tab, wall round**: a status line "Wall N of M — <Team> to choose" (`wallsDone + 1`, `wallsTotal`,
  `wall.team`) and a glyph picker for `wall:select` over `wall.available` (used glyphs disabled; enabled only in
  stage `selecting`, see `selectableWallHieroglyphs(state)`), each glyph showing its wall's four connections for
  the host; while a wall is on screen the usual start / time up / abort / resolve / connection / finish / clear
  controls.
* **Packs tab**: list, create, duplicate, export/import, delete; editor with sections for Connections (1–12
  questions, hieroglyph picker over the twelve glyphs), Sequences (1–12), Walls (2 or 4 × 4 groups × 4 clues +
  connection, each with a hieroglyph picker — unique per wall, default per `nextWallHieroglyph`), Missing Vowels (categories + clues with auto-generated vowel-stripped display). Clue media: upload image/audio to the bucket, preview, remove.
  Shows the pack's `problems` list until it is playable.

## 9. Non-functional

* Everything must survive an API restart: the game state reloads from DB, players reconnect.
* No external network at runtime (fonts and assets are vendored).
* Keep dependencies modest and pinned. No Tailwind, no component libraries.
* Tests: `packages/shared` engine has vitest coverage for scoring, turn order, wall mechanics (groups, lives,
  time-up), vowels buzz/lock/judging, and projection (no leaks of answers). `api` has a smoke test for auth and
  the actions route (can use `vitest` with the engine and an in-memory repository mock).

## 10. Engine API (`@only-connect/shared`, `src/engine/index.ts`)

All pure, synchronous, deterministic. Never mutate inputs; return new state objects.

```ts
/** Build a fresh game from a playable pack. Throws GameError if validatePack(pack) has problems. */
export function createGame(
  pack: Pack,
  teams: Record<TeamId, { name: string }>,
  firstTeam: TeamId,
  ctx: ActionContext,
): GameState;

/** Apply any action except `game:new` and `game:undo` (the host handles those). Throws GameError when the action
 *  is not allowed in the current state. Always bumps `version` and sets `updatedAt = ctx.now`. */
export function applyAction(state: GameState, action: GameAction, ctx: ActionContext): GameState;

/** Whether `round` was left before it finished (its `round:start` resumes it). */
export function isRoundSuspended(state: GameState, round: RoundName): boolean;

/** What would be lost by leaving the round on screen (null when nothing), for confirmation prompts. */
export function roundProgress(state: GameState): string | null;

/** Admin action types that are valid right now (used to enable/disable buttons in /admin). */
export function allowedActions(state: GameState): AdminAction['type'][];

/** Strip everything the audience must not see. `now` becomes `serverNow`. */
export function projectPublic(state: GameState, now: number): PublicGameState;

/** Problems that make a pack unplayable (empty array = playable). */
export function validatePack(pack: Pack): string[];

/** "POLE ARC CAP" -> "PL RCC P" style display: uppercase, remove AEIOU, collapse whitespace, re-space into
 *  chunks that do not reveal word boundaries (deterministic from the answer). */
export function stripVowels(answer: string): string;

/** Deterministic Fisher–Yates using a seeded PRNG (mulberry32). */
export function shuffleWithSeed<T>(items: readonly T[], seed: number): T[];

/** Seconds left on a live wall (0 when ended or not started). */
export function wallSecondsRemaining(play: PublicWallPlay | WallPlay, now: number): number;

/** The question clock (V3). QUESTION_MS = QUESTION_SECONDS * 1000 (40 000); WALL_MS = WALL_SECONDS * 1000 (150 000). */
export const QUESTION_MS: number;
export const WALL_MS: number;
export type QuestionClock = Pick<PublicQuestionRoundState, 'startedAt' | 'endsAt' | 'timeUp'>;
/** Seconds left on a running question clock: 0 when there is no clock or once timeUp (works on the full or
 *  the public question state, or any `{ stage?, startedAt?, endsAt?, timeUp? }`). */
export function questionSecondsRemaining(
  qs: { stage?: string; startedAt?: number | null; endsAt?: number | null; timeUp?: boolean },
  now: number,
): number;
/** True iff stage === 'question', endsAt is set and !timeUp (safe on states persisted before V3). */
export function questionClockRunning(qs: { stage?: string; startedAt?: number | null; endsAt?: number | null; timeUp?: boolean }): boolean;

/** Human readable description of the current state for the admin console, e.g. "Connections — Blue to pick". */
export function describeState(state: GameState): string;
```

Behavioural details the engine must implement (in addition to §3):
* `round:start` with `connections` is allowed from `lobby`; `sequences` after connections finished (or from lobby
  for flexibility, as long as no round is mid-question); `wall` and `vowels` likewise. A round that is already
  finished cannot be restarted, nor can the round currently on screen (`canStartRound` is false for
  `state.phase`). Leaving a round with progress (`roundProgress(state) !== null`) stores it in `suspended` and
  the next `round:start` of that round restores it instead of building a fresh round state (§3.6). The team
  picking first in Connections is `firstTeam`; in Sequences it is the other team. Within a round teams strictly
  alternate picking.
* `round:start` of `connections` / `sequences` builds the round from the pack: `available` = the hieroglyphs of
  the pack's questions for that round in `HIEROGLYPHS` order, `questionsTotal = available.length` (1..12).
* `q:select` of an already used hieroglyph, or of one not in `available`, throws. The question is the pack
  question with that round and hieroglyph.
* **Question clock (V3).** `q:select` sets `question.startedAt = ctx.now`, `endsAt = ctx.now + QUESTION_MS`,
  `timeUp = false`. `q:reveal` leaves the clock alone. `q:timeUp` (fired by the API's timer at `endsAt`, or by
  the host early) sets `timeUp = true` and keeps `startedAt` / `endsAt` (clients still know when it ran); a repeated
  `q:timeUp` is a no-op (like `wall:timeUp`), and `q:reveal` after it throws `GameError` with code
  `question_time_up`. `q:correct` / `q:incorrect` / `q:void` / `q:next` and the steal judgements reset all three
  fields (`null` / `null` / `false`); the steal has no clock. `allowedActions` in stage `question` lists
  `q:timeUp` while `!timeUp`, drops `q:reveal` once `timeUp`, and always offers `q:correct` / `q:incorrect` /
  `q:void`. `describeState` ends with ` (40 s clock running)` or `; time's up — they must answer`. The public
  projection always carries the three fields (`null` / `false` for pre-V3 states). The API's `GameTimer`
  (alias `WallTimer`) arms the next deadline — `nextDeadline(state)`: `wall:timeUp` for a live wall,
  `q:timeUp` for a running question clock (`questionClockEndsAt(state)`) — re-arms on every state change and
  on boot, and ignores stale deadlines (type + `endsAt` compared — checked again when the queue applies the
  action, `GameStore.dispatchIf`, so a time-up queued behind a slow save never hits the next question); a
  timer-fired `q:timeUp` (`who: 'timer'`) never enters the undo history, the host's early press does.
* `q:reveal` is allowed while `revealed < max` (4 for connections, 3 for sequences) and the clock has not run
  out. `pointsOnOffer` = `CLUE_POINTS[revealed]`.
* `q:correct` awards `pointsOnOffer` to `team`, sets `revealed = 4`, stage `answer`, result `{winner: team, points, viaSteal: false}`.
* `q:incorrect` sets `revealed = 4`, stage `steal`, `pointsOnOffer = 1`. `q:stealCorrect` awards 1 to the other
  team → `answer`; `q:stealIncorrect` → `answer` with winner null. `q:correct` / `q:incorrect` set `playMedia` to
  the first audio clue they newly reveal (none → unchanged). `q:void` (from `question` / `steal`) behaves like
  `q:next` without a result: nothing is revealed, `questionsDone + 1`, the other team picks (or the round ends).
* `q:next` → `questionsDone + 1`; once `questionsDone = questionsTotal` the round state stays with stage `answer`
  and `allowedActions` offers only `round:start` (next round) / `game:lobby`; otherwise stage `selecting` with the
  other team.
* `round:start` of `wall` builds `WallRoundState` `{ stage: 'selecting', team: wallOpener(state), available:
  wallHieroglyphs(pack), used: [], current: null, wallsDone: 0, wallsTotal: available.length }` where the opener
  is the team behind on score (tie → `firstTeam`).
* `wall:select {hieroglyph}` (admin) is allowed only in stage `selecting` for a glyph in `available` that is not
  in `used` (the engine exports `selectableWallHieroglyphs(state)` for the picker); it builds `WallPlay` for
  `team` from the wall with that glyph (`wallByHieroglyph`), tiles shuffled via `shuffleWithSeed` (seed from
  `ctx.seed`), stage `ready`, pushes the glyph to `used` and sets stage `playing`. `allowedActions` lists
  `wall:select` while a glyph can be chosen. `wall:select {tileId}` (player) is the tile tap, see below.
  `wall:start` sets `startedAt = now`, `endsAt = now + WALL_MS` (150 000), `live`.
* **Projection of a ready wall (V3).** `projectPublic` sends `PublicWallPlay.tiles = []` while
  `current.stage === 'ready'` (the full state keeps the shuffled tiles); `groups` are still 4 entries with
  nothing revealed. The 16 tiles are first sent in the `wall:start` broadcast, so the monitor and the `/wall`
  panel show them at the same time. Clients must not read tiles in stage `ready`.
* `wall:select` (player action) only in `live` and while `now < endsAt`; toggles selection; on the 4th selection
  resolves immediately: correct → group `solvedOrder = next`, `foundByTeam = true`, tiles re-ordered so solved
  groups occupy the top rows in solve order; after the 2nd group `lives = 3`; wrong → `lastWrong = selected`,
  `selected = []`, and if `lives !== null` → `lives - 1`; at 0 → `frozen`, `endReason: 'lives'`. When the 3rd
  group is found, the 4th is auto-solved (`foundByTeam = true`, next solve order) and the wall is `frozen` with
  `endReason: 'complete'`.
* `wall:timeUp` → `frozen`, `endReason: 'time'` (no-op if already frozen or later). Whenever a wall freezes
  (`complete` / `lives` / `time`) the engine records `endedAt` (server ms; for `time` the earlier of `endsAt` and
  `ctx.now`) so the timer bars on the monitor and the wall panel stay where the wall stopped.
* `wall:resolve` → `resolving`; any unfound groups get `solvedOrder` assigned (next free indices) with
  `foundByTeam = false`, tiles reordered accordingly; `resolvingGroup = 0` (by solvedOrder order).
* `wall:abort` (any stage but `done`) → `current = null`, the wall's glyph removed from `used`, stage
  `selecting` with the same `team`, nothing awarded, `wallsDone` unchanged.
* `wall:connectionCorrect` / `wall:connectionIncorrect` mark the group at `resolvingGroup`, set
  `connectionRevealed = true`, advance `resolvingGroup` (null after the last). `wall:finish` is allowed when
  `resolvingGroup === null`: computes `awarded`, adds `total` to the team's score, stage `done`; when
  `used.length === wallsTotal` (the last wall) the round is marked finished (`finishedRounds`). `wall:clear`
  (from `done`) → `current = null`, `wallsDone + 1`, `team = otherTeam(team)`, stage `selecting`; after the last
  wall the grid is empty (`wallsDone === wallsTotal`, nothing selectable) and `allowedActions` offers the next
  round. `PublicWallRoundState` mirrors `stage`, `team`, `available`, `used`, `wallsDone`, `wallsTotal` with
  `current` projected as `PublicWallPlay`.
* `player:join {playerId, name, team, secret?}`: an existing id is updated (name, team, `connected = true`) only
  when its stored `secret` is undefined (adopts the given one) or equals the given one (`not_owner` otherwise);
  an unknown id is appended with the secret. Fails with `player_removed` for ids in `removedPlayers`
  (`game:removePlayer` adds them; `player:leave` does not), `game_full` at `MAX_PLAYERS`, `team_locked` for a
  team change while `phase === 'vowels'`.
* `player:buzz` is only accepted in `vowels` stage `clue`, from a player not in `lockedPlayers`; it moves to
  `buzzed` with `buzz` set. Any later buzz throws `GameError('too late', 'buzz_lost')`.
* `vowels:correct` → `result { team, delta: {team: +1} }`, score updated, stage `answer`.
  `vowels:incorrect` → −1 for the buzzing team, stage `other` (the other team may answer).
  `vowels:otherCorrect` → +1 to the other team, stage `answer`. `vowels:nobody` → stage `answer`.
  `vowels:reopen` (from `buzzed`) → back to `clue`, buzzing player added to `lockedPlayers`, `buzz = null`.
  `vowels:next` → next clue (`clue` stage is entered directly, buzzers open) or, at the end of a category, stage
  `category` of the next group; at the very end `allowedActions` offers `round:final`.
* `round:final` → phase `final` (allowed from any phase once at least one round has been played, or from
  `vowels`).
* Score adjustments and team renames are allowed in any phase.
* `media:play {clueIndex?}` sets `playMedia = { key, nonce: nonce + 1 }` for the given visible audio clue (default:
  the most recently revealed one); `q:reveal` of an audio clue does the same automatically. `media:stop` sets
  `playMedia = null`.
* **Show cues (V3).** `cue:play {cue}` (`cue` ∈ `CUE_NAMES`) sets `cue = { name, nonce }` where the nonce is
  the version of the `cue:play` action (a repeat re-triggers through the changed nonce, as with `playMedia`);
  `cue:stop` sets `cue = null`. `allowedActions` always contains `cue:play`, and `cue:stop` while a cue is set;
  `createGame` / `game:new` start with `cue: null`, `round:start` / `game:lobby` / `round:final` leave it alone.
  `GameState.cue` is optional (additive), `PublicGameState.cue` is required (`null` when unset). Both are
  `NOT_UNDOABLE` in the API; the zod schema accepts only `{ type: 'cue:play', cue: 'openingTitles' | 'introClip' }`.
* `projectPublic` must hide: unrevealed clue text/media, the answer before `answer` stage, the 4th sequences
  clue before `answer`, wall tile group membership and connections until solved/revealed, vowel answers until
  `answer`, question `note`s, player `secret`s, and anything else not in `PublicGameState`.
