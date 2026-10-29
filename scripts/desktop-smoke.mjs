/**
 * Drives the built desktop app headlessly (docs/DESKTOP.md §6.5). Run by scripts/desktop-smoke.sh inside the
 * Playwright image under xvfb-run; needs the `playwright` package next to it.
 *
 * Environment:
 *   APP_DIR        the desktop workspace with dist/ built (default /app/desktop)
 *   ELECTRON_PATH  electron executable (default: Playwright's own resolution of `electron`)
 *   OUT_DIR        window.png, smoke-log.txt, electron-stdout.txt, data/ (default ./desktop-smoke)
 *   PORT           server port written into the temp data dir's settings.json (default 8089)
 */
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { join, resolve } from 'node:path';
import { _electron as electron } from 'playwright';

const APP_DIR = resolve(process.env.APP_DIR ?? '/app/desktop');
const OUT_DIR = resolve(process.env.OUT_DIR ?? './desktop-smoke');
const PORT = Number(process.env.PORT ?? 8089);
const ELECTRON_PATH = process.env.ELECTRON_PATH || undefined;
const BASE = `http://localhost:${PORT}`;

mkdirSync(OUT_DIR, { recursive: true });
const logFile = join(OUT_DIR, 'smoke-log.txt');
writeFileSync(logFile, '');
const log = (msg) => {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
  appendFileSync(logFile, line + '\n');
};
let checks = 0;
const check = (cond, msg) => {
  if (!cond) throw new Error(`check failed: ${msg}`);
  checks += 1;
  log(`ok   ${msg}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 120_000, interval = 500, what = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(interval);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function portOpen(port) {
  return new Promise((resolvePort) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolvePort(true);
    });
    socket.once('error', () => resolvePort(false));
  });
}

// A fresh data directory with only the port set: the app must fill the other keys (and the secret) itself.
const dataDir = join(OUT_DIR, 'data');
rmSync(dataDir, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });
writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ port: PORT, autoStart: true }, null, 2));
const expectedVersion = JSON.parse(readFileSync(join(APP_DIR, 'package.json'), 'utf8')).version;

log(`launching ${APP_DIR} (electron: ${ELECTRON_PATH ?? 'default'}) with OC_DATA_DIR=${dataDir}, port ${PORT}`);
const stdoutFile = join(OUT_DIR, 'electron-stdout.txt');
writeFileSync(stdoutFile, '');
const app = await electron.launch({
  executablePath: ELECTRON_PATH,
  args: [APP_DIR, '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  env: { ...process.env, OC_DATA_DIR: dataDir, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  timeout: 90_000,
});
app.process().stdout?.on('data', (d) => appendFileSync(stdoutFile, d));
app.process().stderr?.on('data', (d) => appendFileSync(stdoutFile, d));

let page;
try {
  page = await app.firstWindow({ timeout: 60_000 });
  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text());
  });
  await page.waitForLoadState('domcontentloaded');
  log(`window title: ${await page.title()}`);

  const version = await app.evaluate(({ app: a }) => a.getVersion());
  check(version === expectedVersion, `app.getVersion() is ${expectedVersion}`);
  await page.waitForSelector('[data-testid="version"]:not(:empty)', { timeout: 15_000 });
  check((await page.textContent('[data-testid="version"]')).trim() === expectedVersion, 'the window shows the version');

  const status = await waitFor(
    async () => {
      const s = await page.evaluate(() => window.oc.getStatus());
      if (s.server.status === 'failed') throw new Error(`server failed: ${s.server.code ?? ''} ${s.server.message}`);
      return s.server.status === 'running' ? s : null;
    },
    { timeout: 180_000, what: 'status: running' },
  );
  check(status.server.port === PORT, `server running on port ${PORT}`);
  check(status.settings.adminUsername === 'admin' && status.settings.port === PORT, 'settings filled from defaults + the written port');
  check(typeof status.settings.jwtSecret === 'undefined', 'the JWT secret is not exposed to the window');
  await page.waitForSelector(`[data-testid="status-text"]:has-text("running on port ${PORT}")`, { timeout: 15_000 });
  check(true, 'status strip says "Server running on port …"');

  const health = await fetch(`${BASE}/api/health`).then((r) => r.json());
  check(health && health.ok === true, 'GET /api/health -> {ok:true}');

  const adminRes = await fetch(`${BASE}/admin`);
  const adminHtml = await adminRes.text();
  check(adminRes.ok && /text\/html/.test(adminRes.headers.get('content-type') ?? ''), '/admin is served as HTML');
  check(/<div id="root"/.test(adminHtml) || /<!doctype html/i.test(adminHtml), '/admin returns the SPA index.html');

  const buttonLink = (await page.textContent('[data-testid="link-button"]')).trim();
  check(/\/button$/.test(buttonLink) && buttonLink.includes(`:${PORT}`), `buzzer link is ${buttonLink}`);
  await page.click('[data-testid="copy-button"]');
  await page.waitForSelector('[data-testid="copy-button"]:has-text("Copied")', { timeout: 5_000 });
  const clip = await app.evaluate(({ clipboard }) => clipboard.readText());
  check(clip === buttonLink, 'clipboard holds the buzzer link after Copy');

  await page.click('[data-testid="copy-invite"]');
  await sleep(300);
  const invite = await app.evaluate(({ clipboard }) => clipboard.readText());
  check(invite === `Join the quiz: ${buttonLink}`, 'clipboard holds the invitation after the fifth button');

  const stats = await waitFor(async () => (await page.evaluate(() => window.oc.getStatus())).stats, { timeout: 15_000, what: 'stats' });
  check(typeof stats.connections.monitor === 'number', 'live statistics are reported');

  // The 2 s status pushes must not rebuild unchanged sections: keyboard focus and a selection in a URL survive.
  await page.focus('[data-testid="copy-admin"]');
  await page.evaluate(() => {
    const range = document.createRange();
    range.selectNodeContents(document.querySelector('[data-testid="link-admin"]'));
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  });
  await sleep(2_600);
  const focused = await page.evaluate(() => document.activeElement?.getAttribute('data-testid') ?? document.activeElement?.tagName ?? '');
  check(focused === 'copy-admin', `keyboard focus survives the status pushes (on "${focused}")`);
  const selection = await page.evaluate(() => window.getSelection()?.toString() ?? '');
  check(/\/admin$/.test(selection.trim()), `text selection in the admin URL survives the status pushes ("${selection.trim()}")`);
  const cspErrors = consoleErrors.filter((t) => /Content.Security.Policy|Refused to/i.test(t));
  check(cspErrors.length === 0, `no CSP violations in the renderer console${cspErrors.length ? `: ${cspErrors[0]}` : ''}`);

  await page.screenshot({ path: join(OUT_DIR, 'window.png'), fullPage: true });
  log('screenshot window.png taken');

  await page.click('[data-testid="btn-stop"]');
  await waitFor(async () => (await page.evaluate(() => window.oc.getStatus())).server.status === 'stopped', { timeout: 60_000, what: 'status: stopped' });
  check(true, 'server stopped from the UI');
  await waitFor(async () => !(await portOpen(PORT)), { timeout: 15_000, what: 'port released' });
  check(true, `port ${PORT} released`);

  const logLines = await page.evaluate(() => window.oc.getLog());
  check(logLines.some((l) => /server stopped/.test(l)), 'the log mentions the stop');

  await app.close();
  log(`SMOKE PASSED (${checks} checks)`);
} catch (err) {
  log(`SMOKE FAILED after ${checks} checks: ${err instanceof Error ? err.stack ?? err.message : err}`);
  try {
    if (page) await page.screenshot({ path: join(OUT_DIR, 'failure.png') });
  } catch {
    // ignore
  }
  try {
    await app.close();
  } catch {
    // ignore
  }
  process.exit(1);
}
