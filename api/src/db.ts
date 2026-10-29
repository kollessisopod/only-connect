/**
 * Database facade (docs/DESKTOP.md §3.1). The repositories only see `Queryable` / the module-level helpers
 * below; which driver answers follows `config().DATABASE_DRIVER`:
 *
 *   pg      Postgres through a `pg` pool (the compose deployment)          -> db/pg.ts
 *   pglite  embedded Postgres in WASM, data in PGLITE_DIR (the Windows app) -> db/pglite.ts
 *
 * The SQL and the migrations (api/migrations/*.sql, applied in filename order and recorded in
 * `schema_migrations`) are the same for both. The driver module is imported on first use so a deployment
 * never loads the other driver's package.
 */
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { config } from './config.js';
import type { MigrationResult } from './db/migrations.js';

export type { MigrationResult } from './db/migrations.js';

export interface QueryResult<T> {
  rows: T[];
  /** Rows affected (DML) or returned (SELECT); null when the driver did not report it. */
  rowCount: number | null;
}

export interface Queryable {
  query<T = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<QueryResult<T>>;
}

export interface Database extends Queryable {
  /** Run `fn` inside a transaction; rolls back on throw. */
  withTransaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  /** Apply api/migrations/*.sql in filename order (same files for both drivers). */
  migrate(log?: (msg: string) => void): Promise<MigrationResult>;
  close(): Promise<void>;
}

/** Kept for callers that typed a transaction client as `PoolClient`; it is the facade's `Queryable` now. */
export type PoolClient = Queryable;

let current: Promise<Database> | null = null;

async function createDatabase(): Promise<Database> {
  const c = config();
  if (c.DATABASE_DRIVER === 'pglite') {
    const { createPgliteDatabase } = await import('./db/pglite.js');
    return createPgliteDatabase({ dir: c.PGLITE_DIR as string, migrationsDir });
  }
  const { createPgDatabase } = await import('./db/pg.js');
  return createPgDatabase({ connectionString: c.DATABASE_URL as string, migrationsDir });
}

/** The process-wide database (the driver is instantiated on first use). */
export function getDatabase(): Promise<Database> {
  if (!current) {
    current = createDatabase();
    current.catch(() => {
      current = null;
    });
  }
  return current;
}

/** Run a parameterised query. */
export async function query<T = Record<string, unknown>>(text: string, params: readonly unknown[] = []): Promise<QueryResult<T>> {
  return (await getDatabase()).query<T>(text, params);
}

/** Run `fn` inside a transaction; rolls back on throw. */
export async function withTransaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
  return (await getDatabase()).withTransaction(fn);
}

/** Apply all pending migrations. Safe to call on every boot. */
export async function migrate(log: (msg: string) => void = console.log): Promise<MigrationResult> {
  return (await getDatabase()).migrate(log);
}

/** Close whichever driver is open (shutdown, tests, the embedded stop). */
export async function closeDatabase(): Promise<void> {
  if (!current) return;
  const pending = current;
  current = null;
  const db = await pending.catch(() => null);
  if (db) await db.close();
}

/** Alias kept from the Postgres-only days. */
export const closePool = closeDatabase;

let migrationsOverride: string | null = null;

/**
 * Directory holding the SQL migrations: `setMigrationsDir()` when set (the desktop bundle ships the files
 * outside the api package), else api/migrations resolved relative to this (compiled or source) file.
 */
export function migrationsDir(): string {
  return migrationsOverride ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
}

export function setMigrationsDir(dir: string | null): void {
  migrationsOverride = dir ? path.resolve(dir) : null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Block until the database answers `SELECT 1`, retrying for up to `timeoutMs` (default ~60 s). */
export async function waitForDatabase(timeoutMs = 60_000, log: (msg: string) => void = console.log): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      await query('SELECT 1');
      return;
    } catch (err) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`Database not reachable after ${timeoutMs} ms: ${(err as Error).message}`);
      }
      log(`[db] waiting for the database (attempt ${attempt}): ${(err as Error).message}`);
      await sleep(Math.min(2_000, remaining));
    }
  }
}
