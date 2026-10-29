/**
 * The control window (docs/DESKTOP.md §6.3). Plain DOM, no framework: renders the Status pushed by the main
 * process (`window.oc`, see src/shared/ipc.ts) into the sections of index.html.
 */
import type { Address, Links, Status } from '../shared/ipc';
import { buildLinks, invitation } from '../shared/links';

const COPIED_MS = 1_500;
const FALLBACK_HOST = 'localhost';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

function esc(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

function two(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function clock(epochMs: number): string {
  const d = new Date(epochMs);
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
}

const PHASE_LABELS: Record<string, string> = {
  lobby: 'Lobby',
  connections: 'Round 1 — Connections',
  sequences: 'Round 2 — Sequences',
  wall: 'Round 3 — Connecting Wall',
  vowels: 'Round 4 — Missing Vowels',
  final: 'Final scores',
};

function phaseLabel(phase: string): string {
  return PHASE_LABELS[phase] ?? phase.charAt(0).toUpperCase() + phase.slice(1).replace(/[_-]/g, ' ');
}

/** The ipcMain.handle rejection reads "Error invoking remote method 'oc:x': Error: message"; show only the message. */
function errorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
}

interface UiState {
  status: Status | null;
  copied: { key: string; until: number } | null;
  revealPassword: boolean;
  settingsDirty: boolean;
  log: string[];
}

const ui: UiState = { status: null, copied: null, revealPassword: false, settingsDirty: false, log: [] };
let copiedTimer: number | null = null;

/**
 * The main process pushes a Status at least every 2 s. Rebuilding a section's innerHTML on every push would
 * destroy the focused button or radio and wipe a text selection in a URL, so each section remembers the
 * inputs it was last rendered from and is only rebuilt when they changed.
 */
const renderedFrom = new Map<string, string>();
function changed(section: string, inputs: unknown): boolean {
  const key = JSON.stringify(inputs);
  if (renderedFrom.get(section) === key) return false;
  renderedFrom.set(section, key);
  return true;
}

/** The port the screens are (or will be) served on. */
function effectivePort(s: Status): number {
  return s.server.status === 'running' ? s.server.port : s.settings.port;
}

// --- status strip --------------------------------------------------------------------------------------------

function renderStatus(s: Status): void {
  if (!changed('status', [s.server, s.dataDir, s.platform])) return;
  const el = $('status');
  const server = s.server;
  el.className = `strip ${server.status}`;
  let text = '';
  let sub = '';
  let inline = '';
  const canStart = server.status === 'stopped' || server.status === 'failed';
  const canStop = server.status === 'running';
  switch (server.status) {
    case 'running':
      text = `Server running on port ${server.port} since ${clock(server.startedAt)}`;
      sub = `Listening on every network adapter · data in ${s.dataDir}`;
      break;
    case 'stopped':
      text = 'Stopped';
      sub = 'The screens are not reachable until the server is started.';
      break;
    case 'starting':
      text = 'Starting…';
      break;
    case 'stopping':
      text = 'Stopping…';
      break;
    case 'failed': {
      // The port the start was attempted on, not the saved one (Settings → Save does not restart).
      const port = server.port;
      const alt = port === 8080 ? 8081 : 8080;
      const usePort = `<button type="button" class="btn warn" data-action="use-port" data-port="${alt}" data-testid="use-port">Use port ${alt} instead</button>`;
      if (server.code === 'EADDRINUSE') {
        text = `Failed: port ${port} is in use`;
        sub = 'Another program (often a web server or Skype) is listening on this port.';
        inline = usePort;
      } else if (server.code === 'EACCES' && s.platform === 'win32') {
        // Windows has no privileged ports: EACCES means http.sys (IIS, Web Deploy, SQL Reporting Services) owns
        // the port or it lies in a Hyper-V / WSL excluded range. Elevation changes nothing; another port does.
        text = `Failed: port ${port} is reserved by Windows or another service`;
        sub = 'IIS, Hyper-V or WSL holds this port; running the app as administrator does not help — pick another port.';
        inline = usePort;
      } else if (server.code === 'EACCES') {
        text = `Failed: port ${port} needs administrator rights`;
        sub = 'Pick a port above 1024 in the settings, or run the app as administrator.';
        inline = usePort;
      } else {
        text = `Failed: ${server.message}`;
        sub = server.code ? `Error code ${server.code}` : '';
      }
      break;
    }
  }
  el.innerHTML = `
    <div class="status">
      <span class="dot" aria-hidden="true"></span>
      <div>
        <div class="status-text" data-testid="status-text">${esc(text)}</div>
        ${sub ? `<div class="status-sub">${esc(sub)}</div>` : ''}
      </div>
    </div>
    <div class="actions">
      ${inline}
      <button type="button" class="btn primary" data-action="start" data-testid="btn-start" ${canStart ? '' : 'disabled'}>Start</button>
      <button type="button" class="btn danger" data-action="stop" data-testid="btn-stop" ${canStop ? '' : 'disabled'}>Stop</button>
      <button type="button" class="btn" data-action="restart" data-testid="btn-restart" ${canStop ? '' : 'disabled'}>Restart</button>
    </div>`;
}

// --- addresses -----------------------------------------------------------------------------------------------

function renderAddresses(s: Status): void {
  if (!changed('addresses', [s.addresses, s.selectedAddress, effectivePort(s)])) return;
  const list = $('addresses');
  const note = $('address-note');
  if (s.addresses.length === 0) {
    list.innerHTML = `<p class="empty">No network address found. Connect to a network or a VPN; the links below use ${esc(FALLBACK_HOST)} for this computer only.</p>`;
    note.textContent = '';
    return;
  }
  list.innerHTML = s.addresses
    .map((a: Address) => {
      const selected = a.address === s.selectedAddress;
      return `
        <label class="address ${selected ? 'selected' : ''}" data-testid="address-${esc(a.address)}">
          <input type="radio" name="address" value="${esc(a.address)}" ${selected ? 'checked' : ''} data-action="select-address">
          <span>
            <span class="ip">${esc(a.address)}</span>
            <span class="adapter"> · ${esc(a.adapter)}</span>
          </span>
          <span class="badge ${a.kind}">${a.kind}</span>
        </label>`;
    })
    .join('');
  // The note speaks about the address the links are built from, not just about whether a VPN exists: a VPN
  // the app does not recognise shows as `other` and works all the same once picked (README, Troubleshooting).
  const selected = s.addresses.find((a) => a.address === s.selectedAddress);
  const vpn = s.addresses.find((a) => a.kind === 'vpn');
  const parts: string[] = [];
  if (selected?.kind === 'vpn') {
    parts.push(`Remote players (Hamachi, NetBird, Tailscale…) use this vpn address ${selected.address}; players on the same network can use a lan address.`);
  } else if (selected?.kind === 'other') {
    parts.push(`${selected.address} (${selected.adapter}) is not recognised as a LAN or VPN address; it works if your players can reach it.`);
  } else if (vpn) {
    parts.push(`Players on the same network use this lan address; remote players (Hamachi, NetBird, Tailscale…) need the vpn address ${vpn.address}.`);
  } else {
    parts.push('No VPN adapter found: only players on the same network can join. Start Hamachi, NetBird or Tailscale to let remote players in.');
  }
  parts.push(`TCP port ${effectivePort(s)} must be reachable on that address (Windows Firewall: see Settings).`);
  note.textContent = parts.join(' ');
}

// --- links ---------------------------------------------------------------------------------------------------

function currentLinks(s: Status): Links {
  return buildLinks(s.selectedAddress ?? FALLBACK_HOST, effectivePort(s));
}

function isCopied(key: string): boolean {
  return ui.copied?.key === key && ui.copied.until > Date.now();
}

function copyButton(key: string, text: string, label = 'Copy'): string {
  const copied = isCopied(key);
  return `<button type="button" class="btn small ${copied ? 'copied' : ''}" data-action="copy" data-key="${esc(key)}" data-text="${esc(text)}" data-label="${esc(label)}" data-testid="copy-${esc(key)}">${copied ? 'Copied' : label}</button>`;
}

/** "Copied" labels change in place: rebuilding the links panel for them would drop the focus off the button just clicked. */
function refreshCopied(): void {
  for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-action="copy"]')) {
    const copied = isCopied(btn.dataset.key ?? '');
    btn.classList.toggle('copied', copied);
    btn.textContent = copied ? 'Copied' : btn.dataset.label ?? 'Copy';
  }
}

