/**
 * End-to-end run of a complete Only Connect game in real browsers.
 *
 * Opens the monitor (1920x1080), the wall panel (1024x768), two phones (390x844, one per team) and the admin
 * console (1440x900) against a running stack, drives every round through the real /admin UI, taps the wall
 * tiles on the /wall page, buzzes from the phones, screenshots every screen at every stage and asserts on the
 * visible text and on the authoritative state (read back through the admin API).
 *
 * Two scenarios (E2E_SCENARIO):
 *   demo (default)  the seeded Demo pack: 6 + 6 questions, 2 walls (Lion, Water), 3 vowel categories, the api
 *                   restart test, undo, identity checks, the big picture clue and the show cues.
 *
 * V3 checks in both scenarios: the 40 s question clock (state + monitor timer, one "Time up" pressed early per
 * scenario), the 2:30 wall whose tiles stay hidden everywhere until "Start wall" (asserted on the public
 * socket state, the monitor and the /wall page), the opening clip / titles cues from the admin console. The
 * public state is read from the `/` socket namespace (what the monitor, wall and phones see), the full state
 * through the admin API.
 *
 * Timing: a question in stage `question` has a 40 s clock that the server ends by itself (`q:timeUp`), after
 * which "Reveal next clue" is refused — no step may linger on a running question (screenshots are ~1-2 s;
 * the api-restart test runs in Missing Vowels, where no clock runs).
 *   big             creates "E2E big pack" through the admin API (12 Connections + 12 Sequences questions using
 *                   all twelve hieroglyphs, 4 walls, 1 vowels category), plays all 12 Connections picks on the
 *                   4-column board, Sequences over REST, all four walls chosen by hieroglyph (chooser alternates,
 *                   one abort, every wall tapped on the real /wall page incl. the solved-row animation check),
 *                   a short Missing Vowels round and the final scores.
 *
 * Run it with scripts/e2e/run.sh (see the README there). Environment:
 *   BASE_URL      stack URL (default http://localhost:8089)
 *   OUT_DIR       screenshots + log go here (default ./e2e)
 *   ADMIN_USER / ADMIN_PASS  (default admin / 12346789)
 *   RESTART_MODE  'file' (default: ask the host runner to restart the api), 'skip' (no restart test)
 *   E2E_SCENARIO  'demo' (default) or 'big'
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const BASE = (process.env.BASE_URL ?? 'http://localhost:8089').replace(/\/$/, '');
const OUT = path.resolve(process.env.OUT_DIR ?? 'e2e');
const ADMIN_USER = process.env.ADMIN_USER ?? 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS ?? '12346789';
const RESTART_MODE = process.env.RESTART_MODE ?? 'file';
const SCENARIO = process.env.E2E_SCENARIO === 'big' ? 'big' : 'demo';
const PINK = 'Nightwearers';
const BLUE = 'Bookworms';

/** The twelve hieroglyphs in grid order, with the labels the UI shows (mirrors packages/shared/src/types.ts). */
const HIEROGLYPHS = ['twoReeds', 'lion', 'twistedFlax', 'hornedViper', 'water', 'eyeOfHorus', 'ankh', 'scarab', 'feather', 'owl', 'cobra', 'sun'];
const LABELS = {
  twoReeds: 'Two Reeds',
  lion: 'Lion',
  twistedFlax: 'Twisted Flax',
  hornedViper: 'Horned Viper',
  water: 'Water',
  eyeOfHorus: 'Eye of Horus',
  ankh: 'Ankh',
  scarab: 'Scarab',
  feather: 'Feather',
  owl: 'Owl',
  cobra: 'Cobra',
  sun: 'Sun',
};

fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(OUT)) if (/\.(png|txt)$/.test(f) || /^restart\./.test(f)) fs.unlinkSync(path.join(OUT, f));

// ---------------------------------------------------------------------------
// Logging / assertions
// ---------------------------------------------------------------------------

const logLines = [];
const failures = [];
const consoleErrors = [];
let checksTotal = 0;
let restartWindow = null;

function log(msg) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
  console.log(line);
  logLines.push(line);
}
function check(cond, msg) {
  checksTotal += 1;
  if (cond) log(`ok   ${msg}`);
  else {
    log(`FAIL ${msg}`);
    failures.push(msg);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ---------------------------------------------------------------------------
// Admin API (for reading the authoritative state back)
// ---------------------------------------------------------------------------

let token = null;
async function api(method, p, body) {
  const res = await fetch(`${BASE}/api${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status} ${text.slice(0, 200)}`);
  return json;
}
const adminState = () => api('GET', '/admin/state');
/** Sends an admin action over REST (used where the UI path is already covered and speed matters). */
const rest = (a) => api('POST', '/admin/actions', a);

/** Poll the admin state until `pred` holds (or time out and record a failure). Returns the last state. */
async function waitState(pred, label, timeout = 12_000) {
  const start = Date.now();
  let last = null;
  let lastErr = null;
  checksTotal += 1;
  while (Date.now() - start < timeout) {
    try {
      last = await adminState();
      lastErr = null;
      if (last && pred(last)) {
        log(`ok   state: ${label}`);
        return last;
      }
    } catch (err) {
      lastErr = err;
    }
    await sleep(120);
  }
  failures.push(`state: ${label}`);
  log(`FAIL state: ${label}${lastErr ? ` (${lastErr.message})` : ''}`);
  return last;
}

// ---------------------------------------------------------------------------
// Public state (what the monitor, the wall panel and the phones receive on the `/` namespace)
// ---------------------------------------------------------------------------

let publicSocket = null;
/** Latest `state` broadcast seen on the public namespace (PublicStateMessage; `phase: 'none'` without a game). */
let latestPublic = null;
async function subscribePublic() {
  if (publicSocket) return;
  const { io } = await import('socket.io-client');
  publicSocket = io(BASE, { path: '/socket.io', transports: ['websocket'] });
  publicSocket.on('state', (st) => {
    latestPublic = st;
  });
  await new Promise((resolve, reject) => {
    publicSocket.once('connect', resolve);
    publicSocket.once('connect_error', reject);
  });
  check(true, 'subscribed to the public state on the / namespace');
}
/** Poll the latest public broadcast until `pred` holds (or time out and record a failure). */
async function waitPublic(pred, label, timeout = 12_000) {
  const start = Date.now();
  checksTotal += 1;
  while (Date.now() - start < timeout) {
    const st = latestPublic;
    let ok = false;
    try {
      ok = Boolean(st && st.phase !== 'none' && pred(st));
    } catch {
      ok = false;
    }
    if (ok) {
      log(`ok   public: ${label}`);
      return st;
    }
    await sleep(120);
  }
  failures.push(`public: ${label}`);
  log(`FAIL public: ${label}`);
  return latestPublic;
}

// ---------------------------------------------------------------------------
// Browser helpers
// ---------------------------------------------------------------------------

const browser = await chromium.launch();
const pages = {};
function trackErrors(name, page) {
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push({ page: name, text: m.text(), at: Date.now() });
  });
  page.on('pageerror', (err) => consoleErrors.push({ page: name, text: `pageerror: ${err.message}`, at: Date.now() }));
}
async function open(name, width, height, url, mobile = false) {
  const ctx = await browser.newContext({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1 });
  // Count every HTMLMediaElement.play() so audio replays can be verified even when the clip comes from cache.
  await ctx.addInitScript(() => {
    window.__ocPlays = [];
    const orig = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function play(...args) {
      // `src` is set synchronously; `currentSrc` only updates after resource selection, so it can lag behind.
      window.__ocPlays.push({ src: this.src || this.currentSrc || '', at: Date.now() });
      return orig.apply(this, args);
    };
  });
  const page = await ctx.newPage();
  trackErrors(name, page);
  await page.goto(`${BASE}${url}`, { waitUntil: 'domcontentloaded' });
  pages[name] = page;
  return page;
}

let shotIndex = 0;
async function shot(stage) {
  shotIndex += 1;
  const nn = String(shotIndex).padStart(2, '0');
  await sleep(450); // let transitions settle
  for (const [name, page] of Object.entries(pages)) {
    try {
      await page.screenshot({ path: path.join(OUT, `${nn}-${stage}-${name}.png`) });
    } catch (err) {
      log(`screenshot ${nn}-${stage}-${name} failed: ${err.message}`);
    }
  }
  log(`shot ${nn}-${stage}`);
}

async function seeText(page, text, label = text, timeout = 8_000) {
  try {
    await page.getByText(text, { exact: false }).first().waitFor({ state: 'visible', timeout });
    check(true, `${pageName(page)} shows "${label}"`);
    return true;
  } catch {
    check(false, `${pageName(page)} shows "${label}"`);
    return false;
  }
}
function pageName(page) {
  return Object.entries(pages).find(([, p]) => p === page)?.[0] ?? 'page';
}

// Admin UI
const admin = () => pages.admin;
async function clickAdmin(name, opts = {}) {
  // Several sections carry a button with the same label (e.g. "Correct" in Connections and in Missing
  // Vowels); only the one for the live round is enabled.
  const loc = admin().getByRole('button', { name, exact: opts.exact ?? true, disabled: false }).first();
  await loc.click({ timeout: opts.timeout ?? 10_000 });
}
/** Click an admin action button then wait for the state to satisfy `pred`. */
async function action(name, pred, label = name, opts = {}) {
  await clickAdmin(name, opts);
  return waitState(pred, label);
}
/** The question-round hieroglyph picker (not the wall one). */
async function pickHieroglyph(label) {
  await admin().locator(`.adm-glyphpick:not(.adm-glyphpick--walls) [role="button"][aria-label="${label}"]`).click();
  return waitState((s) => s.question?.stage === 'question', `picked ${label}`);
}
/** The wall picker (stage `selecting`): click the glyph the choosing team wants. */
const wallPicker = () => admin().getByTestId('wall-picker');
async function chooseWall(glyph, team) {
  const label = LABELS[glyph];
  await wallPicker().getByRole('button', { name: label, exact: true }).click({ timeout: 10_000 });
  return waitState(
    (s) => s.wall?.stage === 'playing' && s.wall.current?.stage === 'ready' && s.wall.current.team === team && s.wall.used.includes(glyph),
    `${team} chose the ${label} wall (on screen, ready)`,
  );
}
/** Which wall glyphs the admin picker offers right now (enabled buttons) and which it shows as used. */
async function pickerGlyphs() {
  const enabled = await wallPicker().locator('[role="button"]:not([aria-disabled="true"])').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
  const used = await wallPicker().locator('[aria-label$="(used)"]').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label').replace(' (used)', '')));
  return { enabled, used };
}

