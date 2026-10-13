/**
 * End-to-end run of a complete Only Connect game in real browsers.
 *
 * Opens the monitor (1920x1080), the wall panel (1024x768), two phones (390x844, one per team) and the admin
 * console (1440x900) against a running stack, drives every round through the real /admin UI, taps the wall
 * tiles on the /wall page, buzzes from the phones, screenshots every screen at every stage and asserts on the
 * visible text and on the authoritative state (read back through the admin API).
 *
 * Run it with scripts/e2e/run.sh (see the README there). Environment:
 *   BASE_URL      stack URL (default http://localhost:8089)
 *   OUT_DIR       screenshots + log go here (default ./e2e)
 *   ADMIN_USER / ADMIN_PASS  (default admin / 12346789)
 *   RESTART_MODE  'file' (default: ask the host runner to restart the api), 'skip' (no restart test)
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const BASE = (process.env.BASE_URL ?? 'http://localhost:8089').replace(/\/$/, '');
const OUT = path.resolve(process.env.OUT_DIR ?? 'e2e');
const ADMIN_USER = process.env.ADMIN_USER ?? 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS ?? '12346789';
const RESTART_MODE = process.env.RESTART_MODE ?? 'file';
const PINK = 'Nightwearers';
const BLUE = 'Bookworms';

fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(OUT)) if (/\.(png|txt)$/.test(f) || /^restart\./.test(f)) fs.unlinkSync(path.join(OUT, f));

// ---------------------------------------------------------------------------
// Logging / assertions
// ---------------------------------------------------------------------------

const logLines = [];
const failures = [];
const consoleErrors = [];
let restartWindow = null;

function log(msg) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
  console.log(line);
  logLines.push(line);
}
function check(cond, msg) {
  if (cond) log(`ok   ${msg}`);
  else {
    log(`FAIL ${msg}`);
    failures.push(msg);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/** Poll the admin state until `pred` holds (or time out and record a failure). Returns the last state. */