/** The password reveal next to the admin link, also updated in place. */
function refreshReveal(s: Status): void {
  const pw = document.querySelector<HTMLElement>('[data-testid="admin-password"]');
  if (pw) pw.textContent = ui.revealPassword ? s.settings.adminPassword : '••••••••';
  const btn = document.querySelector<HTMLButtonElement>('[data-action="reveal"]');
  if (btn) btn.textContent = ui.revealPassword ? 'Hide' : 'Show';
}

function renderLinks(s: Status): void {
  const links = currentLinks(s);
  if (!changed('links', [links, s.settings.adminUsername, s.settings.adminPassword])) {
    refreshReveal(s);
    return;
  }
  const rows: Array<{ key: keyof Links; name: string; extra?: string }> = [
    {
      key: 'admin',
      name: 'Admin',
      extra: `<span class="login">login <b>${esc(s.settings.adminUsername)}</b> / <b data-testid="admin-password">${
        ui.revealPassword ? esc(s.settings.adminPassword) : '••••••••'
      }</b> <button type="button" class="link-btn" data-action="reveal">${ui.revealPassword ? 'Hide' : 'Show'}</button></span>`,
    },
    { key: 'monitor', name: 'Monitor' },
    { key: 'wall', name: 'Wall' },
    { key: 'button', name: 'Buzzer' },
  ];
  $('links').innerHTML =
    rows
      .map(
        (r) => `
      <div class="link-row" data-testid="link-row-${r.key}">
        <div class="link-head"><span class="link-name">${r.name}</span>${r.extra ?? ''}</div>
        <code class="url" data-testid="link-${r.key}">${esc(links[r.key])}</code>
        <div class="link-actions">
          ${copyButton(r.key, links[r.key])}
          <button type="button" class="btn small" data-action="open" data-url="${esc(links[r.key])}" data-testid="open-${r.key}">Open</button>
        </div>
      </div>`,
      )
      .join('') +
    `<div class="invite">
      ${copyButton('invite', invitation(links.button), 'Copy buzzer link with invitation')}
      <span class="hint">“${esc(invitation(links.button))}”</span>
    </div>`;
}