// Expected scores (kept alongside the run so every judgement is verified).
const exp = { pink: 0, blue: 0 };
async function expectScores(label) {
  const s = await waitState((st) => st.teams.pink.score === exp.pink && st.teams.blue.score === exp.blue, `scores ${exp.pink}-${exp.blue} (${label})`);
  return s;
}
const other = (t) => (t === 'pink' ? 'blue' : 'pink');
/** The engine's wall opener: the team behind on score, a tie goes to the team that picked first. */
const behind = (firstTeam) => (exp.pink < exp.blue ? 'pink' : exp.blue < exp.pink ? 'blue' : firstTeam);
const teamName = (t) => (t === 'pink' ? PINK : BLUE);

// ---------------------------------------------------------------------------
// Wall helpers (tiles are tapped on the /wall page)
// ---------------------------------------------------------------------------

/** Tile ids of a group in the current wall (ids are stable across re-ordering). */
function groupIds(s, groupIndex) {
  return s.wall.current.tiles.filter((t) => t.group === groupIndex).map((t) => t.id);
}
function unsolvedGroups(s) {
  return s.wall.current.groups.filter((g) => g.solvedOrder === null).map((g) => g.index);
}
async function tapTile(id) {
  const before = (await adminState()).version;
  await pages.wall.locator(`[data-tile-id="${id}"]`).click({ timeout: 5_000 });
  return waitState((s) => s.version > before, `tile ${id} tapped`, 6_000);
}
async function solveGroup(groupIndex) {
  const s = await adminState();
  const ids = groupIds(s, groupIndex);
  const before = s.wall.current.groups[groupIndex].solvedOrder;
  for (const id of ids) await tapTile(id);
  const after = await waitState((st) => st.wall.current.groups[groupIndex].solvedOrder !== null, `group ${groupIndex} solved`);
  check(before === null && after.wall.current.groups[groupIndex].foundByTeam === true, `group ${groupIndex} found by the team`);
  return after;
}
async function wrongGuess() {
  const s = await adminState();
  const [a, b] = unsolvedGroups(s);
  const ids = [...groupIds(s, a).slice(0, 2), ...groupIds(s, b).slice(0, 2)];
  const livesBefore = s.wall.current.lives;
  for (const id of ids) await tapTile(id);
  return waitState(
    (st) => st.wall.current.lastWrong !== null && st.wall.current.selected.length === 0 && (livesBefore === null || st.wall.current.lives === livesBefore - 1 || st.wall.current.stage === 'frozen'),
    `wrong guess registered (lives ${livesBefore} -> ${livesBefore === null ? 'n/a' : livesBefore - 1})`,
  );
}
/**
 * The solved group glides to the top row (FLIP animation on the /wall page). Waits until the four tiles of
 * `groupIndex` sit on the first row with no transform left on them, and reports whether a glide was seen.
 */
async function expectRowAnimation(groupIndex, rowIndex = 0) {
  const s = await adminState();
  const ids = groupIds(s, groupIndex);
  const probe = (tileIds) =>
    pages.wall.evaluate((tileIds) => {
      const all = [...document.querySelectorAll('.wallboard [data-tile-id]')];
      if (all.length !== 16) return { ok: false, reason: `${all.length} tiles` };
      const rects = all.map((el) => ({ id: el.dataset.tileId, r: el.getBoundingClientRect(), tf: el.style.transform, cs: getComputedStyle(el).transform }));
      const tops = [...new Set(rects.map((x) => Math.round(x.r.top)))].sort((a, b) => a - b);
      const mine = rects.filter((x) => tileIds.includes(Number(x.id)));
      const animating = rects.some((x) => x.tf !== '' || (x.cs !== 'none' && x.cs !== 'matrix(1, 0, 0, 1, 0, 0)'));
      return { ok: true, rows: tops, mine: mine.map((x) => ({ id: x.id, top: Math.round(x.r.top), left: Math.round(x.r.left) })), animating };
    }, tileIds);
  let sawGlide = false;
  let settled = null;
  const start = Date.now();
  while (Date.now() - start < 4_000) {
    const p = await probe(ids);
    if (p.ok) {
      if (p.animating) sawGlide = true;
      const onRow = p.mine.every((m) => m.top === p.rows[rowIndex]);
      if (!p.animating && onRow && p.mine.length === 4) {
        settled = p;
        break;
      }
    }
    await sleep(40);
  }
  check(settled !== null, `group ${groupIndex} tiles settled on row ${rowIndex + 1} of the /wall page with no transform left${settled ? ` (lefts ${settled.mine.map((m) => m.left).join(', ')})` : ''}`);
  log(`     glide ${sawGlide ? 'observed' : 'not observed'} while group ${groupIndex} moved (tap->state->paint may beat the probe)`);
  return settled;
}
/** Pack definition of the wall on screen. */
const wallDef = (s) => s.pack.walls.find((w) => w.id === s.wall.current.wallId);
/**
 * "Start wall (2:30)" with the V3 contract around it: while the wall is `ready` nobody sees its tiles (the
 * public projection sends `tiles: []`, the monitor keeps its glyph grid, the /wall page says "Get ready");
 * the 16 tiles reach the monitor and the panel in the same `wall:start` broadcast.
 */
async function startWall(n) {
  const ready = await waitPublic((p) => p.wall?.current?.stage === 'ready', `wall ${n}: public state has the wall in stage ready`);
  const pubTiles = ready?.wall?.current?.tiles;
  check(Array.isArray(pubTiles) && pubTiles.length === 0, `wall ${n}: public tiles are [] while ready (${Array.isArray(pubTiles) ? pubTiles.length : 'n/a'} tiles)`);
  check(ready?.wall?.current?.groups?.length === 4 && ready.wall.current.groups.every((g) => g.connection === null), `wall ${n}: public groups are 4 unrevealed entries while ready`);
  check((await pages.monitor.locator('[data-tile-id]').count()) === 0, `wall ${n}: monitor shows no wall tiles while ready`);
  check((await pages.wall.locator('[data-tile-id]').count()) === 0, `wall ${n}: /wall shows no tiles while ready`);
  await seeText(pages.wall, 'Get ready', `wall ${n}: /wall "Get ready"`);
  await action('Start wall (2:30)', (s) => s.wall.current?.stage === 'live', `wall ${n} live`);
  await pages.wall.locator('[data-tile-id="0"]').waitFor({ timeout: 5_000 });
  check((await pages.wall.locator('[data-tile-id]').count()) === 16, `wall ${n}: /wall shows 16 tiles`);
  await pages.monitor.locator('[data-tile-id="0"]').waitFor({ timeout: 5_000 }).catch(() => {});
  check((await pages.monitor.locator('[data-tile-id]').count()) === 16, `wall ${n}: monitor shows 16 tiles`);
  const live = await waitPublic((p) => p.wall?.current?.stage === 'live' && p.wall.current.tiles.length === 16, `wall ${n}: public state carries the 16 tiles once live`);
  const play = live?.wall?.current;
  check(play && play.endsAt - play.startedAt === 150_000, `wall ${n}: the wall clock is 150 s (endsAt - startedAt = ${play ? play.endsAt - play.startedAt : 'n/a'} ms)`);
}

// ---------------------------------------------------------------------------
// Question clock, big picture and show cues (V3)
// ---------------------------------------------------------------------------

/** After a pick: the 40 s clock is set in the full and the public state and the monitor shows a timer. */
async function expectQuestionClock(label) {
  const s = await waitState(
    (st) => st.question?.stage === 'question' && typeof st.question.startedAt === 'number' && typeof st.question.endsAt === 'number' && st.question.timeUp === false,
    `${label}: 40 s clock started on q:select`,
  );
  const q = s?.question;
  check(q && q.endsAt - q.startedAt === 40_000, `${label}: endsAt - startedAt = 40 000 ms (${q ? q.endsAt - q.startedAt : 'n/a'})`);
  await waitPublic((p) => p.question?.startedAt === q?.startedAt && p.question.endsAt === q?.endsAt && p.question.timeUp === false, `${label}: public state carries the clock`);
  // The monitor's timer: a stable test id if the screen has one, else any progressbar (the show's timer bar)
  // or a m:ss countdown text under 40 s.
  const monitor = pages.monitor;
  const timer = monitor.locator('[data-testid="question-timer"], [role="progressbar"]');
  let seen = null;
  const start = Date.now();
  while (Date.now() - start < 5_000 && !seen) {
    if ((await timer.count()) > 0) seen = 'timer element';
    else if ((await monitor.getByText(/^0:[0-3]\d$/).count()) > 0) seen = '0:ss text';
    else await sleep(150);
  }
  check(seen !== null, `${label}: monitor shows the question timer (${seen ?? 'neither data-testid="question-timer", a progressbar nor a 0:ss clock found'})`);
  return s;
}

/** The host presses "Time up" early: no more reveals, the team must answer; the host then judges as usual. */
async function questionTimeUpEarly(label) {
  await clickAdmin('Time up');
  // The wall's "Time up" asks for a confirmation (same label on the confirm button); accept one if the
  // question's does too.
  const confirmed = await admin().locator('.adm-confirm').waitFor({ timeout: 1_500 }).then(() => true, () => false);
  if (confirmed) await clickAdmin('Time up');
  const s = await waitState((st) => st.question?.stage === 'question' && st.question.timeUp === true, `${label}: "Time up" pressed early -> timeUp = true`);
  check(typeof s?.question?.startedAt === 'number' && typeof s?.question?.endsAt === 'number', `${label}: startedAt / endsAt kept after time up (bars stay full)`);
  await waitPublic((p) => p.question?.timeUp === true, `${label}: public timeUp = true`);
  check(await admin().getByRole('button', { name: 'Reveal next clue' }).isDisabled(), `${label}: "Reveal next clue" disabled after time up`);
  await seeText(pages.monitor, "Time's up", `${label}: monitor shows "Time's up"`);
  return s;
}

/** The most recently revealed picture clue is shown large above the clue row (stages question / steal). */
async function expectBigPicture(label) {
  const img = pages.monitor.locator('[data-testid="big-image"] img').first();
  const ok = await img.waitFor({ state: 'visible', timeout: 6_000 }).then(() => true, () => false);
  check(ok, `${label}: a large picture ([data-testid="big-image"] img) is on the monitor`);
  if (!ok) return;
  const box = await img.boundingBox();
  const vh = pages.monitor.viewportSize().height;
  check(box !== null && box.height >= vh * 0.3, `${label}: the big picture is at least 30 % of the viewport height (${box ? Math.round(box.height) : 'n/a'} px of ${vh})`);
  const outsideRow = await img.evaluate((el) => el.closest('.oc-cluerow') === null);
  check(outsideRow, `${label}: the big picture sits outside the clue row`);
  const cluesBelow = await pages.monitor.locator('.oc-cluerow img').count();
  check(cluesBelow >= 1, `${label}: the clue row still shows the picture tile(s) (${cluesBelow})`);
}
async function expectNoBigPicture(label) {
  const big = pages.monitor.locator('[data-testid="big-image"] img');
  const gone = await big.first().waitFor({ state: 'hidden', timeout: 6_000 }).then(() => true, () => false);
  check(gone, `${label}: no big picture on the monitor`);
}