async function waitState(pred, label, timeout = 12_000) {
  const start = Date.now();
  let last = null;
  let lastErr = null;
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
async function pickHieroglyph(label) {
  await admin().locator(`.adm-glyphpick [role="button"][aria-label="${label}"]`).click();
  return waitState((s) => s.question?.stage === 'question', `picked ${label}`);
}

// Expected scores (kept alongside the run so every judgement is verified).
const exp = { pink: 0, blue: 0 };
async function expectScores(label) {
  const s = await waitState((st) => st.teams.pink.score === exp.pink && st.teams.blue.score === exp.blue, `scores ${exp.pink}-${exp.blue} (${label})`);
  return s;
}

// ---------------------------------------------------------------------------
// 0. Open every screen
// ---------------------------------------------------------------------------

log(`stack ${BASE}, output ${OUT}`);
token = (await api('POST', '/admin/login', { username: ADMIN_USER, password: ADMIN_PASS })).token;
check(typeof token === 'string' && token.length > 20, 'REST login returns a token');

const monitor = await open('monitor', 1920, 1080, '/monitor');
const wall = await open('wall', 1024, 768, '/wall');
const buttonPink = await open('buttonPink', 390, 844, '/button', true);
const buttonBlue = await open('buttonBlue', 390, 844, '/button', true);
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

// ---------------------------------------------------------------------------
// 1. New game
// ---------------------------------------------------------------------------

const existing = await adminState();
if (existing) {
  // A game already exists (re-run): the panel starts collapsed.
  const expand = adminPage.locator('.adm-panel', { hasText: 'New game' }).getByRole('button', { name: /Expand/ });
  if (await expand.count()) await expand.click();
}
await adminPage.locator('#adm-new-pack').waitFor();
await adminPage.waitForFunction(() => {
  const sel = document.querySelector('#adm-new-pack');
  return sel && [...sel.options].some((o) => o.textContent.includes('Demo pack'));
});
await adminPage.selectOption('#adm-new-pack', { label: 'Demo pack' });
await adminPage.fill('#adm-new-pink', PINK);
await adminPage.fill('#adm-new-blue', BLUE);
await adminPage.locator('label.adm-radio.is-pink').click();
await adminPage.getByRole('button', { name: /^Start (a new )?game/ }).click();
await sleep(300);
const confirm = adminPage.getByRole('button', { name: 'Start new game' });
if (await confirm.count()) await confirm.click();
let state = await waitState((s) => s.phase === 'lobby' && s.teams.pink.name === PINK && s.teams.blue.name === BLUE, 'new game in lobby');
const gameId = state?.id;
check(state?.pack?.name === 'Demo pack' && state?.firstTeam === 'pink', 'game uses the demo pack, pink picks first');

// Phones join
async function join(page, name, team) {
  await page.locator('.join__input').fill(name);
  await page.locator(`.join__team--${team}`).click();
  await page.locator('.join__submit').click();
  await page.locator('.buzzer__button').waitFor({ timeout: 10_000 });
}
await join(buttonPink, 'Mia', 'pink');
await join(buttonBlue, 'Jason', 'blue');
state = await waitState((s) => s.players.length === 2 && s.players.every((p) => p.connected), 'Mia and Jason joined and connected');
const mia = state.players.find((p) => p.name === 'Mia');
const jason = state.players.find((p) => p.name === 'Jason');
check(mia?.team === 'pink' && jason?.team === 'blue', 'players are on the right teams');
await seeText(monitor, PINK);
await seeText(monitor, '2 players connected');
await seeText(buttonPink, PINK);
await seeText(buttonBlue, BLUE);
await seeText(wall, 'Waiting for the game master', 'wall idle text', 8_000);
await seeText(adminPage, 'Mia');
await shot('lobby');

// ---------------------------------------------------------------------------
// 2. Round 1 — Connections
// ---------------------------------------------------------------------------

await action(/^1\. Connections/, (s) => s.phase === 'connections' && s.question?.stage === 'selecting' && s.question.team === 'pink', 'Connections started, pink to pick', { exact: false });
await seeText(monitor, `${PINK} to choose`);
await shot('r1-select');

const reveal = (n, label) => action('Reveal next clue', (s) => s.question?.revealed === n, `${label}: ${n} clues shown`);

// Q1 pink — Two Reeds, 3 clues, correct for 2
await pickHieroglyph('Two Reeds');
await seeText(monitor, 'A whip');
await seeText(monitor, '5 Points');
await shot('r1-q1-clue1');
await reveal(2, 'Q1');
await reveal(3, 'Q1');
await seeText(monitor, 'A joke');
await seeText(monitor, '2 Points');
await shot('r1-q1-clue3');
exp.pink += 2;
await action('Correct', (s) => s.question?.stage === 'answer', 'Q1 correct');
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

// Q3 pink — Twisted Flax (images), 4 clues, incorrect, blue steals correctly
await pickHieroglyph('Twisted Flax');
await reveal(2, 'Q3');
await reveal(3, 'Q3');
await reveal(4, 'Q3');
await seeText(monitor, '1 Point');
check((await monitor.locator('img[src*="/api/media/demo/flag-"]').count()) >= 4, 'monitor shows the 4 flag images');
await shot('r1-q3-images');
await action('Incorrect / pass', (s) => s.question?.stage === 'steal', 'Q3 incorrect -> steal');
await seeText(monitor, `${BLUE} to steal`);
await shot('r1-q3-steal');
exp.blue += 1;
await action('Steal correct', (s) => s.question?.stage === 'answer' && s.question.result?.viaSteal === true, 'Q3 steal correct');
await expectScores('Q3');
await seeText(monitor, 'Flags with a single disc');
await seeText(monitor, 'Flag of Japan');
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

// Q5 pink — Water, 2 clues, correct for 3
await pickHieroglyph('Water');
await reveal(2, 'Q5');
await seeText(monitor, '3 Points');
exp.pink += 3;
await action('Correct', (s) => s.question?.stage === 'answer', 'Q5 correct');
await expectScores('Q5');
await action('Next question', (s) => s.question?.stage === 'selecting', 'Q5 next');

// Q6 blue — Eye of Horus, 4 clues, incorrect, pink steals
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

// ---------------------------------------------------------------------------
// 3. Round 2 — Sequences (blue picks first)
// ---------------------------------------------------------------------------

await action(/^2\. Sequences/, (s) => s.phase === 'sequences' && s.question?.team === 'blue', 'Sequences started, blue to pick', { exact: false });
await seeText(monitor, `${BLUE} to choose`);

await pickHieroglyph('Two Reeds'); // blue: Mercury, Venus, Earth, ?
await reveal(2, 'S1');
await reveal(3, 'S1');
check((await admin().getByRole('button', { name: 'Reveal next clue' }).isDisabled()), 'sequences: 4th clue cannot be revealed');
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

// ---------------------------------------------------------------------------
// 4. Round 3 — Connecting Wall
// ---------------------------------------------------------------------------

state = await action(/^3\. Connecting Wall/, (s) => s.phase === 'wall' && s.wall !== null, 'Wall round started', { exact: false });
check(state.wall.assignment.pink && state.wall.assignment.blue && state.wall.assignment.pink !== state.wall.assignment.blue, 'each team is assigned a different wall');
await seeText(monitor, 'Connecting Wall');
await shot('r3-start');

/** Tile ids of a group in the current wall (ids are stable across re-ordering). */
function groupIds(s, groupIndex) {
  return s.wall.current.tiles.filter((t) => t.group === groupIndex).map((t) => t.id);
}
function unsolvedGroups(s) {
  return s.wall.current.groups.filter((g) => g.solvedOrder === null).map((g) => g.index);
}
async function tapTile(id) {
  const before = (await adminState()).version;
  await wall.locator(`[data-tile-id="${id}"]`).click({ timeout: 5_000 });
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

// --- Pink wall: 2 groups, then run out of lives
await action(`Show wall for ${PINK}`, (s) => s.wall.current?.stage === 'ready' && s.wall.current.team === 'pink', 'pink wall on screen (ready)');
await seeText(wall, PINK);
await shot('r3-pink-ready');
await action('Start wall (3:00)', (s) => s.wall.current?.stage === 'live', 'pink wall live');
await wall.locator('[data-tile-id="0"]').waitFor({ timeout: 5_000 });
check((await wall.locator('[data-tile-id]').count()) === 16, 'wall panel shows 16 tiles');
await shot('r3-pink-live');
await tapTile(groupIds(await adminState(), 0)[0]);
await shot('r3-pink-selected1');
// deselect it again
await tapTile(groupIds(await adminState(), 0)[0]);
await waitState((s) => s.wall.current.selected.length === 0, 'tile deselected');
await solveGroup(0);
await shot('r3-pink-group1');
await solveGroup(1);
state = await waitState((s) => s.wall.current.lives === 3, 'lives = 3 after the 2nd group');
await shot('r3-pink-group2');
await wrongGuess();
await shot('r3-pink-wrong');
await waitState((s) => s.wall.current.lives === 2, 'lives = 2');
await wrongGuess();
await waitState((s) => s.wall.current.lives === 1, 'lives = 1');
state = await wrongGuess();
state = await waitState((s) => s.wall.current.stage === 'frozen' && s.wall.current.endReason === 'lives' && s.wall.current.lives === 0, 'pink wall frozen: out of lives');
check(typeof state.wall.current.endedAt === 'number', 'endedAt recorded on the frozen wall');
await seeText(wall, 'No lives left');
await seeText(monitor, 'No lives left');
await shot('r3-pink-frozen');
// taps are rejected now
await wall.locator(`[data-tile-id="${groupIds(state, unsolvedGroups(state)[0])[0]}"]`).click({ timeout: 3_000, force: true }).catch(() => {});
await sleep(400);
check((await adminState()).wall.current.selected.length === 0, 'taps on a frozen wall are ignored');

await action('Resolve wall', (s) => s.wall.current?.stage === 'resolving' && s.wall.current.resolvingGroup === 0, 'pink wall resolving');
check((await adminState()).wall.current.groups.every((g) => g.solvedOrder !== null), 'all 4 groups revealed on resolve');
await seeText(monitor, 'Connection?');
await shot('r3-pink-resolving');
await action('Connection correct', (s) => s.wall.current?.resolvingGroup === 1, 'connection 1 correct');
await action('Connection incorrect', (s) => s.wall.current?.resolvingGroup === 2, 'connection 2 incorrect');
await shot('r3-pink-connections');
await action('Connection correct', (s) => s.wall.current?.resolvingGroup === 3, 'connection 3 correct');
await action('Connection correct', (s) => s.wall.current?.resolvingGroup === null, 'connection 4 correct');
exp.pink += 2 + 3;
state = await action('Finish wall (award points)', (s) => s.wall.current?.stage === 'done' && s.wall.completed.includes('pink'), 'pink wall finished');
check(state.wall.current.awarded?.total === 5 && state.wall.current.awarded.groups === 2 && state.wall.current.awarded.connections === 3, `pink wall awarded ${JSON.stringify(state.wall.current.awarded)}`);
await expectScores('pink wall');
await seeText(monitor, 'Groups 2');
await seeText(wall, 'Chess pieces');
await shot('r3-pink-done');
await action('Clear wall', (s) => s.wall.current === null, 'pink wall cleared');

// --- Blue wall: 1 group, a wrong guess without lives, then the host calls time
await action(`Show wall for ${BLUE}`, (s) => s.wall.current?.team === 'blue' && s.wall.current.stage === 'ready', 'blue wall on screen');
await action('Start wall (3:00)', (s) => s.wall.current?.stage === 'live', 'blue wall live');
await wall.locator('[data-tile-id="0"]').waitFor({ timeout: 5_000 });
await solveGroup(2);
state = await wrongGuess();
check(state.wall.current.lives === null && state.wall.current.stage === 'live', 'a wrong guess before 2 groups costs no life');
await shot('r3-blue-wrong');
// "Time up" asks for a confirmation first (a mis-click would otherwise end the wall for good); the confirm
// button carries the same label and is the only enabled one once the inline prompt is up.
await clickAdmin('Time up');
await admin().locator('.adm-confirm').waitFor({ timeout: 5_000 });
check(true, 'Time up asks for a confirmation');
state = await action('Time up', (s) => s.wall.current?.stage === 'frozen' && s.wall.current.endReason === 'time', 'blue wall: time up');
await seeText(wall, "Time's up");
await seeText(monitor, "Time's up");
await shot('r3-blue-timeup');
await action('Resolve wall', (s) => s.wall.current?.stage === 'resolving', 'blue wall resolving');
for (let i = 0; i < 4; i++) {
  await action('Connection correct', (s) => s.wall.current?.resolvingGroup === (i < 3 ? i + 1 : null), `blue connection ${i + 1} correct`);
}
exp.blue += 1 + 4;
state = await action('Finish wall (award points)', (s) => s.wall.current?.stage === 'done', 'blue wall finished');
check(state.wall.current.awarded?.total === 5, `blue wall awarded ${JSON.stringify(state.wall.current.awarded)}`);
check((state.finishedRounds ?? []).includes('wall'), 'wall round finished after both walls');
await expectScores('blue wall');
await shot('r3-blue-done');
await action('Clear wall', (s) => s.wall.current === null, 'blue wall cleared');

// ---------------------------------------------------------------------------
// 5. Round 4 — Missing Vowels
// ---------------------------------------------------------------------------

await action(/^4\. Missing Vowels/, (s) => s.phase === 'vowels' && s.vowels?.stage === 'category', 'Missing Vowels started', { exact: false });
await seeText(monitor, 'Capital cities');
await seeText(buttonPink, 'Waiting for the next clue');
await shot('r4-category');

const buzzer = (page) => page.locator('.buzzer__button');
async function buzzFrom(page, who) {
  await buzzer(page).click({ timeout: 5_000 });
  return waitState((s) => s.vowels?.stage === 'buzzed' && s.vowels.buzz?.playerName === who, `${who} buzzed`);
}

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

// ---------------------------------------------------------------------------
// 6. API restart mid-game: everything must come back by itself
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// 7. Second category, skip the third, final scores
// ---------------------------------------------------------------------------

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

state = await action(/^Final scores/, (s) => s.phase === 'final', 'Final', { exact: false });
await seeText(monitor, 'Final scores');
const winner = exp.pink > exp.blue ? PINK : exp.blue > exp.pink ? BLUE : null;
await seeText(monitor, winner ? `${winner} win!` : "It's a draw!");
check(state.teams.pink.score === exp.pink && state.teams.blue.score === exp.blue, `final scores ${PINK} ${state.teams.pink.score} – ${BLUE} ${state.teams.blue.score}`);
await seeText(buttonPink, 'Final scores are up');
await shot('final');

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const unexpectedErrors = consoleErrors.filter((e) => !(restartWindow && e.at >= restartWindow.from - 500 && e.at <= (restartWindow.to ?? Date.now()) + 2_000));
const restartErrors = consoleErrors.length - unexpectedErrors.length;
log(`media requests from the monitor: ${mediaRequests.length} (${[...new Set(mediaRequests.map((r) => r.url.split('/api/media/')[1]))].join(', ')})`);
log(`console errors: ${unexpectedErrors.length} unexpected, ${restartErrors} during the api restart window`);
for (const e of unexpectedErrors) log(`  console[${e.page}] ${e.text.slice(0, 300)}`);
check(unexpectedErrors.length === 0, 'no console errors outside the restart window');
log(`${failures.length === 0 ? 'E2E PASSED' : `E2E FAILED (${failures.length})`}: ${failures.join(' | ')}`);
fs.writeFileSync(path.join(OUT, 'e2e-log.txt'), logLines.join('\n') + '\n');
await browser.close();
process.exit(failures.length === 0 ? 0 : 1);