// --- statistics ----------------------------------------------------------------------------------------------

function renderStats(s: Status): void {
  const el = $('stats');
  if (s.server.status !== 'running') {
    el.innerHTML = `<p class="empty">${s.server.status === 'starting' ? 'Starting…' : 'The server is stopped.'}</p>`;
    return;
  }
  const st = s.stats;
  if (!st) {
    el.innerHTML = '<p class="empty">Waiting for statistics…</p>';
    return;
  }
  const c = st.connections;
  const game = st.game;
  el.innerHTML = `
    <div class="tiles" data-testid="stat-tiles">
      <div class="tile"><span class="n">${c.monitor}</span><span class="l">Monitor</span></div>
      <div class="tile"><span class="n">${c.wall}</span><span class="l">Wall</span></div>
      <div class="tile"><span class="n">${c.button}</span><span class="l">Phones</span></div>
      <div class="tile"><span class="n">${c.admin}</span><span class="l">Admin</span></div>
    </div>
    <dl class="kv">
      <dt>Players joined</dt><dd data-testid="stat-players">${st.players}</dd>
      <dt>Phase</dt><dd data-testid="stat-phase">${game ? esc(phaseLabel(game.phase)) : 'No game'}</dd>
      <dt>Pack</dt><dd data-testid="stat-pack">${game?.pack ? esc(game.pack) : '—'}</dd>
      <dt>Uptime</dt><dd>${esc(uptime(st.startedAt))}</dd>
      ${c.other ? `<dt>Other sockets</dt><dd>${c.other}</dd>` : ''}
    </dl>
    ${
      game && game.teams.length
        ? `<ul class="teams" data-testid="stat-teams">${game.teams
            .map((t) => `<li><span>${esc(t.name)}</span><span class="score">${t.score}</span></li>`)
            .join('')}</ul>`
        : ''
    }`;
}