/** Show cues from the admin "Show cues" panel: the opening clip (video) and the opening titles (music). */
async function showCues(stage) {
  const cues = admin().getByTestId('show-cues');
  const monitor = pages.monitor;
  const plays = (fragment) => monitor.evaluate((f) => window.__ocPlays.filter((p) => p.src.includes(f)).length, fragment);

  // The monitor drops the clip overlay again as soon as the <video> errors, and Playwright's Chromium has no
  // H.264 decoder (DEMUXER_ERROR_NO_SUPPORTED_STREAMS within a few ms), so "is the overlay visible right
  // now" would be a race: a MutationObserver installed before the click records that the overlay was mounted
  // and what became of the video (playing, ended or the media error code).
  await monitor.evaluate(() => {
    window.__ocIntro = { mounted: false, error: null, playing: false };
    const seen = (v) => {
      window.__ocIntro.mounted = true;
      v.addEventListener('playing', () => { window.__ocIntro.playing = true; });
      v.addEventListener('error', () => { window.__ocIntro.error = v.error?.code ?? 'unknown'; });
    };
    const existing = document.querySelector('[data-testid="intro-video"]');
    if (existing) seen(existing);
    new MutationObserver(() => {
      const v = document.querySelector('[data-testid="intro-video"]');
      if (v && !v.__ocSeen) { v.__ocSeen = true; seen(v); }
    }).observe(document.body, { childList: true, subtree: true });
  });
  await cues.getByRole('button', { name: /Opening clip \(video\)/ }).click({ timeout: 10_000 });
  let s = await waitState((st) => st.cue?.name === 'introClip', `${stage}: cue:play introClip`);
  await waitPublic((p) => p.cue?.name === 'introClip' && p.cue.nonce === s?.cue?.nonce, `${stage}: public cue = introClip`);
  const video = monitor.locator('[data-testid="intro-video"]').first();
  const shown = await video.waitFor({ state: 'visible', timeout: 6_000 }).then(() => true, () => false);
  const intro = await monitor.evaluate(() => window.__ocIntro);
  check(shown || intro.mounted, `${stage}: monitor shows the opening clip ([data-testid="intro-video"] ${shown ? 'visible' : intro.mounted ? 'was mounted' : 'never mounted'})`);
  log(`     opening clip on the monitor: ${intro.playing ? 'playing' : intro.error !== null ? `media error ${intro.error} (headless Chromium has no H.264 decoder; the overlay then hides itself by design)` : 'loading'}; play() calls ${await plays('opening.mp4')} (autoplay does not go through play())`);
  await shot(`${stage}-clip`);
  await cues.getByRole('button', { name: /Stop/ }).click({ timeout: 10_000 });
  await waitState((st) => st.cue === null, `${stage}: cue:stop`);
  const hidden = await video.waitFor({ state: 'hidden', timeout: 6_000 }).then(() => true, () => false);
  check(hidden, `${stage}: the clip disappears on Stop`);

  await cues.getByRole('button', { name: /Opening titles \(music\)/ }).click({ timeout: 10_000 });
  s = await waitState((st) => st.cue?.name === 'openingTitles', `${stage}: state.cue.name === 'openingTitles'`);
  await waitPublic((p) => p.cue?.name === 'openingTitles' && p.cue.nonce === s?.cue?.nonce, `${stage}: public cue = openingTitles`);
  await sleep(800);
  log(`     openingTitlesWithFlurry.mp3 play() calls on the monitor: ${await plays('openingTitlesWithFlurry')}`);
  await cues.getByRole('button', { name: /Stop/ }).click({ timeout: 10_000 });
  await waitState((st) => st.cue === null, `${stage}: cue:stop (music)`);
  check((await monitor.locator('video').count()) === 0 || !(await monitor.locator('video').first().isVisible()), `${stage}: no clip on the monitor after the cues`);
}

// ---------------------------------------------------------------------------
// Shared flow pieces
// ---------------------------------------------------------------------------

async function login() {
  if (token) return;
  log(`stack ${BASE}, output ${OUT}, scenario ${SCENARIO}`);
  token = (await api('POST', '/admin/login', { username: ADMIN_USER, password: ADMIN_PASS })).token;
  check(typeof token === 'string' && token.length > 20, 'REST login returns a token');
}

async function openScreens() {
  await login();
  await subscribePublic();

  const monitor = await open('monitor', 1920, 1080, '/monitor');
  await open('wall', 1024, 768, '/wall');
  await open('buttonPink', 390, 844, '/button', true);
  await open('buttonBlue', 390, 844, '/button', true);
  const adminPage = await open('admin', 1440, 900, '/admin');

  const mediaRequests = [];
  monitor.on('request', (r) => {
    if (r.url().includes('/api/media/')) mediaRequests.push({ url: r.url(), at: Date.now() });
  });

  // Monitor: the sound overlay must be there, then a click removes it and unlocks audio.
  await seeText(monitor, 'Tap to enable sound');
  await shot('idle');
  await monitor.locator('[aria-label="Tap to enable sound"]').click();
  await monitor.locator('[aria-label="Tap to enable sound"]').waitFor({ state: 'detached', timeout: 5_000 });
  check(true, 'monitor sound overlay dismissed');

  // Admin login through the UI
  await adminPage.fill('#adm-login-user', ADMIN_USER);
  await adminPage.fill('#adm-login-pass', ADMIN_PASS);
  await clickAdmin('Log in');
  await adminPage.getByRole('link', { name: 'Game' }).waitFor({ timeout: 10_000 });
  await adminPage.locator('.adm-conn.is-on').waitFor({ timeout: 10_000 });
  check(true, 'admin logged in and /admin socket connected');
  return mediaRequests;
}

/** Admin → New game with `packName`, PINK / BLUE, pink picks first. */
async function newGame(packName) {
  const adminPage = admin();
  const existing = await adminState();
  if (existing) {
    // A game already exists (re-run): the panel starts collapsed.
    const expand = adminPage.locator('.adm-panel', { hasText: 'New game' }).getByRole('button', { name: /Expand/ });
    if (await expand.count()) await expand.click();
  }
  await adminPage.locator('#adm-new-pack').waitFor();
  // (a polling loop over evaluate: waitForFunction with an argument is wrapped in an eval string, which the
  // client's CSP `script-src 'self'` refuses)
  const hasPack = () =>
    adminPage.evaluate((name) => {
      const sel = document.querySelector('#adm-new-pack');
      return Boolean(sel && [...sel.options].some((o) => o.textContent.includes(name) && !o.disabled));
    }, packName);
  for (let i = 0; i < 100 && !(await hasPack()); i++) await sleep(100);
  check(await hasPack(), `"${packName}" is offered as a playable pack in New game`);
  await adminPage.selectOption('#adm-new-pack', { label: packName });
  await adminPage.fill('#adm-new-pink', PINK);
  await adminPage.fill('#adm-new-blue', BLUE);
  await adminPage.locator('label.adm-radio.is-pink').click();
  await adminPage.getByRole('button', { name: /^Start (a new )?game/ }).click();
  await sleep(300);
  const confirm = adminPage.getByRole('button', { name: 'Start new game' });
  if (await confirm.count()) await confirm.click();
  const state = await waitState((s) => s.phase === 'lobby' && s.teams.pink.name === PINK && s.teams.blue.name === BLUE, 'new game in lobby');
  check(state?.pack?.name === packName && state?.firstTeam === 'pink', `game uses "${packName}", pink picks first`);
  exp.pink = 0;
  exp.blue = 0;
  return state;
}

async function joinPhones() {
  async function join(page, name, team) {
    await page.locator('.join__input').fill(name);
    await page.locator(`.join__team--${team}`).click();
    await page.locator('.join__submit').click();
    await page.locator('.buzzer__button').waitFor({ timeout: 10_000 });
  }
  await join(pages.buttonPink, 'Mia', 'pink');
  await join(pages.buttonBlue, 'Jason', 'blue');
  const state = await waitState((s) => s.players.length === 2 && s.players.every((p) => p.connected), 'Mia and Jason joined and connected');
  const mia = state.players.find((p) => p.name === 'Mia');
  const jason = state.players.find((p) => p.name === 'Jason');
  check(mia?.team === 'pink' && jason?.team === 'blue', 'players are on the right teams');
  await seeText(pages.monitor, PINK);
  await seeText(pages.monitor, '2 players connected');
  await seeText(pages.buttonPink, PINK);
  await seeText(pages.buttonBlue, BLUE);
  await seeText(pages.wall, 'Waiting for the game master', 'wall idle text', 8_000);
  await seeText(admin(), 'Mia');
  await shot('lobby');
  return { mia, jason };
}

const buzzer = (page) => page.locator('.buzzer__button');
async function buzzFrom(page, who) {
  await buzzer(page).click({ timeout: 5_000 });
  return waitState((s) => s.vowels?.stage === 'buzzed' && s.vowels.buzz?.playerName === who, `${who} buzzed`);
}

/** The wall round starts on the glyph grid: nothing chosen, the team behind chooses first. */
async function startWallRound(firstTeam, expectedGlyphs) {
  const monitor = pages.monitor;
  const chooser = behind(firstTeam);
  const state = await action(/^3\. Connecting Wall/, (s) => s.phase === 'wall' && s.wall !== null, 'Wall round started', { exact: false });
  check(state.wall.stage === 'selecting' && state.wall.current === null, 'wall round starts in stage selecting with no wall on screen');
  check(same(state.wall.available, expectedGlyphs), `wall grid is ${JSON.stringify(state.wall.available)} (HIEROGLYPHS order)`);
  check(same(state.wall.used, []) && state.wall.wallsDone === 0 && state.wall.wallsTotal === expectedGlyphs.length, `used [], 0 of ${expectedGlyphs.length} walls done`);
  check(state.wall.team === chooser, `${teamName(chooser)} (${exp.pink}-${exp.blue}, behind or first) chooses the first wall`);
  await seeText(monitor, 'Connecting Wall');
  await seeText(monitor, `${teamName(chooser)} to choose a wall`);
  await seeText(monitor, `Wall 1 of ${expectedGlyphs.length}`);
  const tiles = await monitor.locator('.oc-monitor__wallgrid > [aria-label]').count();
  check(tiles === expectedGlyphs.length, `monitor shows the ${expectedGlyphs.length} wall glyphs as a selection board (${tiles} tiles)`);
  check((await monitor.locator('.oc-monitor__wallgrid[data-columns="2"]').count()) === 1, 'monitor wall board uses 2 columns');
  await seeText(pages.wall, 'Waiting for the game master', 'wall panel waits while a wall is being chosen');
  await seeText(admin(), `${teamName(chooser)} chooses`);
  const picker = await pickerGlyphs();
  check(same(picker.enabled, expectedGlyphs.map((g) => LABELS[g])) && picker.used.length === 0, `admin picker offers ${picker.enabled.join(', ')}`);
  await shot('r3-start');
  return chooser;
}

