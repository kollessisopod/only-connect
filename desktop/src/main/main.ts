/**
 * Electron main process (docs/DESKTOP.md §6): app lifecycle, the single control window, the embedded API
 * through ServerController, and the `oc:*` IPC handlers of src/shared/ipc.ts.
 *
 * Data directory: $OC_DATA_DIR (tests) > <PORTABLE_EXECUTABLE_DIR>/OnlyConnect-data (portable exe) >
 * <userData>/OnlyConnect-data (dev, Linux smoke test).
 */
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell } from 'electron';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INVOKE_CHANNELS, PUSH_CHANNELS, type Settings, type Status } from '../shared/ipc';
import { listAddresses, pickAddress } from './addresses';
import { allowFirewall } from './firewall';
import { LogBuffer } from './logs';
import { ServerController } from './server';
import { isValidPort, loadSettings, saveSettings } from './settings';

const STATS_TICK_MS = 2_000;

const distDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const paths = {
  preload: join(distDir, 'preload', 'preload.cjs'),
  rendererHtml: join(distDir, 'renderer', 'index.html'),
  bundle: join(distDir, 'server', 'api.mjs'),
  migrationsDir: join(distDir, 'server', 'migrations'),
  clientDir: join(distDir, 'client'),
};

function resolveDataDir(): string {
  const override = process.env.OC_DATA_DIR;
  if (override && override.trim()) return resolve(override);
  const portable = process.env.PORTABLE_EXECUTABLE_DIR;
  if (portable && portable.trim()) return join(portable, 'OnlyConnect-data');
  return join(app.getPath('userData'), 'OnlyConnect-data');
}

type SettingsPatch = Partial<Omit<Settings, 'jwtSecret'>>;

/** The data directory could not be created or written: the one startup failure a host can fix themselves. */
class StartupError extends Error {
  constructor(readonly dataDir: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(`Cannot write to ${dataDir}: ${detail}\n\nMove the exe to a folder you can write to (for example Documents) and start it again.`);
    this.name = 'StartupError';
  }
}

/** Shown when main() fails before the window exists; `dialog` is only usable once the app is ready. */
function reportStartupFailure(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  if (!app.isReady()) return;
  try {
    dialog.showErrorBox('Only Connect cannot start', err instanceof StartupError ? message : `Unexpected error while starting:\n\n${message}`);
  } catch {
    // no display (headless test): the console line above is all there is
  }
}

/** The renderer is not trusted with the settings shape: every field is checked here. */
function validatePatch(input: unknown): SettingsPatch {
  if (typeof input !== 'object' || input === null) throw new Error('Invalid settings');
  const p = input as Record<string, unknown>;
  const out: SettingsPatch = {};
  if ('port' in p) {
    const port = typeof p.port === 'string' ? Number(p.port) : p.port;
    if (!isValidPort(port)) throw new Error('The port must be a whole number between 1 and 65535');
    out.port = port;
  }
  if ('adminUsername' in p) {
    if (typeof p.adminUsername !== 'string' || p.adminUsername.trim().length === 0) throw new Error('The admin username must not be empty');
    out.adminUsername = p.adminUsername.trim();
  }
  if ('adminPassword' in p) {
    if (typeof p.adminPassword !== 'string' || p.adminPassword.length === 0) throw new Error('The admin password must not be empty');
    out.adminPassword = p.adminPassword;
  }
  if ('autoStart' in p) {
    if (typeof p.autoStart !== 'boolean') throw new Error('Invalid autoStart value');
    out.autoStart = p.autoStart;
  }
  if ('preferredAddress' in p) {
    if (p.preferredAddress !== null && typeof p.preferredAddress !== 'string') throw new Error('Invalid address');
    out.preferredAddress = p.preferredAddress;
  }
  return out;
}

