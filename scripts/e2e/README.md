# Browser end-to-end test

`e2e.mjs` plays a whole game in real (headless Chromium) browsers against a running stack:

* opens `/monitor` (1920×1080), `/wall` (1024×768), two `/button` phones (390×844, "Mia" on pink and "Jason"
  on blue) and `/admin` (1440×900);
* logs in, starts a game with the seeded demo pack, and drives every round through the real admin UI:
  Connections (6 questions: reveals, correct, incorrect, steals, audio clues incl. "play again"), Sequences,
  both Connecting Walls (tiles are tapped on the `/wall` page; one wall runs out of lives, the other is ended
  by the host; connections are judged and points awarded), Missing Vowels (buzzes from the phones, correct /
  incorrect / other team / reopen / nobody / skip category), the undo button, the identity checks (a socket that
  never joined cannot buzz, leave or rejoin as another player) and the final scores;
* restarts the API mid-game (through `run.sh`) and checks that the monitor, the phones and the admin console all
  reconnect to the same game;
* checks that the monitor requests the audio clips (`/api/media/...`) on reveal and on "Play audio again";
* screenshots all five screens at every stage (`NN-<stage>-<screen>.png`) and writes `e2e-log.txt`.
  Every judgement is verified against the authoritative state read through the admin API and the expected
  running score; the exit code is non-zero if any check fails.

## Run

The stack must be up (the demo pack is seeded on the first boot):

```sh
APP_PORT=8089 docker compose up --build -d
scripts/e2e/run.sh                # output in ~/.cache/oc-e2e/e2e/
```

`run.sh` runs the script inside `mcr.microsoft.com/playwright:v1.47.2-jammy` with `--network host`
(no Node needed on the host), installs `playwright@1.47.2` and `socket.io-client` into `$WORK` on the first run, and performs the
`docker compose restart api` step when the script asks for it.

Options: `WORK=/some/dir` (output + node_modules; must be mountable by Docker), `BASE_URL=http://host:port`,
`RESTART=skip` to leave the API alone, `APP_PORT` if the stack is not on 8089.

Running the script by hand (without the runner) also works; set `RESTART_MODE=skip` or the restart step will
time out after 90 s and be reported as a failure.
