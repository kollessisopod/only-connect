/**
 * settings.json in the data directory (docs/DESKTOP.md §6.2). Missing keys fall back to defaults, the JWT
 * secret is generated once on first run, and a corrupt file is renamed settings.broken-<ts>.json and recreated.
 * No Electron import here: the module is unit-tested under vitest.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Settings } from '../shared/ipc';

export const SETTINGS_FILE = 'settings.json';
export const DEFAULT_PORT = 80;
export const DEFAULT_ADMIN_USERNAME = 'admin';
export const DEFAULT_ADMIN_PASSWORD = '12346789';

/** 36 random bytes → 48 url-safe characters. */
export function generateSecret(): string {
  return randomBytes(36).toString('base64url');
}

export function defaultSettings(): Settings {
  return {
    port: DEFAULT_PORT,
    adminUsername: DEFAULT_ADMIN_USERNAME,
    adminPassword: DEFAULT_ADMIN_PASSWORD,
    jwtSecret: generateSecret(),
    autoStart: true,
    preferredAddress: null,
  };
}

export function isValidPort(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 65535;
}

/**
 * Coerces whatever was read from disk into a full Settings object. `complete` is false when at least one key
 * was missing or invalid (the caller then rewrites the file so the generated secret is persisted).
 */
export function normalizeSettings(raw: unknown): { settings: Settings; complete: boolean } {
  const defaults = defaultSettings();
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { settings: defaults, complete: false };
  const r = raw as Record<string, unknown>;
  let complete = true;
  const take = <T>(ok: boolean, value: T, fallback: T): T => {
    if (ok) return value;
    complete = false;
    return fallback;
  };
  const settings: Settings = {
    port: take(isValidPort(r.port), r.port as number, defaults.port),
    adminUsername: take(typeof r.adminUsername === 'string' && r.adminUsername.trim().length > 0, r.adminUsername as string, defaults.adminUsername),
    adminPassword: take(typeof r.adminPassword === 'string' && r.adminPassword.length > 0, r.adminPassword as string, defaults.adminPassword),
    jwtSecret: take(typeof r.jwtSecret === 'string' && r.jwtSecret.length >= 8, r.jwtSecret as string, defaults.jwtSecret),
    autoStart: take(typeof r.autoStart === 'boolean', r.autoStart as boolean, defaults.autoStart),
    preferredAddress: take(
      r.preferredAddress === null || (typeof r.preferredAddress === 'string' && r.preferredAddress.length > 0),
      (r.preferredAddress ?? null) as string | null,
      defaults.preferredAddress,
    ),
  };
  return { settings, complete };
}

export interface LoadResult {
  settings: Settings;
  /** True when no settings file existed. */
  created: boolean;
  /** Name of the file the corrupt settings were moved to, when recovery happened. */
  recoveredFrom: string | null;
}

export function settingsPath(dataDir: string): string {
  return join(dataDir, SETTINGS_FILE);
}

/** Writes atomically (temp file in the same directory, then rename). */
export function saveSettings(dataDir: string, settings: Settings): void {
  mkdirSync(dataDir, { recursive: true });
  const file = settingsPath(dataDir);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  renameSync(tmp, file);
}

export function loadSettings(dataDir: string): LoadResult {
  mkdirSync(dataDir, { recursive: true });
  const file = settingsPath(dataDir);
  if (!existsSync(file)) {
    const settings = defaultSettings();
    saveSettings(dataDir, settings);
    return { settings, created: true, recoveredFrom: null };
  }
  let parsed: unknown;
  let corrupt = false;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) corrupt = true;
  } catch {
    corrupt = true;
  }
  if (corrupt) {
    const broken = join(dataDir, `settings.broken-${Date.now()}.json`);
    renameSync(file, broken);
    const settings = defaultSettings();
    saveSettings(dataDir, settings);
    return { settings, created: false, recoveredFrom: broken };
  }
  const { settings, complete } = normalizeSettings(parsed);
  if (!complete) saveSettings(dataDir, settings);
  return { settings, created: false, recoveredFrom: null };
}