function uptime(startedAt: number): string {
  const secs = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const sec = secs % 60;
  return h > 0 ? `${h} h ${two(m)} min` : m > 0 ? `${m} min ${two(sec)} s` : `${sec} s`;
}

// --- settings ------------------------------------------------------------------------------------------------

function fillSettings(s: Status): void {
  if (ui.settingsDirty) return;
  $<HTMLInputElement>('set-port').value = String(s.settings.port);
  $<HTMLInputElement>('set-user').value = s.settings.adminUsername;
  $<HTMLInputElement>('set-pass').value = s.settings.adminPassword;
  $<HTMLInputElement>('set-autostart').checked = s.settings.autoStart;
  const fw = $<HTMLButtonElement>('allow-fw');
  fw.disabled = s.platform !== 'win32';
  fw.title = s.platform === 'win32' ? 'Adds an inbound rule for the server port (asks for administrator rights)' : 'Only available on Windows';
}

function setMessage(id: string, text: string, kind: 'ok' | 'err' | '' = ''): void {
  const el = $(id);
  el.textContent = text;
  el.className = `msg ${kind}`;
}

// --- log -----------------------------------------------------------------------------------------------------

function renderLog(): void {
  const pre = $('log');
  const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8;
  pre.textContent = ui.log.join('\n');
  $('log-count').textContent = ui.log.length ? `(${ui.log.length} lines)` : '';
  if (atBottom) pre.scrollTop = pre.scrollHeight;
}

// --- render all ----------------------------------------------------------------------------------------------

function render(): void {
  const s = ui.status;
  if (!s) return;
  $('version').textContent = s.version;
  $('datadir').textContent = s.dataDir;
  renderStatus(s);
  renderAddresses(s);
  renderLinks(s);
  renderStats(s);
  fillSettings(s);
}

function applyStatus(s: Status): void {
  ui.status = s;
  render();
}

// --- actions -------------------------------------------------------------------------------------------------

async function run(action: () => Promise<unknown>, onError?: (msg: string) => void): Promise<void> {
  try {
    await action();
  } catch (err) {
    const msg = errorMessage(err);
    if (onError) onError(msg);
    else console.error(msg);
  }
}

function markCopied(key: string): void {
  ui.copied = { key, until: Date.now() + COPIED_MS };
  refreshCopied();
  if (copiedTimer !== null) window.clearTimeout(copiedTimer);
  copiedTimer = window.setTimeout(() => {
    ui.copied = null;
    refreshCopied();
  }, COPIED_MS);
}

document.addEventListener('click', (event) => {
  const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-action]');
  if (!target) return;
  const action = target.dataset.action;
  switch (action) {
    case 'start':
      void run(() => window.oc.start());
      break;
    case 'stop':
      void run(() => window.oc.stop());
      break;
    case 'restart':
      void run(() => window.oc.restart());
      break;
    case 'use-port': {
      const port = Number(target.dataset.port);
      void run(async () => {
        const s = await window.oc.saveSettings({ port });
        applyStatus(s);
        ui.settingsDirty = false;
        fillSettings(s);
        await window.oc.restart();
      });
      break;
    }
    case 'copy': {
      const key = target.dataset.key ?? '';
      const text = target.dataset.text ?? '';
      void run(async () => {
        await window.oc.copy(text);
        markCopied(key);
      });
      break;
    }
    case 'open':
      void run(() => window.oc.openExternal(target.dataset.url ?? ''));
      break;
    case 'reveal':
      ui.revealPassword = !ui.revealPassword;
      if (ui.status) refreshReveal(ui.status);
      break;
    default:
      break;
  }
});

