# Browser end-to-end test

`e2e.mjs` plays a whole game in real (headless Chromium) browsers against a running stack:

* opens `/monitor` (1920×1080), `/wall` (1024×768), two `/button` phones (390×844, "Mia" on pink and "Jason"
  on blue) and `/admin` (1440×900);
* logs in, starts a game with the seeded demo pack, and drives every round through the real admin UI:
  Connections (6 questions: reveals, correct, incorrect, steals, audio clues incl. "play again"), Sequences,
  both Connecting Walls (the team behind chooses a wall by its hieroglyph in the admin picker while the monitor
  shows the glyph board; tiles are tapped on the `/wall` page and the solved rows are checked to glide to the
  top; one wall runs out of lives, the other is ended by the host; connections are judged and points awarded),
  Missing Vowels (buzzes from the phones, correct / incorrect / other team / reopen / nobody / skip category),
  the undo button, the identity checks (a socket that never joined cannot buzz, leave or rejoin as another
  player) and the final scores;
* checks the V3 behaviour: the 40 s question clock (`startedAt` / `endsAt` / `timeUp` in the full and the
  public state; on the monitor the timer is the "N Points" pill — `[data-testid="question-timer"]`, visible
  with `data-time-up="false"` and the points text while the clock runs, no `role="progressbar"` anywhere on
  the screen — one "Time up" pressed early per scenario with "Reveal next clue" disabled, the pill's
  `data-time-up="true"` and the "Time's up" caption `[data-testid="question-timeup"]` on the monitor, then a
  normal judgement), the first-clue intro (every pick waits up to 4 s for the pill to be really on screen —
  present, laid out and faded in — before the question screen is asserted, and logs whether the intro was
  observed), a winning Missing Vowels buzz credited to its team in the full and the public state (the team
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
  question (keep screenshots and sleeps short while a question is in stage `question`; the first-clue intro
  already costs ~1.5 s of every pick).

## Scenarios

* `E2E_SCENARIO=demo` (default): the seeded Demo pack as described above, output in `$WORK/e2e/`.
* `E2E_SCENARIO=big`: creates **E2E big pack** through the admin API (12 Connections + 12 Sequences questions
  tagged with all twelve hieroglyphs, 4 walls — Sun, Lion, Ankh, Water — and one Missing Vowels category; a
  13th question in a round and a 5th wall are checked to be refused), plays all 12 Connections picks on the
  4-column board (alternation, "Question 12 of 12"), Sequences over REST, the four walls chosen by hieroglyph
  (blue, pink, blue, pink; one wall is aborted and handed back; every wall is tapped on the real `/wall` page
  with the solved-row animation checked; perfect wall, out of lives, time up), a short vowels round and the
  final. No API restart. Output in `$WORK/e2e-big/`; the pack is left in place for the host to look at.

## Run

The stack must be up (the demo pack is seeded on the first boot):

```sh
APP_PORT=8089 docker compose up --build -d
scripts/e2e/run.sh                   # output in ~/.cache/oc-e2e/e2e/
E2E_SCENARIO=big scripts/e2e/run.sh  # output in ~/.cache/oc-e2e/e2e-big/
```

`run.sh` runs the script inside `mcr.microsoft.com/playwright:v1.47.2-jammy` with `--network host`
(no Node needed on the host), installs `playwright@1.47.2` and `socket.io-client` into `$WORK` on the first run, and performs the
`docker compose restart api` step when the script asks for it.

Options: `WORK=/some/dir` (output + node_modules; must be mountable by Docker), `BASE_URL=http://host:port`,
`RESTART=skip` to leave the API alone, `APP_PORT` if the stack is not on 8089, `E2E_SCENARIO=big`.

Running the script by hand (without the runner) also works; set `RESTART_MODE=skip` or the restart step will
time out after 90 s and be reported as a failure.