/** After `wall:clear`: the wall is off screen, the other team chooses, the used glyphs are dark. */
async function clearWallAndCheck(doneSoFar, total, usedGlyphs, nextTeam) {
  const state = await action('Clear wall', (s) => s.wall.current === null && s.wall.wallsDone === doneSoFar, `wall ${doneSoFar} cleared`);
  check(state.wall.stage === 'selecting' && state.wall.team === nextTeam && same(state.wall.used, usedGlyphs), `after clear: selecting, ${teamName(nextTeam)} to choose, used ${JSON.stringify(state.wall.used)}`);
  const over = doneSoFar >= total;
  if (over) {
    check((state.finishedRounds ?? []).includes('wall'), 'wall round finished after the last wall');
    await seeText(pages.monitor, 'All walls played');
    await seeText(admin(), 'all walls played');
    const picker = await pickerGlyphs();
    check(picker.enabled.length === 0 && picker.used.length === total, `admin picker: every glyph used (${picker.used.join(', ')}), none enabled`);
  } else {
    await seeText(pages.monitor, `${teamName(nextTeam)} to choose a wall`);
    await seeText(pages.monitor, `Wall ${doneSoFar + 1} of ${total}`);
    const picker = await pickerGlyphs();
    const usedInGridOrder = HIEROGLYPHS.filter((h) => usedGlyphs.includes(h)).map((g) => LABELS[g]);
    check(same(picker.used, usedInGridOrder), `admin picker marks ${picker.used.join(', ')} as used (grid order)`);
    const monitorUsed = await pages.monitor.locator('.oc-monitor__wallgrid > [aria-label$="(used)"]').count();
    check(monitorUsed === usedGlyphs.length, `monitor shows ${monitorUsed} dark (used) wall glyph(s)`);
  }
  await seeText(pages.wall, 'Waiting for the game master', 'wall panel back to waiting');
  return state;
}

async function restartApi() {
  if (RESTART_MODE === 'skip') {
    log('restart test skipped (RESTART_MODE=skip)');
    return false;
  }
  const req = path.join(OUT, 'restart.request');
  const done = path.join(OUT, 'restart.done');
  fs.rmSync(done, { force: true });
  fs.writeFileSync(req, String(Date.now()));
  log('asked the host runner to restart the api container…');
  const start = Date.now();
  while (!fs.existsSync(done)) {
    if (Date.now() - start > 90_000) {
      check(false, 'host runner restarted the api (no restart.done within 90 s — run via scripts/e2e/run.sh)');
      fs.rmSync(req, { force: true });
      return false;
    }
    await sleep(500);
  }
  fs.rmSync(done, { force: true });
  log('api restarted by the host runner');
  return true;
}

// ===========================================================================
// Scenario "demo": the seeded Demo pack
// ===========================================================================

