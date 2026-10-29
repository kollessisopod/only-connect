import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultSettings, generateSecret, loadSettings, normalizeSettings, saveSettings, settingsPath } from '../src/main/settings';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'oc-desktop-settings-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('defaults', () => {
  it('match docs/DESKTOP.md §6.2 and generate a 48-character secret', () => {
    const s = defaultSettings();
    expect(s).toMatchObject({ port: 80, adminUsername: 'admin', adminPassword: '12346789', autoStart: true, preferredAddress: null });
    expect(s.jwtSecret).toHaveLength(48);
    expect(generateSecret()).not.toBe(generateSecret());
  });
});

describe('loadSettings', () => {
  it('creates settings.json on first run and keeps the same secret afterwards', () => {
    const first = loadSettings(dir);
    expect(first.created).toBe(true);
    expect(existsSync(settingsPath(dir))).toBe(true);
    const onDisk = JSON.parse(readFileSync(settingsPath(dir), 'utf8'));
    expect(onDisk.jwtSecret).toBe(first.settings.jwtSecret);

    const second = loadSettings(dir);
    expect(second.created).toBe(false);
    expect(second.recoveredFrom).toBeNull();
    expect(second.settings).toEqual(first.settings);
  });

  it('fills missing keys with defaults and persists the generated secret', () => {
    writeFileSync(settingsPath(dir), JSON.stringify({ port: 8089 }));
    const { settings } = loadSettings(dir);
    expect(settings.port).toBe(8089);
    expect(settings.adminUsername).toBe('admin');
    expect(settings.autoStart).toBe(true);
    expect(settings.jwtSecret).toHaveLength(48);
    const onDisk = JSON.parse(readFileSync(settingsPath(dir), 'utf8'));
    expect(onDisk.jwtSecret).toBe(settings.jwtSecret);
    expect(onDisk.port).toBe(8089);
  });

  it('replaces invalid values with defaults', () => {
    const { settings, complete } = normalizeSettings({
      port: 99999,
      adminUsername: '',
      adminPassword: 7,
      jwtSecret: 'short',
      autoStart: 'yes',
      preferredAddress: 42,
    });
    expect(complete).toBe(false);
    expect(settings.port).toBe(80);
    expect(settings.adminUsername).toBe('admin');
    expect(settings.adminPassword).toBe('12346789');
    expect(settings.jwtSecret).toHaveLength(48);
    expect(settings.autoStart).toBe(true);
    expect(settings.preferredAddress).toBeNull();
  });

  it('renames a corrupt file to settings.broken-<ts>.json and recreates it', () => {
    writeFileSync(settingsPath(dir), '{ this is not json');
    const result = loadSettings(dir);
    expect(result.created).toBe(false);
    expect(result.recoveredFrom).toMatch(/settings\.broken-\d+\.json$/);
    expect(existsSync(result.recoveredFrom!)).toBe(true);
    expect(readFileSync(result.recoveredFrom!, 'utf8')).toBe('{ this is not json');
    const fresh = JSON.parse(readFileSync(settingsPath(dir), 'utf8'));
    expect(fresh.port).toBe(80);
    expect(readdirSync(dir).filter((f) => f.startsWith('settings.broken-'))).toHaveLength(1);
  });

  it('treats a JSON array or scalar as corrupt too', () => {
    writeFileSync(settingsPath(dir), '[1,2,3]');
    expect(loadSettings(dir).recoveredFrom).not.toBeNull();
  });

  it('round-trips through saveSettings', () => {
    const s = { ...defaultSettings(), port: 8080, adminPassword: 'secret', preferredAddress: '25.1.2.3', autoStart: false };
    saveSettings(dir, s);
    expect(loadSettings(dir).settings).toEqual(s);
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toHaveLength(0);
  });
});