document.addEventListener('change', (event) => {
  const input = event.target as HTMLInputElement | null;
  if (!input) return;
  if (input.dataset.action === 'select-address' && input.checked) {
    void run(async () => applyStatus(await window.oc.selectAddress(input.value)));
  }
});

$('settings-form').addEventListener('input', () => {
  ui.settingsDirty = true;
  setMessage('settings-msg', '');
});

$('settings-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const port = Number($<HTMLInputElement>('set-port').value);
  const adminUsername = $<HTMLInputElement>('set-user').value;
  const adminPassword = $<HTMLInputElement>('set-pass').value;
  const autoStart = $<HTMLInputElement>('set-autostart').checked;
  void run(
    async () => {
      const s = await window.oc.saveSettings({ port, adminUsername, adminPassword, autoStart });
      ui.settingsDirty = false;
      applyStatus(s);
      const running = s.server.status === 'running';
      setMessage('settings-msg', running ? 'Saved. Restart the server to apply the port and login.' : 'Saved.', 'ok');
    },
    (msg) => setMessage('settings-msg', msg, 'err'),
  );
});

$('set-autostart').addEventListener('change', (event) => {
  // The toggle is saved immediately; the other fields wait for Save.
  const checked = (event.target as HTMLInputElement).checked;
  void run(
    async () => {
      const wasDirty = ui.settingsDirty;
      const s = await window.oc.saveSettings({ autoStart: checked });
      ui.settingsDirty = wasDirty;
      ui.status = s;
      render();
    },
    (msg) => setMessage('settings-msg', msg, 'err'),
  );
});

$('toggle-pass').addEventListener('click', () => {
  const input = $<HTMLInputElement>('set-pass');
  const show = input.type === 'password';
  input.type = show ? 'text' : 'password';
  const btn = $<HTMLButtonElement>('toggle-pass');
  btn.textContent = show ? 'Hide' : 'Show';
  btn.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
});

$('open-data').addEventListener('click', () => {
  void run(() => window.oc.openDataDir(), (msg) => setMessage('fw-msg', msg, 'err'));
});

$('allow-fw').addEventListener('click', () => {
  const btn = $<HTMLButtonElement>('allow-fw');
  btn.disabled = true;
  setMessage('fw-msg', 'Waiting for the administrator prompt…');
  void run(
    async () => {
      const r = await window.oc.allowFirewall();
      setMessage('fw-msg', r.message, r.ok ? 'ok' : 'err');
    },
    (msg) => setMessage('fw-msg', msg, 'err'),
  ).finally(() => {
    btn.disabled = ui.status?.platform !== 'win32';
  });
});

$('copy-log').addEventListener('click', (event) => {
  event.preventDefault(); // do not toggle the <details>
  event.stopPropagation();
  const btn = $<HTMLButtonElement>('copy-log');
  void run(async () => {
    await window.oc.copy(ui.log.join('\n'));
    btn.textContent = 'Copied';
    window.setTimeout(() => {
      btn.textContent = 'Copy log';
    }, COPIED_MS);
  });
});

// --- boot ----------------------------------------------------------------------------------------------------

window.oc.onStatus(applyStatus);
window.oc.onLog((line) => {
  ui.log.push(line);
  if (ui.log.length > 300) ui.log.splice(0, ui.log.length - 300);
  renderLog();
});

void (async () => {
  try {
    ui.log = await window.oc.getLog();
    renderLog();
    applyStatus(await window.oc.getStatus());
  } catch (err) {
    $('status').innerHTML = `<div class="status"><span class="dot"></span><div class="status-text">Cannot talk to the app: ${esc(errorMessage(err))}</div></div>`;
  }
})();

// Uptime and "since" are relative: refresh the statistics once a second between pushes.
window.setInterval(() => {
  if (ui.status?.server.status === 'running' && ui.status.stats) renderStats(ui.status);
}, 1_000);