async function demoScenario() {
  const mediaRequests = await openScreens();
  const monitor = pages.monitor;
  const wall = pages.wall;
  const buttonPink = pages.buttonPink;
  const buttonBlue = pages.buttonBlue;
  const adminPage = pages.admin;

  // -------------------------------------------------------------------------
  // 1. New game
  // -------------------------------------------------------------------------
  let state = await newGame('Demo pack');
  const gameId = state?.id;
  const { mia } = await joinPhones();
  await showCues('lobby');

  // -------------------------------------------------------------------------
  // 2. Round 1 — Connections
  // -------------------------------------------------------------------------

  state = await action(/^1\. Connections/, (s) => s.phase === 'connections' && s.question?.stage === 'selecting' && s.question.team === 'pink', 'Connections started, pink to pick', { exact: false });
  check(same(state.question.available, HIEROGLYPHS.slice(0, 6)) && state.question.questionsTotal === 6, 'demo Connections: the six show glyphs, 6 questions');
  await seeText(monitor, `${PINK} to choose`);
  await seeText(monitor, 'Question 1 of 6');
  check((await monitor.locator('.oc-glyphgrid[data-columns="3"]').count()) === 1, 'monitor question board uses 3 columns for six glyphs');
  await shot('r1-select');

  const reveal = (n, label) => action('Reveal next clue', (s) => s.question?.revealed === n, `${label}: ${n} clues shown`);

  // Q1 pink — Two Reeds, 3 clues, correct for 2 (the 40 s clock starts on the pick)
  await pickHieroglyph('Two Reeds');
  await expectQuestionClock('Q1');
  await seeText(monitor, 'A whip');
  await seeText(monitor, '5 Points');
  await shot('r1-q1-clue1');
  await reveal(2, 'Q1');
  await reveal(3, 'Q1');
  await seeText(monitor, 'A joke');
  await seeText(monitor, '2 Points');
  await shot('r1-q1-clue3');
  exp.pink += 2;
  state = await action('Correct', (s) => s.question?.stage === 'answer', 'Q1 correct');
  check(state.question.startedAt === null && state.question.endsAt === null && state.question.timeUp === false, 'Q1: the clock is cleared by the judgement');
  await expectScores('Q1');
  await seeText(monitor, 'Things you can crack');
  await seeText(monitor, 'An egg');
  await shot('r1-q1-answer');
  await action('Next question', (s) => s.question?.stage === 'selecting' && s.question.team === 'blue', 'Q1 next, blue to pick');
  await seeText(monitor, `${BLUE} to choose`);

  // Q2 blue — Lion, 1 clue, correct for 5
  await pickHieroglyph('Lion');
  await seeText(monitor, 'Dash');
  exp.blue += 5;
  await action('Correct', (s) => s.question?.stage === 'answer', 'Q2 correct');
  await expectScores('Q2');
  await seeText(monitor, 'Words before');
  await shot('r1-q2-answer');
  await action('Next question', (s) => s.question?.stage === 'selecting' && s.question.team === 'pink', 'Q2 next');

  // Q3 pink — Twisted Flax (images), 4 clues, incorrect, blue steals correctly; the latest picture is shown big
  await pickHieroglyph('Twisted Flax');
  await expectBigPicture('Q3 clue 1');
  await shot('r1-q3-bigpicture');
  await reveal(2, 'Q3');
  await reveal(3, 'Q3');
  await reveal(4, 'Q3');
  await seeText(monitor, '1 Point');
  check((await monitor.locator('.oc-cluerow img[src*="/api/media/demo/flag-"]').count()) >= 4, 'monitor shows the 4 flag images in the clue row');
  await expectBigPicture('Q3 clue 4');
  await shot('r1-q3-images');
  await action('Incorrect / pass', (s) => s.question?.stage === 'steal', 'Q3 incorrect -> steal');
  await seeText(monitor, `${BLUE} to steal`);
  await expectBigPicture('Q3 steal');
  await shot('r1-q3-steal');
  exp.blue += 1;
  await action('Steal correct', (s) => s.question?.stage === 'answer' && s.question.result?.viaSteal === true, 'Q3 steal correct');
  await expectScores('Q3');
  await seeText(monitor, 'Flags with a single disc');
  await seeText(monitor, 'Flag of Japan');
  await expectNoBigPicture('Q3 answer');
  await shot('r1-q3-answer');
  await action('Next question', (s) => s.question?.stage === 'selecting', 'Q3 next');

  // Q4 blue — Horned Viper (audio): the monitor must request the clips; media:play re-requests
  const mediaBefore = mediaRequests.length;
  await pickHieroglyph('Horned Viper');
  state = await waitState((s) => s.playMedia?.key === 'demo/william-tell.wav', 'playMedia = william-tell');
  await sleep(1200);
  const tell = () => mediaRequests.filter((r) => r.url.includes('william-tell.wav')).length;
  const plays = (fragment) => monitor.evaluate((f) => window.__ocPlays.filter((p) => p.src.includes(f)).length, fragment);
  check(tell() >= 1, `monitor requested william-tell.wav after reveal (${tell()} request(s), ${mediaRequests.length - mediaBefore} media requests)`);
  check((await plays('william-tell.wav')) >= 1, 'monitor called play() on william-tell.wav');
  check((await monitor.locator('.oc-clue__icon[aria-label="audio clue"], .oc-clue__icon').count()) >= 1, 'monitor shows the gramophone tile');
  await shot('r1-q4-audio');
  const playsBefore = await plays('william-tell.wav');
  const nonceBefore = state.playMedia.nonce;
  await action(/^Play audio again/, (s) => s.playMedia?.nonce > nonceBefore, 'media:play bumps the nonce');
  await sleep(1200);
  check((await plays('william-tell.wav')) > playsBefore, `media:play replayed william-tell.wav (${await plays('william-tell.wav')} play() calls; ${tell()} network request(s), the replay may come from cache)`);
  await reveal(2, 'Q4');
  await waitState((s) => s.playMedia?.key === 'demo/bumblebee.wav', 'playMedia = bumblebee');
  await sleep(800);
  check(mediaRequests.some((r) => r.url.includes('bumblebee.wav')), 'monitor requested bumblebee.wav');
  await action('Stop audio', (s) => s.playMedia === null, 'media:stop');
  await action('Incorrect / pass', (s) => s.question?.stage === 'steal', 'Q4 incorrect');
  await action('Steal incorrect', (s) => s.question?.stage === 'answer' && s.question.result?.winner === null, 'Q4 steal incorrect');
  await expectScores('Q4');
  await seeText(monitor, 'Music from operas');
  await seeText(monitor, 'Habanera');
  await shot('r1-q4-answer');
  await action('Next question', (s) => s.question?.stage === 'selecting', 'Q4 next');

  // Q5 pink — Water, 2 clues, the host calls time early, correct for the 3 points still on offer
  await pickHieroglyph('Water');
  await reveal(2, 'Q5');
  await seeText(monitor, '3 Points');
  await questionTimeUpEarly('Q5');
  await shot('r1-q5-timeup');
  exp.pink += 3;
  state = await action('Correct', (s) => s.question?.stage === 'answer', 'Q5 correct after time up');
  check(state.question.result?.points === 3 && state.question.timeUp === false, 'Q5: 3 points awarded after time up, clock fields reset');
  await expectScores('Q5');
  await action('Next question', (s) => s.question?.stage === 'selecting', 'Q5 next');

  // Q6 blue — Eye of Horus, 4 clues, incorrect, pink steals
  await seeText(monitor, 'Question 6 of 6');
  await pickHieroglyph('Eye of Horus');
  await reveal(2, 'Q6');
  await reveal(3, 'Q6');
  await reveal(4, 'Q6');
  await action('Incorrect / pass', (s) => s.question?.stage === 'steal', 'Q6 incorrect');
  exp.pink += 1;
  await action('Steal correct', (s) => s.question?.stage === 'answer', 'Q6 steal correct');
  await expectScores('Q6');
  await seeText(monitor, 'Cape');
  await shot('r1-q6-answer');
  await action('Next question', (s) => s.question?.questionsDone === 6 && (s.finishedRounds ?? []).includes('connections'), 'Connections finished (6 questions)');
  await seeText(monitor, String(exp.pink));
  await shot('r1-done');

  // -------------------------------------------------------------------------
  // 3. Round 2 — Sequences (blue picks first)
  // -------------------------------------------------------------------------

  await action(/^2\. Sequences/, (s) => s.phase === 'sequences' && s.question?.team === 'blue', 'Sequences started, blue to pick', { exact: false });
  await seeText(monitor, `${BLUE} to choose`);

  await pickHieroglyph('Two Reeds'); // blue: Mercury, Venus, Earth, ?
  await reveal(2, 'S1');
  await reveal(3, 'S1');
  check(await admin().getByRole('button', { name: 'Reveal next clue' }).isDisabled(), 'sequences: 4th clue cannot be revealed');
  await seeText(monitor, 'Earth');
  await seeText(monitor, '?');
  await shot('r2-s1-clue3');
  exp.blue += 2;
  await action('Correct', (s) => s.question?.stage === 'answer', 'S1 correct');
  await expectScores('S1');
  await seeText(monitor, 'Mars');
  await shot('r2-s1-answer');
  await action('Next question', (s) => s.question?.stage === 'selecting' && s.question.team === 'pink', 'S1 next');

  await pickHieroglyph('Lion'); // pink: anniversaries, 5 points
  exp.pink += 5;
  await action('Correct', (s) => s.question?.stage === 'answer', 'S2 correct');
  await expectScores('S2');
  await action('Next question', (s) => s.question?.stage === 'selecting', 'S2 next');

  await pickHieroglyph('Twisted Flax'); // blue: moon phases (images), incorrect, pink steals
  await reveal(2, 'S3');
  await expectBigPicture('S3 clue 2');
  await shot('r2-s3-images');
  await action('Incorrect / pass', (s) => s.question?.stage === 'steal', 'S3 incorrect');
  await seeText(monitor, `${PINK} to steal`);
  exp.pink += 1;
  await action('Steal correct', (s) => s.question?.stage === 'answer', 'S3 steal correct');
  await expectScores('S3');
  await seeText(monitor, 'Waxing gibbous');
  await shot('r2-s3-answer');
  await action('Next question', (s) => s.question?.stage === 'selecting', 'S3 next');

  await pickHieroglyph('Horned Viper'); // pink: prime ministers, 2 clues
  await reveal(2, 'S4');
  exp.pink += 3;
  await action('Correct', (s) => s.question?.stage === 'answer', 'S4 correct');
  await expectScores('S4');
  await action('Next question', (s) => s.question?.stage === 'selecting', 'S4 next');

  await pickHieroglyph('Water'); // blue: elements, incorrect, steal incorrect
  await reveal(2, 'S5');
  await reveal(3, 'S5');
  await action('Incorrect / pass', (s) => s.question?.stage === 'steal', 'S5 incorrect');
  await action('Steal incorrect', (s) => s.question?.stage === 'answer', 'S5 steal incorrect');
  await expectScores('S5');
  await seeText(monitor, 'Beryllium');
  await action('Next question', (s) => s.question?.stage === 'selecting', 'S5 next');

  await pickHieroglyph('Eye of Horus'); // pink: solfège (audio)
  await waitState((s) => s.playMedia?.key === 'demo/solfege-do.wav', 'playMedia = solfege-do');
  await reveal(2, 'S6');
  await reveal(3, 'S6');
  await sleep(800);
  check(mediaRequests.some((r) => r.url.includes('solfege-mi.wav')), 'monitor requested solfege-mi.wav');
  await shot('r2-s6-audio');
  exp.pink += 2;
  await action('Correct', (s) => s.question?.stage === 'answer', 'S6 correct');
  await expectScores('S6');
  await seeText(monitor, 'Fa (the solf');
  await shot('r2-s6-answer');
  await action('Next question', (s) => (s.finishedRounds ?? []).includes('sequences'), 'Sequences finished');

  // -------------------------------------------------------------------------
  // 4. Round 3 — Connecting Wall: two walls (Lion, Water) chosen by hieroglyph; the team behind chooses first
  // -------------------------------------------------------------------------

  const first = await startWallRound('pink', ['lion', 'water']); // blue (8) is behind pink (17)
  const second = other(first);

  // --- Wall 1: the chooser picks Lion, finds 2 groups, then runs out of lives
  state = await chooseWall('lion', first);
  check(state.wall.wallsDone === 0 && state.wall.wallsTotal === 2 && wallDef(state).hieroglyph === 'lion', 'the Lion wall is on screen, wall 1 of 2');
  await seeText(wall, teamName(first));
  await seeText(monitor, 'Wall 1 of 2');
  await seeText(admin(), 'Lion wall');
  await shot('r3-wall1-ready');
  await startWall(1);
  await shot('r3-wall1-live');
  await tapTile(groupIds(await adminState(), 0)[0]);
  await shot('r3-wall1-selected1');
  // deselect it again
  await tapTile(groupIds(await adminState(), 0)[0]);
  await waitState((s) => s.wall.current.selected.length === 0, 'tile deselected');
  await solveGroup(0);
  await expectRowAnimation(0, 0);
  await shot('r3-wall1-group1');
  await solveGroup(1);
  await expectRowAnimation(1, 1);
  state = await waitState((s) => s.wall.current.lives === 3, 'lives = 3 after the 2nd group');
  await shot('r3-wall1-group2');
  await wrongGuess();
  await shot('r3-wall1-wrong');
  await waitState((s) => s.wall.current.lives === 2, 'lives = 2');
  await wrongGuess();
  await waitState((s) => s.wall.current.lives === 1, 'lives = 1');
  state = await wrongGuess();
  state = await waitState((s) => s.wall.current.stage === 'frozen' && s.wall.current.endReason === 'lives' && s.wall.current.lives === 0, 'wall 1 frozen: out of lives');
  check(typeof state.wall.current.endedAt === 'number', 'endedAt recorded on the frozen wall');
  await seeText(wall, 'No lives left');
  await seeText(monitor, 'No lives left');
  await shot('r3-wall1-frozen');
  // taps are rejected now
  await wall.locator(`[data-tile-id="${groupIds(state, unsolvedGroups(state)[0])[0]}"]`).click({ timeout: 3_000, force: true }).catch(() => {});
  await sleep(400);
  check((await adminState()).wall.current.selected.length === 0, 'taps on a frozen wall are ignored');

  await action('Resolve wall', (s) => s.wall.current?.stage === 'resolving' && s.wall.current.resolvingGroup === 0, 'wall 1 resolving');
  check((await adminState()).wall.current.groups.every((g) => g.solvedOrder !== null), 'all 4 groups revealed on resolve');
  await seeText(monitor, 'Connection?');
  await shot('r3-wall1-resolving');
  await action('Connection correct', (s) => s.wall.current?.resolvingGroup === 1, 'connection 1 correct');
  await action('Connection incorrect', (s) => s.wall.current?.resolvingGroup === 2, 'connection 2 incorrect');
  await shot('r3-wall1-connections');
  await action('Connection correct', (s) => s.wall.current?.resolvingGroup === 3, 'connection 3 correct');
  await action('Connection correct', (s) => s.wall.current?.resolvingGroup === null, 'connection 4 correct');
  exp[first] += 2 + 3;
  state = await action('Finish wall (award points)', (s) => s.wall.current?.stage === 'done', 'wall 1 finished');
  check(state.wall.current.awarded?.total === 5 && state.wall.current.awarded.groups === 2 && state.wall.current.awarded.connections === 3, `wall 1 awarded ${JSON.stringify(state.wall.current.awarded)}`);
  check(!(state.finishedRounds ?? []).includes('wall') && same(state.wall.used, ['lion']), 'round not finished yet after wall 1 (used: lion)');
  await expectScores('wall 1');
  await seeText(monitor, 'Groups 2');
  await seeText(wall, wallDef(state).groups[0].connection);
  await shot('r3-wall1-done');
  await clearWallAndCheck(1, 2, ['lion'], second);
  await shot('r3-wall2-select');

  // --- Wall 2: the other team gets the last glyph (Water): 1 group, a wrong guess without lives, the host calls time
  const picker = await pickerGlyphs();
  check(same(picker.enabled, ['Water']), 'only Water is left to choose');
  state = await chooseWall('water', second);
  check(wallDef(state).hieroglyph === 'water' && same(state.wall.used, ['lion', 'water']), 'the Water wall is on screen, both glyphs used');
  await seeText(monitor, 'Wall 2 of 2');
  await startWall(2);
  await solveGroup(2);
  await expectRowAnimation(2, 0);
  state = await wrongGuess();
  check(state.wall.current.lives === null && state.wall.current.stage === 'live', 'a wrong guess before 2 groups costs no life');
  await shot('r3-wall2-wrong');
  // "Time up" asks for a confirmation first (a mis-click would otherwise end the wall for good); the confirm
  // button carries the same label and is the only enabled one once the inline prompt is up.
  await clickAdmin('Time up');
  await admin().locator('.adm-confirm').waitFor({ timeout: 5_000 });
  check(true, 'Time up asks for a confirmation');
  state = await action('Time up', (s) => s.wall.current?.stage === 'frozen' && s.wall.current.endReason === 'time', 'wall 2: time up');
  await seeText(wall, "Time's up");
  await seeText(monitor, "Time's up");
  await shot('r3-wall2-timeup');
  await action('Resolve wall', (s) => s.wall.current?.stage === 'resolving', 'wall 2 resolving');
  for (let i = 0; i < 4; i++) {
    await action('Connection correct', (s) => s.wall.current?.resolvingGroup === (i < 3 ? i + 1 : null), `wall 2 connection ${i + 1} correct`);
  }
  exp[second] += 1 + 4;
  state = await action('Finish wall (award points)', (s) => s.wall.current?.stage === 'done', 'wall 2 finished');
  check(state.wall.current.awarded?.total === 5, `wall 2 awarded ${JSON.stringify(state.wall.current.awarded)}`);
  check((state.finishedRounds ?? []).includes('wall'), 'wall round finished after both walls');
  await expectScores('wall 2');
  await shot('r3-wall2-done');
  await clearWallAndCheck(2, 2, ['lion', 'water'], first);
  await shot('r3-all-played');

  // -------------------------------------------------------------------------
  // 5. Round 4 — Missing Vowels
  // -------------------------------------------------------------------------

  await action(/^4\. Missing Vowels/, (s) => s.phase === 'vowels' && s.vowels?.stage === 'category', 'Missing Vowels started', { exact: false });
  await seeText(monitor, 'Capital cities');
  await seeText(buttonPink, 'Waiting for the next clue');
  await shot('r4-category');

  // clue 1: Mia buzzes first, correct
  state = await action('Show clue', (s) => s.vowels?.stage === 'clue', 'clue 1 shown, buzzers open');
  await seeText(buttonPink, 'Buzzers are open');
  check(await buzzer(buttonPink).isEnabled(), 'pink buzzer enabled');
  const display1 = state.pack.vowelGroups[0].clues[0].display; // "PARIS" without its vowels
  await seeText(monitor, display1, `vowel-stripped clue "${display1}"`);
  await seeText(buttonPink, display1, `vowel-stripped clue "${display1}" on the phone`);
  await shot('r4-clue1');
  await buzzFrom(buttonPink, 'Mia');
  await seeText(buttonPink, 'You buzzed first!');
  await seeText(buttonBlue, 'Mia buzzed first');
  await seeText(monitor, 'Mia');
  check(await buzzer(buttonBlue).isDisabled(), 'blue buzzer locked after Mia buzzed');
  await shot('r4-clue1-buzzed');
  exp.pink += 1;
  await action('Correct', (s) => s.vowels?.stage === 'answer', 'clue 1 correct');
  await expectScores('vowels clue 1');
  await seeText(monitor, 'PARIS');
  await seeText(buttonPink, 'Correct!');
  await shot('r4-clue1-answer');

  // clue 2: Jason buzzes, wrong (-1), pink answers (+1)
  await action('Next clue', (s) => s.vowels?.stage === 'clue' && s.vowels.clueIndex === 1, 'clue 2');
  await buzzFrom(buttonBlue, 'Jason');
  await seeText(buttonBlue, 'You buzzed first!');
  exp.blue -= 1;
  await action('Incorrect', (s) => s.vowels?.stage === 'other', 'clue 2 incorrect -> other team');
  await expectScores('vowels clue 2 incorrect');
  await seeText(buttonPink, 'Your team may answer');
  await monitor.locator('.oc-buzz', { hasText: PINK }).filter({ hasText: 'to answer' }).first().waitFor({ timeout: 8_000 }).then(
    () => check(true, `monitor banner "${PINK} · to answer"`),
    () => check(false, `monitor banner "${PINK} · to answer"`),
  );
  await shot('r4-clue2-other');
  exp.pink += 1;
  await action('Other team correct', (s) => s.vowels?.stage === 'answer', 'clue 2 other team correct');
  await expectScores('vowels clue 2');
  await seeText(monitor, 'BUENOS AIRES');

  // clue 3: Mia buzzes, reopened (locked out), Jason buzzes, wrong, nobody
  await action('Next clue', (s) => s.vowels?.stage === 'clue' && s.vowels.clueIndex === 2, 'clue 3');
  await buzzFrom(buttonPink, 'Mia');
  await action('Reopen buzzers', (s) => s.vowels?.stage === 'clue' && s.vowels.lockedPlayers.includes(mia.id), 'reopened, Mia locked out');
  await seeText(buttonPink, 'You already buzzed on this clue');
  check(await buzzer(buttonPink).isDisabled(), 'locked-out player cannot buzz');
  check(await buzzer(buttonBlue).isEnabled(), 'other player can buzz after reopen');
  await shot('r4-clue3-reopened');
  await buzzFrom(buttonBlue, 'Jason');
  exp.blue -= 1;
  await action('Incorrect', (s) => s.vowels?.stage === 'other', 'clue 3 incorrect');
  await action('Nobody', (s) => s.vowels?.stage === 'answer' && s.vowels.result?.team === null, 'clue 3 nobody');
  await expectScores('vowels clue 3');
  await seeText(buttonBlue, 'Wrong');

  // clue 4: nobody buzzes
  await action('Next clue', (s) => s.vowels?.stage === 'clue' && s.vowels.clueIndex === 3, 'clue 4');
  await action('Nobody', (s) => s.vowels?.stage === 'answer', 'clue 4 nobody buzzed');
  await seeText(monitor, 'KUALA LUMPUR');
  await shot('r4-clue4-answer');

  // -------------------------------------------------------------------------
  // 6. API restart mid-game: everything must come back by itself
  // -------------------------------------------------------------------------

  const versionBeforeRestart = (await adminState()).version;
  restartWindow = { from: Date.now(), to: null };
  if (await restartApi()) {
    // The monitor shows a "reconnecting" pill while the socket is down, then recovers the same game.
    const pill = monitor.locator('.oc-monitor-screen__pill');
    await pill.waitFor({ state: 'detached', timeout: 30_000 }).then(
      () => check(true, 'monitor socket reconnected (pill gone)'),
      () => check(false, 'monitor socket reconnected (pill gone)'),
    );
    await adminPage.locator('.adm-conn.is-on').waitFor({ timeout: 30_000 }).then(
      () => check(true, 'admin socket reconnected'),
      () => check(false, 'admin socket reconnected'),
    );
    state = await waitState((s) => s.id === gameId && s.version >= versionBeforeRestart && s.phase === 'vowels', 'same game reloaded from the database after restart', 30_000);
    state = await waitState((s) => s.players.length === 2 && s.players.every((p) => p.connected), 'both phones rejoined after restart', 30_000);
    await seeText(monitor, 'KUALA LUMPUR', 'KUALA LUMPUR (state restored on monitor)');
    await seeText(buttonPink, 'Mia', 'Mia (pink phone still joined)');
    restartWindow.to = Date.now();
    await shot('restart-recovered');
  } else {
    restartWindow = null;
  }

  // -------------------------------------------------------------------------
  // 7. Second category, skip the third, final scores
  // -------------------------------------------------------------------------

  await action('Next clue', (s) => s.vowels?.stage === 'category' && s.vowels.groupIndex === 1, 'category 2');
  await seeText(monitor, 'Breakfast cereals');
  await action('Show clue', (s) => s.vowels?.stage === 'clue', 'category 2 clue 1');
  await buzzFrom(buttonBlue, 'Jason');
  exp.blue += 1;
  await action('Correct', (s) => s.vowels?.stage === 'answer', 'category 2 clue 1 correct');
  await expectScores('vowels cat 2');
  await seeText(buttonBlue, 'Correct!');
  await shot('r4-cat2-answer');
  await action('Skip category', (s) => s.vowels?.groupIndex === 2 && s.vowels.stage === 'category', 'skipped to category 3');
  await seeText(monitor, 'Rivers of Europe');
  await action('Show clue', (s) => s.vowels?.stage === 'clue', 'category 3 clue 1');
  await buzzFrom(buttonPink, 'Mia');
  exp.pink += 1;
  await action('Correct', (s) => s.vowels?.stage === 'answer', 'category 3 clue 1 correct');
  await expectScores('vowels cat 3');

  // Score correction from the admin (+1 then -1 on blue, then +5 / -5)
  const blueBefore = exp.blue;
  await adminPage.getByRole('button', { name: `${BLUE} plus one` }).click();
  await waitState((s) => s.teams.blue.score === blueBefore + 1, 'score +1 from the status bar');
  await adminPage.getByRole('button', { name: `${BLUE} minus one` }).click();
  await waitState((s) => s.teams.blue.score === blueBefore, 'score -1 from the status bar');
  await adminPage.getByRole('button', { name: `${BLUE} plus five` }).click();
  await waitState((s) => s.teams.blue.score === blueBefore + 5, 'score +5 from the status bar');
  await adminPage.getByRole('button', { name: `${BLUE} minus five` }).click();
  await waitState((s) => s.teams.blue.score === blueBefore, 'score -5 from the status bar');

  // Undo: the last admin action (the -5) is reverted by the Undo button, then redone by hand.
  state = await adminState();
  check(state.undoable === 'game:adjustScore', `admin state reports undoable = ${state.undoable}`);
  await action(/^Undo/, (s) => s.teams.blue.score === blueBefore + 5, 'Undo reverted the score adjustment', { exact: false });
  await adminPage.getByRole('button', { name: `${BLUE} minus five` }).click();
  await waitState((s) => s.teams.blue.score === blueBefore, 'score back to expected after the undo test');

  // A socket that never joined cannot buzz, leave or take over somebody else's player: identity is bound to
  // the socket on the server and an existing id needs the secret only its own phone holds.
  try {
    const { io } = await import('socket.io-client');
    const spoof = io(BASE, { path: '/socket.io', transports: ['websocket'], reconnection: false });
    const emit = (event, payload) =>
      new Promise((resolve) => spoof.timeout(5000).emit(event, payload, (err, res) => resolve(err ? { ok: false, error: String(err) } : res)));
    await new Promise((resolve, reject) => {
      spoof.once('connect', resolve);
      spoof.once('connect_error', reject);
    });
    const buzz = await emit('player:buzz', { playerId: mia.id });
    check(buzz.ok === false && buzz.code === 'not_joined', `un-joined socket cannot buzz as Mia (${JSON.stringify(buzz)})`);
    const leave = await emit('player:leave', { playerId: mia.id });
    check(leave.ok === false && leave.code === 'not_joined', `un-joined socket cannot remove Mia (${JSON.stringify(leave)})`);
    const hijack = await emit('player:join', { playerId: mia.id, name: 'HIJACKED', team: 'blue' });
    check(hijack.ok === false && hijack.code === 'not_owner', `joining as Mia without her secret is refused (${JSON.stringify(hijack)})`);
    state = await adminState();
    check(state.players.find((p) => p.id === mia.id)?.name === 'Mia' && state.players.length === 2, 'Mia is untouched by the spoof attempts');
    spoof.disconnect();
  } catch (err) {
    check(false, `spoof checks ran (${err.message})`);
  }

  await finalScores(mediaRequests);
}