async function main(): Promise<void> {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.setAppUserModelId('com.onlyconnect.desktop');
  Menu.setApplicationMenu(null);

  await app.whenReady();

  const dataDir = resolveDataDir();
  // The data folder lives next to the portable exe: in C:\Program Files, on a read-only share or stick these
  // writes fail before any window exists, so the failure must be shown in a dialog (a windowed exe has no console).
  try {
    mkdirSync(dataDir, { recursive: true });
  } catch (err) {
    throw new StartupError(dataDir, err);
  }
  const log = new LogBuffer(dataDir);
  let loaded;
  try {
    loaded = loadSettings(dataDir);
  } catch (err) {
    throw new StartupError(dataDir, err);
  }
  let settings = loaded.settings;
  log.note(`Only Connect ${app.getVersion()} — data in ${dataDir}`);
  if (loaded.created) log.note('created settings.json with the default settings');
  if (loaded.recoveredFrom) log.note(`settings.json was unreadable; moved to ${loaded.recoveredFrom} and recreated`);

  const controller = new ServerController(
    { bundle: paths.bundle, migrationsDir: paths.migrationsDir, clientDir: paths.clientDir, dataDir },
    log,
  );

  const win = new BrowserWindow({
    width: 920,
    height: 680,
    minWidth: 700,
    minHeight: 520,
    title: 'Only Connect',
    backgroundColor: '#000044',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: paths.preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
    },
  });
  win.once('ready-to-show', () => win.show());
  // The window shows only our own page: no navigation, no popups.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());

  const buildStatus = (): Status => {
    const addresses = listAddresses();
    const { jwtSecret: _jwtSecret, ...visible } = settings;
    return {
      version: app.getVersion(),
      dataDir,
      platform: process.platform,
      server: controller.state,
      addresses,
      selectedAddress: pickAddress(addresses, settings.preferredAddress),
      settings: visible,
      stats: controller.stats,
    };
  };

  const pushStatus = (): void => {
    if (win.isDestroyed()) return;
    win.webContents.send(PUSH_CHANNELS.status, buildStatus());
  };
  controller.on('state', pushStatus);
  controller.on('stats', pushStatus);
  log.onLine((line) => {
    if (!win.isDestroyed()) win.webContents.send(PUSH_CHANNELS.log, line);
  });
  const ticker = setInterval(() => {
    controller.refreshStats();
    pushStatus();
  }, STATS_TICK_MS);

  ipcMain.handle(INVOKE_CHANNELS.getStatus, () => buildStatus());
  ipcMain.handle(INVOKE_CHANNELS.start, async () => {
    await controller.start(settings);
  });
  ipcMain.handle(INVOKE_CHANNELS.stop, async () => {
    await controller.stop();
  });
  ipcMain.handle(INVOKE_CHANNELS.restart, async () => {
    await controller.restart(settings);
  });
  ipcMain.handle(INVOKE_CHANNELS.saveSettings, (_event, patch: unknown) => {
    const valid = validatePatch(patch);
    settings = { ...settings, ...valid };
    saveSettings(dataDir, settings);
    log.note('settings saved');
    pushStatus();
    return buildStatus();
  });
  ipcMain.handle(INVOKE_CHANNELS.selectAddress, (_event, address: unknown) => {
    if (typeof address !== 'string' || !listAddresses().some((a) => a.address === address)) {
      throw new Error('That address is not available any more');
    }
    settings = { ...settings, preferredAddress: address };
    saveSettings(dataDir, settings);
    pushStatus();
    return buildStatus();
  });
  ipcMain.handle(INVOKE_CHANNELS.copy, (_event, text: unknown) => {
    clipboard.writeText(typeof text === 'string' ? text : '');
  });
  ipcMain.handle(INVOKE_CHANNELS.openExternal, async (_event, url: unknown) => {
    let parsed: URL;
    try {
      parsed = new URL(typeof url === 'string' ? url : '');
    } catch {
      throw new Error('Not a valid link');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Only http(s) links can be opened');
    await shell.openExternal(parsed.href);
  });
  ipcMain.handle(INVOKE_CHANNELS.openDataDir, async () => {
    const err = await shell.openPath(dataDir);
    if (err) throw new Error(err);
  });
  ipcMain.handle(INVOKE_CHANNELS.allowFirewall, async () => {
    const result = await allowFirewall(settings.port);
    log.note(`firewall: ${result.message}`);
    return result;
  });
  ipcMain.handle(INVOKE_CHANNELS.getLog, () => log.all());

  // Closing the window stops the server, then quits (no tray).
  let closing = false;
  win.on('close', (event) => {
    if (closing) return;
    event.preventDefault();
    closing = true;
    clearInterval(ticker);
    void controller.stop().finally(() => {
      if (!win.isDestroyed()) win.destroy();
      app.quit();
    });
  });
  app.on('window-all-closed', () => app.quit());
  app.on('second-instance', () => {
    if (win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });

  await win.loadFile(paths.rendererHtml);

  if (settings.autoStart) void controller.start(settings);
}

main().catch((err) => {
  reportStartupFailure(err);
  app.quit();
});
