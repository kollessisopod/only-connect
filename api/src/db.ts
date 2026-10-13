/**
 * Postgres access: a shared pool, a small query helper and the SQL migration runner.
 * Migrations live in api/migrations/*.sql and are applied in filename order, each in its own transaction,
 * and recorded in `schema_migrations`.
 */
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';
import { config } from './config.js';

const { Pool } = pg;
export type QueryResult<T extends pg.QueryResultRow = pg.QueryResultRow> = pg.QueryResult<T>;
export type PoolClient = pg.PoolClient;

let pool: pg.Pool | null = null;

/** The process-wide connection pool (created on first use). */
export function getPool(): pg.Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: config().DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    pool.on('error', (err) => {
      // Idle client errors (e.g. the server restarted) must not crash the process.
      console.error('[db] idle client error', err);
    });
  }
  return pool;
}

/** Run a parameterised query against the pool. */
export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
): Promise<QueryResult<T>> {
  return getPool().query<T>(text, params as unknown[]);
}

/** Run `fn` inside a transaction; rolls back on throw. */
export async function withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback failures; the original error is more useful
    }
    throw err;
  } finally {
    client.release();
  }
}

/** Close the pool (used on shutdown and in tests). */
export async function closePool(): Promise<void> {
  if (pool) {
    const p = pool;
    pool = null;
    await p.end();
  }
}

/** Directory holding the SQL migrations, resolved relative to this (compiled or source) file. */
export function migrationsDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Block until Postgres accepts connections, retrying for up to `timeoutMs` (default ~60 s). */
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
        throw new Error(`Postgres not reachable after ${timeoutMs} ms: ${(err as Error).message}`);
      }
      log(`[db] waiting for Postgres (attempt ${attempt}): ${(err as Error).message}`);
      await sleep(Math.min(2_000, remaining));
    }
  }
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

/**
 * Apply all pending migrations. Safe to call on every boot; concurrent boots are serialised with an advisory
 * lock so only one process applies a given file.
 */
export async function migrate(log: (msg: string) => void = console.log): Promise<MigrationResult> {
  await waitForDatabase(60_000, log);

  await query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);

  const dir = migrationsDir();
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const result: MigrationResult = { applied: [], skipped: [] };

  const client = await getPool().connect();
  let locked = false;
  try {
    // Cross-process lock so two API instances never race on the same migration.
    await client.query('SELECT pg_advisory_lock(727312)');
    locked = true;
    const done = new Set(
      (await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
    );
    for (const file of files) {
      if (done.has(file)) {
        result.skipped.push(file);
        continue;
      }
      const sql = await readFile(path.join(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
      result.applied.push(file);
      log(`[db] applied migration ${file}`);
    }
  } finally {
    // Session-level advisory locks survive client.release() (the connection goes back to the pool),
    // so always unlock, even when a migration failed.
    if (locked) {
      try {
        await client.query('SELECT pg_advisory_unlock(727312)');
      } catch {
        // the connection is broken; dropping it releases the lock anyway
      }
    }
    client.release();
  }
  log(`[db] migrations up to date (${result.applied.length} applied, ${result.skipped.length} already present)`);
  return result;
}