async function finalScores(mediaRequests) {
  const state = await action(/^Final scores/, (s) => s.phase === 'final', 'Final', { exact: false });
  await seeText(pages.monitor, 'Final scores');
  const winner = exp.pink > exp.blue ? PINK : exp.blue > exp.pink ? BLUE : null;
  await seeText(pages.monitor, winner ? `${winner} win!` : "It's a draw!");
  check(state.teams.pink.score === exp.pink && state.teams.blue.score === exp.blue, `final scores ${PINK} ${state.teams.pink.score} – ${BLUE} ${state.teams.blue.score}`);
  await seeText(pages.buttonPink, 'Final scores are up');
  await shot('final');
  log(`media requests from the monitor: ${mediaRequests.length} (${[...new Set(mediaRequests.map((r) => r.url.split('/api/media/')[1]))].join(', ')})`);
}

// ===========================================================================
// Scenario "big": 12 + 12 questions, 4 walls, created through the admin API
// ===========================================================================

const BIG_PACK_NAME = 'E2E big pack';
const BIG_WALL_GLYPHS = ['sun', 'lion', 'ankh', 'water']; // pack order; the grid shows them in HIEROGLYPHS order

function bigPackBody() {
  const questions = [];
  for (const round of ['connections', 'sequences']) {
    HIEROGLYPHS.forEach((h, i) => {
      const tag = round === 'connections' ? 'C' : 'S';
      questions.push({
        round,
        hieroglyph: h,
        position: i,
        clues: [1, 2, 3, 4].map((n) => ({ kind: 'text', text: `${tag}${i + 1} clue ${n}` })),
        answer: `${round === 'connections' ? 'Connection' : 'Sequence'} ${i + 1} (${LABELS[h]})`,
        note: `host note ${tag}${i + 1}`,
      });
    });
  }
  const walls = BIG_WALL_GLYPHS.map((h, wi) => ({
    position: wi,
    hieroglyph: h,
    groups: [0, 1, 2, 3].map((g) => ({
      connection: `${LABELS[h]} wall group ${g + 1}`,
      clues: [1, 2, 3, 4].map((n) => `${LABELS[h].slice(0, 3).toUpperCase()}${g + 1}-${n}`),
    })),
  }));
  const vowelGroups = [
    {
      position: 0,
      category: 'Capital cities',
      clues: [
        { answer: 'PARIS', display: 'PRS' },
        { answer: 'LIMA', display: 'LM' },
      ],
    },
  ];
  return { name: BIG_PACK_NAME, questions, walls, vowelGroups };
}

