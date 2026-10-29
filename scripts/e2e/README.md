# Browser end-to-end test

`e2e.mjs` plays a whole game in real (headless Chromium) browsers against a running stack:

* opens `/monitor` (1920×1080), `/wall` (1024×768), one `/button` phone per team (390×844: "Mia" on pink and
  "Jason" on blue; the `teams4` scenario adds "Priya" on green and "Omar" on orange) and `/admin` (1440×900);
* logs in, starts a game with the seeded demo pack (V3.2: `game:new {packId, teams: [{id, name}]}` — the New
  game panel's team count and one name field per team; the "picks first" choice is gone) and drives every
  round through the real admin UI — every round start goes through the **order picker** (the round button
  opens `[data-testid="round-order-picker"]` with one `[data-testid="order-row-<id>"]` per playing team, the
  buttons `order-up-<id>` / `order-down-<id>` and `order-start`, *Start <Round>*; the script checks the picker opens with the engine's suggested
  order — lowest score first, ties keeping the previous round's order — arranges the order it wants with the
  "up" buttons and asserts `state.<round>.order` and the public `order` / `activeTeams` afterwards; the demo
  and big scenarios reproduce the V3 flow: Connections pink first, Sequences blue first, the wall lowest
  score first):
  Connections (6 questions: reveals, correct, incorrect, steals, audio clues incl. "play again"), Sequences,
  both Connecting Walls (the team behind chooses a wall by its hieroglyph in the admin picker while the monitor
  shows the glyph board; tiles are tapped on the `/wall` page and the solved rows are checked to glide to the
  top; one wall runs out of lives, the other is ended by the host; connections are judged and points awarded),
  Missing Vowels (buzzes from the phones, correct / incorrect / other team / reopen / nobody / skip category),
  the undo button, the identity checks (a socket that never joined cannot buzz, leave or rejoin as another
  player; a join to an idle team — green in a two-team game — is refused with `team_inactive`), four refused
  `round:start` orders (`invalid_order`: a repeated team, one team, an idle team, three teams) and the final
  scores (one bar per playing team, the winner first); the `teams` record is checked to hold all four ids with
  the idle teams at their default name and score 0, the join form to offer only the playing teams and the
  monitor's score strip to show only them;
* checks the V3 behaviour: the 40 s question clock (`startedAt` / `endsAt` / `timeUp` in the full and the
  public state; on the monitor the timer is the "N Points" pill — `[data-testid="question-timer"]`, visible
  with `data-time-up="false"` and the points text while the clock runs, no `role="progressbar"` anywhere on
  the screen — one "Time up" pressed early per scenario with "Reveal next clue" disabled, the pill's
  `data-time-up="true"` and the "Time's up" caption `[data-testid="question-timeup"]` on the monitor, then a
  normal judgement), the pick-to-question intro (V3.1: after every pick `startedAt` is checked to lie
  4.5–6.5 s after the pick's public acknowledgement arrived — and at most 5.3 s after the `serverNow` it
  carried — with `endsAt - startedAt === 40000`; the monitor is watched for up to 9 s: it must keep the
  hieroglyph grid with the chosen slot marked `[data-testid="intro-tile"]`, whose `data-intro-phase` must
  pass `pulse` and reach `clue` in the order pulse → whoosh → empty → clue (`clue` starting 3.6–4.85 s after
  the ack) with the first clue's text / picture / gramophone inside the slot, no points pill before the cut;
  then the pill must be really on screen — present, laid out and faded in — 4.5–6.5 s after the ack and
  within 1 s of `startedAt` on the server clock, the intro tile gone), the question layout drawing only the
  revealed clues (after every pick and every reveal: as many light tiles as `revealed`, no visible
  "hidden clue" / dark placeholder, Sequences' "?" tile still there; the slide-in is only logged), a winning
  Missing Vowels buzz credited to its team in the full and the public state (the team
  buzzers key on it; their play() calls are logged, not asserted), the Connecting Wall hidden until "Start wall (2:30)"
  (public `tiles: []`, no tiles on the monitor, "Get ready" on `/wall`, then 16 tiles on both and a 150 s
  clock), the big picture clue above the clue row (demo scenario, flag and moon images: `[data-testid="big-image"]
  img`, at least 30 % of the viewport height, gone at the answer) and the show cues from the admin "Show cues"
  panel at the lobby (opening clip → a visible `<video>` on the monitor, Stop hides it; opening titles →
  `state.cue.name === 'openingTitles'`, Stop);
* restarts the API mid-game (through `run.sh`, during Missing Vowels where no clock runs) and checks that the
  monitor, the phones and the admin console all reconnect to the same game;
* checks that the monitor requests the audio clips (`/api/media/...`) on reveal and on "Play audio again";
* screenshots all five screens at every stage (`NN-<stage>-<screen>.png`) and writes `e2e-log.txt`.
  Every judgement is verified against the authoritative state read through the admin API and the expected
  running score; the public state is read on the `/` socket namespace (what the monitor, the wall and the
  phones receive); the log ends with the number of checks run and failed and the exit code is non-zero if any
  check fails. The question clock is 40 s and ends by itself on the server, so no step may linger on a running
  question (keep screenshots and sleeps short while a question is in stage `question`; the pick intro costs
  ~5.3 s of every pick, but the clock only starts counting when it is over). The API restart stays in Missing
  Vowels, away from running clocks and intros.

## Scenarios

* `E2E_SCENARIO=demo` (default): the seeded Demo pack as described above, output in `$WORK/e2e/`.
* `E2E_SCENARIO=big`: creates **E2E big pack** through the admin API (12 Connections + 12 Sequences questions
  tagged with all twelve hieroglyphs, 4 walls — Sun, Lion, Ankh, Water — and one Missing Vowels category; a
  13th question in a round and a 5th wall are checked to be refused), plays all 12 Connections picks on the
  4-column board (alternation, "Question 12 of 12"), Sequences over REST, the four walls chosen by hieroglyph
  (blue, pink, blue, pink; one wall is aborted and handed back; every wall is tapped on the real `/wall` page
  with the solved-row animation checked; perfect wall, out of lives, time up), a short vowels round and the
  final. No API restart. Output in `$WORK/e2e-big/`; the pack is left in place for the host to look at.
* `E2E_SCENARIO=teams4` (V3.2): creates the same **E2E big pack** and plays it with **four teams** (pink
  "Nightwearers", blue "Bookworms", green "Gardeners", orange "Oracles"; one phone each). Checks: the New game
  panel with four name fields, `activeTeams` in creation order, a four-team `game:new` on the two-wall Demo
  pack refused with `not_enough_walls`; Connections in the order green, pink, orange, blue with question k
  going to `order[k % 4]` over all 12 questions (the first four through the admin UI with the intro, the rest
  over REST), a steal where the host names the stealer (pink wrong → *orange* stole, +1; `q:stealCorrect`
  without a team refused with `team_required`, by the answering team with `invalid_team`); Sequences in the
  order blue, orange, green, pink over REST (green steals pink's questions by name); the wall round in the
  suggested order (lowest score first), `wallsTotal = 4`, each team choosing and playing one wall (kept short:
  a few groups, *Time up*, resolve, connections, finish) with the chooser checked at every wall; Missing
  Vowels with the order as display order only — every buzzer enabled, a wrong buzz by blue locks the other
  three phones, then *orange answered* (`vowels:otherCorrect {team: 'orange'}`; without a team →
  `team_required`, by the buzzing team → `invalid_team`; the result's delta covers four teams), a correct
  buzz by green; the final with four bars and a single winner. The public state is checked for `activeTeams`,
  `order` on every round and a four-entry `teams` record. Output in `$WORK/e2e-teams4/`.

## Run

The stack must be up (the demo pack is seeded on the first boot):

```sh
APP_PORT=8089 docker compose up --build -d
scripts/e2e/run.sh                      # output in ~/.cache/oc-e2e/e2e/
E2E_SCENARIO=big scripts/e2e/run.sh     # output in ~/.cache/oc-e2e/e2e-big/
E2E_SCENARIO=teams4 scripts/e2e/run.sh  # output in ~/.cache/oc-e2e/e2e-teams4/
```

`run.sh` runs the script inside `mcr.microsoft.com/playwright:v1.47.2-jammy` with `--network host`
(no Node needed on the host), installs `playwright@1.47.2` and `socket.io-client` into `$WORK` on the first run, and performs the
`docker compose restart api` step when the script asks for it.

Options: `WORK=/some/dir` (output + node_modules; must be mountable by Docker), `BASE_URL=http://host:port`,
`RESTART=skip` to leave the API alone, `APP_PORT` if the stack is not on 8089, `E2E_SCENARIO=big|teams4`.

**Docker Desktop**: `--network host` there is not the host's network (the runner lands in a bridge namespace),
so `localhost:<port>` does not reach a stack published on the host; pass
`BASE_URL=http://host.docker.internal:<port>` instead. Plain Docker Engine needs nothing.

### Against the standalone API (Version 4, no compose)

`scripts/standalone-e2e.sh` builds the repo in a `node:22-alpine` container, starts `node api/dist/server.js`
the way the Windows exe runs it — `DATABASE_DRIVER=pglite`, `STORAGE_DRIVER=fs`, `SERVE_CLIENT_DIR=client/dist`,
port 8089, no Postgres / MinIO / nginx — waits for `/api/health`, then runs this runner with `RESTART=skip` for
`demo`, `big` and `teams4` (the API-restart step does not apply; the `BASE_URL` for the runner is probed:
`localhost`, then `host.docker.internal`). Output: `$WORK/standalone-<scenario>/` holding the runner's usual
`e2e/` / `e2e-big/` / `e2e-teams4/` directory plus `run-<scenario>.log`; the server log is
`$WORK/standalone-server.log`. `SCENARIOS="demo big"` selects scenarios, `SKIP_BUILD=1` reuses the previous
build, `KEEP=1` leaves the server container (`oc-standalone-api`) running, `KEEP_DATA=1` keeps the previous
run's database and media.

## What the script assumes of the admin UI (V3.2)

The selectors the script relies on (change them here and in the admin console together): New game —
`#adm-new-pack`, the "Teams" radio group `[data-testid="team-count"]` with one `[data-testid="team-count-N"]`
label per count (2..4), `#adm-new-<teamId>` name fields (`#adm-new-pink` … `#adm-new-orange`, only for the
chosen count), no `adm-first-team` radio any more; the round buttons `1. Connections` … `4. Missing Vowels`
open the order picker `[data-testid="round-order-picker"]` (`data-round`) — one `[data-testid="order-row-<id>"]`
per playing team (also `data-team`), the buttons `order-up-<id>` / `order-down-<id>`, and `order-start` to send
`round:start` ("Start <Round>", or the confirm button of the leave-a-round prompt); a suspended round shows
`[data-testid="order-resume"]` instead of the rows. Team-naming judgements (3+ teams, inside
`[data-testid="steal-buttons"]` for the steal): one enabled button per candidate team labelled "<Team> stole it"
/ "<Team> correct" plus "Nobody stole" / "Nobody"; with two teams the labels stay "Steal correct" / "Other team
correct". Monitor: `.oc-scorestrip__chip--<id>` per playing team, `.oc-final__row--<id>` per playing team
(winner first), "<Team> win!" / "It's a draw!". Phone: `.join__team--<id>` for the playing teams only.

Running the script by hand (without the runner) also works; set `RESTART_MODE=skip` or the restart step will
time out after 90 s and be reported as a failure.