async function bigScenario() {
  // -------------------------------------------------------------------------
  // 0. The pack, through the admin API (a previous run's copy is replaced) — before the admin page loads its
  //    pack list, so the New game select offers the fresh copy
  // -------------------------------------------------------------------------
  await login();
  for (const p of await api('GET', '/admin/packs')) {
    if (p.name === BIG_PACK_NAME) await api('DELETE', `/admin/packs/${p.id}`);
  }
  const created = await api('POST', '/admin/packs', { name: BIG_PACK_NAME });
  const saved = await api('PUT', `/admin/packs/${created.id}`, bigPackBody());
  check(saved.questions.length === 24 && saved.walls.length === 4 && saved.vowelGroups.length === 1, `pack saved: ${saved.questions.length} questions, ${saved.walls.length} walls, ${saved.vowelGroups.length} vowel category`);
  check(same(saved.walls.map((w) => w.hieroglyph), BIG_WALL_GLYPHS), `walls keep their glyphs ${saved.walls.map((w) => w.hieroglyph).join(', ')}`);
  const summary = (await api('GET', '/admin/packs')).find((p) => p.id === created.id);
  check(summary?.playable === true, `pack is playable (problems: ${JSON.stringify(summary?.problems)})`);
  // The hard caps: a 13th question in a round and a 5th wall are refused.
  const tooMany = bigPackBody();
  tooMany.questions.push({ ...tooMany.questions[0], position: 12 });
  await api('PUT', `/admin/packs/${created.id}`, tooMany).then(
    () => check(false, 'a 13th connections question is refused with 400'),
    (err) => check(/400/.test(err.message), `a 13th connections question is refused (${err.message.slice(0, 80)})`),
  );
  const fiveWalls = bigPackBody();
  fiveWalls.walls.push({ ...fiveWalls.walls[0], position: 4, hieroglyph: 'owl' });
  await api('PUT', `/admin/packs/${created.id}`, fiveWalls).then(
    () => check(false, 'a 5th wall is refused with 400'),
    (err) => check(/400/.test(err.message), `a 5th wall is refused (${err.message.slice(0, 80)})`),
  );

  const mediaRequests = await openScreens();
  const monitor = pages.monitor;
  const wall = pages.wall;

  // -------------------------------------------------------------------------
  // 1. New game + phones
  // -------------------------------------------------------------------------
  let state = await newGame(BIG_PACK_NAME);
  await joinPhones();
  await showCues('lobby');

  // -------------------------------------------------------------------------
  // 2. Round 1 — Connections: 12 picks through the admin picker, teams alternate pink, blue, pink…
  // -------------------------------------------------------------------------
  state = await action(/^1\. Connections/, (s) => s.phase === 'connections' && s.question?.stage === 'selecting' && s.question.team === 'pink', 'Connections started, pink to pick', { exact: false });
  check(same(state.question.available, HIEROGLYPHS) && state.question.questionsTotal === 12, 'Connections grid: all 12 hieroglyphs, 12 questions');
  await seeText(monitor, `${PINK} to choose`);
  await seeText(monitor, 'Question 1 of 12');
  check((await monitor.locator('.oc-glyphgrid[data-columns="4"]').count()) === 1, 'monitor question board uses 4 columns for twelve glyphs');
  check((await monitor.locator('.oc-glyphgrid[data-columns="4"] > [aria-label]').count()) === 12, 'monitor question board shows 12 tiles');
  check((await admin().locator('.adm-glyphpick:not(.adm-glyphpick--walls) [role="button"]').count()) === 12, 'admin picker offers 12 glyphs');
  await shot('r1-select-12');

  let alternationOk = true;
  for (let i = 0; i < 12; i++) {
    const team = i % 2 === 0 ? 'pink' : 'blue';
    const glyph = HIEROGLYPHS[i];
    const s0 = await waitState((s) => s.question?.stage === 'selecting' && s.question.questionsDone === i, `question ${i + 1}: selecting`);
    if (s0.question.team !== team) alternationOk = false;
    check(s0.question.team === team, `question ${i + 1}: ${teamName(team)} to pick`);
    check(s0.question.used.length === i && !s0.question.used.includes(glyph), `question ${i + 1}: ${i} glyph(s) used, ${LABELS[glyph]} still free`);
    if (i === 11) {
      await seeText(monitor, 'Question 12 of 12');
      check((await monitor.locator('.oc-glyphgrid > [aria-label$="(used)"]').count()) === 11, 'monitor shows 11 dark (used) glyphs before the last pick');
      await shot('r1-q12-select');
    }
    state = await pickHieroglyph(LABELS[glyph]);
    check(state.question.hieroglyph === glyph || state.question.questionId !== null, `question ${i + 1}: ${LABELS[glyph]} picked`);
    await seeText(monitor, `C${i + 1} clue 1`);
    if (i === 0) await expectQuestionClock('Q1');
    if (i === 3) {
      // once per scenario: the host calls time early, then judges as usual
      await questionTimeUpEarly('Q4');
      await shot('r1-q4-timeup');
    }
    if (i === 6) await shot('r1-q7-clue1');
    if (i === 11) {
      // blue's last question: wrong, then the steal fails too (so blue ends up behind and chooses the first wall)
      await action('Reveal next clue', (s) => s.question?.revealed === 2, 'Q12: 2 clues shown');
      await action('Incorrect / pass', (s) => s.question?.stage === 'steal', 'Q12 incorrect -> steal');
      await seeText(monitor, `${PINK} to steal`);
      await action('Steal incorrect', (s) => s.question?.stage === 'answer' && s.question.result?.winner === null, 'Q12 steal incorrect');
      await seeText(monitor, `Connection 12 (${LABELS[glyph]})`);
      await shot('r1-q12-answer');
    } else {
      exp[team] += 5;
      await action('Correct', (s) => s.question?.stage === 'answer', `Q${i + 1} correct (5 points)`);
      await seeText(monitor, `Connection ${i + 1} (${LABELS[glyph]})`);
    }
    await expectScores(`Q${i + 1}`);
    const pred = i < 11 ? (s) => s.question?.stage === 'selecting' && s.question.questionsDone === i + 1 : (s) => s.question?.questionsDone === 12 && (s.finishedRounds ?? []).includes('connections');
    await action('Next question', pred, i < 11 ? `Q${i + 1} next` : 'Connections finished (12 questions)');
  }
  check(alternationOk, 'teams alternated pink, blue, pink… over all 12 picks');
  state = await adminState();
  check(same(state.question.used, HIEROGLYPHS), 'all 12 hieroglyphs used after the round');
  await shot('r1-done-12');

  // -------------------------------------------------------------------------
  // 3. Round 2 — Sequences over REST (blue picks first), 12 questions
  // -------------------------------------------------------------------------
  await action(/^2\. Sequences/, (s) => s.phase === 'sequences' && s.question?.team === 'blue' && s.question.questionsTotal === 12, 'Sequences started, blue to pick, 12 questions', { exact: false });
  await seeText(monitor, `${BLUE} to choose`);
  await shot('r2-select-12');
  let seqOk = true;
  for (let i = 0; i < 12; i++) {
    const team = i % 2 === 0 ? 'blue' : 'pink';
    const s0 = await adminState();
    if (s0.question.team !== team || s0.question.stage !== 'selecting') seqOk = false;
    await rest({ type: 'q:select', hieroglyph: HIEROGLYPHS[i] });
    exp[team] += 5;
    await rest({ type: 'q:correct' });
    await rest({ type: 'q:next' });
  }
  check(seqOk, 'Sequences: teams alternated blue, pink… over 12 picks');
  state = await waitState((s) => s.question?.questionsDone === 12 && (s.finishedRounds ?? []).includes('sequences'), 'Sequences finished (12 questions)');
  await expectScores('after Sequences');
  check(exp.blue < exp.pink, `blue (${exp.blue}) is behind pink (${exp.pink}) going into the wall round`);

  // -------------------------------------------------------------------------
  // 4. Round 3 — four walls chosen by hieroglyph: blue, pink, blue, pink
  // -------------------------------------------------------------------------
  const grid = HIEROGLYPHS.filter((h) => BIG_WALL_GLYPHS.includes(h)); // lion, water, ankh, sun
  const t1 = await startWallRound('pink', grid);
  check(t1 === 'blue', 'blue chooses wall 1 (behind on score)');
  const t2 = other(t1);
  const t3 = t1;
  const t4 = t2;

  // --- Wall 1 (blue, Sun): every group found on the /wall page; the solved rows glide to the top
  state = await chooseWall('sun', t1);
  check(wallDef(state).hieroglyph === 'sun' && state.wall.wallsTotal === 4, 'the Sun wall is on screen, 4 walls in the round');
  await seeText(wall, teamName(t1));
  await seeText(monitor, 'Wall 1 of 4');
  await seeText(admin(), 'Sun wall');
  await shot('r3-wall1-ready');
  await startWall(1);
  await solveGroup(3);
  await expectRowAnimation(3, 0);
  await shot('r3-wall1-group1');
  await solveGroup(1);
  await expectRowAnimation(1, 1);
  await waitState((s) => s.wall.current.lives === 3, 'lives = 3 after the 2nd group');
  state = await solveGroup(0);
  state = await waitState((s) => s.wall.current.stage === 'frozen' && s.wall.current.endReason === 'complete', 'third group found: the last one resolves itself, wall complete');
  check(state.wall.current.groups.every((g) => g.foundByTeam), 'all four groups count as found by the team');
  await expectRowAnimation(0, 2);
  await expectRowAnimation(2, 3);
  await shot('r3-wall1-complete');
  await action('Resolve wall', (s) => s.wall.current?.stage === 'resolving', 'wall 1 resolving');
  for (let i = 0; i < 4; i++) {
    await action('Connection correct', (s) => s.wall.current?.resolvingGroup === (i < 3 ? i + 1 : null), `wall 1 connection ${i + 1} correct`);
  }
  exp[t1] += 4 + 4 + 2;
  state = await action('Finish wall (award points)', (s) => s.wall.current?.stage === 'done', 'wall 1 finished');
  check(state.wall.current.awarded?.total === 10 && state.wall.current.awarded.bonus === 2, `wall 1 awarded ${JSON.stringify(state.wall.current.awarded)} (perfect wall)`);
  await expectScores('wall 1');
  await shot('r3-wall1-done');
  await clearWallAndCheck(1, 4, ['sun'], t2);
  await shot('r3-wall2-select');

  // --- Wall 2 (pink, Lion): 2 groups then out of lives
  state = await chooseWall('lion', t2);
  await seeText(monitor, 'Wall 2 of 4');
  await startWall(2);
  await solveGroup(2);
  await expectRowAnimation(2, 0);
  await solveGroup(3);
  await expectRowAnimation(3, 1);
  await waitState((s) => s.wall.current.lives === 3, 'lives = 3');
  await wrongGuess();
  await wrongGuess();
  await wrongGuess();
  state = await waitState((s) => s.wall.current.stage === 'frozen' && s.wall.current.endReason === 'lives', 'wall 2 frozen: out of lives');
  await seeText(wall, 'No lives left');
  await shot('r3-wall2-frozen');
  await action('Resolve wall', (s) => s.wall.current?.stage === 'resolving', 'wall 2 resolving');
  await action('Connection correct', (s) => s.wall.current?.resolvingGroup === 1, 'wall 2 connection 1 correct');
  await action('Connection incorrect', (s) => s.wall.current?.resolvingGroup === 2, 'wall 2 connection 2 incorrect');
  await action('Connection correct', (s) => s.wall.current?.resolvingGroup === 3, 'wall 2 connection 3 correct');
  await action('Connection incorrect', (s) => s.wall.current?.resolvingGroup === null, 'wall 2 connection 4 incorrect');
  exp[t2] += 2 + 2;
  state = await action('Finish wall (award points)', (s) => s.wall.current?.stage === 'done', 'wall 2 finished');
  check(state.wall.current.awarded?.total === 4, `wall 2 awarded ${JSON.stringify(state.wall.current.awarded)}`);
  await expectScores('wall 2');
  await clearWallAndCheck(2, 4, ['sun', 'lion'], t3);
  await shot('r3-wall3-select');

  // --- Wall 3 (blue): Water is chosen by mistake and aborted (handed back), then Ankh is played until time is called
  state = await chooseWall('water', t3);
  check(same(state.wall.used, ['sun', 'lion', 'water']), 'Water marked used while on screen');
  await clickAdmin('Abort wall');
  await admin().locator('.adm-confirm').waitFor({ timeout: 5_000 });
  state = await action('Abort wall', (s) => s.wall.current === null && s.wall.stage === 'selecting', 'wall 3: Water aborted (handed back)');
  check(same(state.wall.used, ['sun', 'lion']) && state.wall.team === t3 && state.wall.wallsDone === 2, `after abort: Water available again, ${teamName(t3)} still chooses, 2 walls done`);
  await expectScores('after abort (nothing awarded)');
  await seeText(monitor, `${teamName(t3)} to choose a wall`);
  const afterAbort = await pickerGlyphs();
  check(same(afterAbort.enabled, ['Water', 'Ankh']), `picker offers ${afterAbort.enabled.join(' and ')} again`);
  await shot('r3-wall3-aborted');
  state = await chooseWall('ankh', t3);
  await seeText(monitor, 'Wall 3 of 4');
  await seeText(admin(), 'Ankh wall');
  await startWall(3);
  await solveGroup(1);
  await expectRowAnimation(1, 0);
  await clickAdmin('Time up');
  await admin().locator('.adm-confirm').waitFor({ timeout: 5_000 });
  state = await action('Time up', (s) => s.wall.current?.stage === 'frozen' && s.wall.current.endReason === 'time', 'wall 3: time up');
  await seeText(monitor, "Time's up");
  await shot('r3-wall3-timeup');
  await action('Resolve wall', (s) => s.wall.current?.stage === 'resolving', 'wall 3 resolving');
  for (let i = 0; i < 4; i++) {
    await action('Connection correct', (s) => s.wall.current?.resolvingGroup === (i < 3 ? i + 1 : null), `wall 3 connection ${i + 1} correct`);
  }
  exp[t3] += 1 + 4;
  state = await action('Finish wall (award points)', (s) => s.wall.current?.stage === 'done', 'wall 3 finished');
  check(state.wall.current.awarded?.total === 5, `wall 3 awarded ${JSON.stringify(state.wall.current.awarded)}`);
  check(!(state.finishedRounds ?? []).includes('wall'), 'round not finished after 3 of 4 walls');
  await expectScores('wall 3');
  await clearWallAndCheck(3, 4, ['sun', 'lion', 'ankh'], t4);
  await shot('r3-wall4-select');

  // --- Wall 4 (pink): only Water is left; the selection board still shows it (three dark, one light)
  const lastPick = await pickerGlyphs();
  check(same(lastPick.enabled, ['Water']) && same(lastPick.used, ['Lion', 'Ankh', 'Sun']), 'only Water can be chosen for the last wall');
  check((await monitor.locator('.oc-monitor__wallgrid > [aria-label="Water"]').count()) === 1, 'monitor still shows the Water tile light');
  state = await chooseWall('water', t4);
  check(same(state.wall.used, ['sun', 'lion', 'ankh', 'water']), 'all four glyphs used (in the order chosen) once Water is on screen');
  await seeText(monitor, 'Wall 4 of 4');
  await startWall(4);
  await solveGroup(0);
  await expectRowAnimation(0, 0);
  await solveGroup(2);
  await expectRowAnimation(2, 1);
  await solveGroup(3);
  state = await waitState((s) => s.wall.current.stage === 'frozen' && s.wall.current.endReason === 'complete', 'wall 4 complete');
  await expectRowAnimation(3, 2);
  await expectRowAnimation(1, 3);
  await shot('r3-wall4-complete');
  await action('Resolve wall', (s) => s.wall.current?.stage === 'resolving', 'wall 4 resolving');
  await action('Connection correct', (s) => s.wall.current?.resolvingGroup === 1, 'wall 4 connection 1 correct');
  await action('Connection correct', (s) => s.wall.current?.resolvingGroup === 2, 'wall 4 connection 2 correct');
  await action('Connection correct', (s) => s.wall.current?.resolvingGroup === 3, 'wall 4 connection 3 correct');
  await action('Connection incorrect', (s) => s.wall.current?.resolvingGroup === null, 'wall 4 connection 4 incorrect');
  exp[t4] += 4 + 3;
  state = await action('Finish wall (award points)', (s) => s.wall.current?.stage === 'done', 'wall 4 finished');
  check(state.wall.current.awarded?.total === 7 && state.wall.current.awarded.bonus === 0, `wall 4 awarded ${JSON.stringify(state.wall.current.awarded)} (no bonus: a connection missed)`);
  check((state.finishedRounds ?? []).includes('wall'), 'wall round finished after the fourth wall');
  await expectScores('wall 4');
  await shot('r3-wall4-done');
  await clearWallAndCheck(4, 4, ['sun', 'lion', 'ankh', 'water'], t1);
  await shot('r3-all-played');

  // -------------------------------------------------------------------------
  // 5. Round 4 — Missing Vowels (one category, two clues), then the final
  // -------------------------------------------------------------------------
  await action(/^4\. Missing Vowels/, (s) => s.phase === 'vowels' && s.vowels?.stage === 'category', 'Missing Vowels started', { exact: false });
  await seeText(monitor, 'Capital cities');
  await action('Show clue', (s) => s.vowels?.stage === 'clue', 'clue 1 shown');
  await seeText(monitor, 'PRS');
  await buzzFrom(pages.buttonBlue, 'Jason');
  exp.blue += 1;
  await action('Correct', (s) => s.vowels?.stage === 'answer', 'clue 1 correct');
  await expectScores('vowels clue 1');
  await seeText(monitor, 'PARIS');
  await shot('r4-clue1-answer');
  await action('Next clue', (s) => s.vowels?.stage === 'clue' && s.vowels.clueIndex === 1, 'clue 2');
  await action('Nobody', (s) => s.vowels?.stage === 'answer', 'clue 2 nobody');
  await seeText(monitor, 'LIMA');

  await finalScores(mediaRequests);
  log(`the "${BIG_PACK_NAME}" pack (id ${created.id}) is left in place for the host to inspect`);
}

// ---------------------------------------------------------------------------
// Run + report
// ---------------------------------------------------------------------------

try {
  if (SCENARIO === 'big') await bigScenario();
  else await demoScenario();
} catch (err) {
  check(false, `scenario ${SCENARIO} threw: ${err?.stack ?? err}`);
}

const unexpectedErrors = consoleErrors.filter((e) => !(restartWindow && e.at >= restartWindow.from - 500 && e.at <= (restartWindow.to ?? Date.now()) + 2_000));
const restartErrors = consoleErrors.length - unexpectedErrors.length;
log(`console errors: ${unexpectedErrors.length} unexpected, ${restartErrors} during the api restart window`);
for (const e of unexpectedErrors) log(`  console[${e.page}] ${e.text.slice(0, 300)}`);
check(unexpectedErrors.length === 0, 'no console errors outside the restart window');
log(`${checksTotal} checks, ${failures.length} failed`);
log(failures.length === 0 ? `E2E PASSED: ${checksTotal} checks` : `E2E FAILED (${failures.length} of ${checksTotal}): ${failures.join(' | ')}`);
fs.writeFileSync(path.join(OUT, 'e2e-log.txt'), logLines.join('\n') + '\n');
publicSocket?.disconnect();
await browser.close();
process.exit(failures.length === 0 ? 0 : 1);
