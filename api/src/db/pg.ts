/**
 * The Postgres driver of the database facade (docs/DESKTOP.md §3.1): a `pg` pool, transactions on one
 * pooled client and the migration runner with the cross-process advisory lock.
 */
import pg from 'pg';
import type { Database, Queryable, QueryResult } from '../db.js';
import { MIGRATION_LOCK_KEY, MIGRATIONS_TABLE_SQL, applyPending, readMigrationFiles, type MigrationResult } from './migrations.js';

const { Pool } = pg;

export interface PgDatabaseOptions {
  connectionString: string;
  /** Resolved when `migrate()` runs, so `setMigrationsDir` may be called after the driver was created. */
  migrationsDir: () => string;
  /** How long `migrate()` waits for Postgres to accept connections (default 60 s). */
  connectTimeoutMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function toResult<T>(res: pg.QueryResult<pg.QueryResultRow>): QueryResult<T> {
  return { rows: res.rows as T[], rowCount: res.rowCount };
}

function wrap(client: Pick<pg.PoolClient, 'query'>): Queryable {
  return {
    async query<T>(text: string, params: readonly unknown[] = []): Promise<QueryResult<T>> {
      return toResult<T>(await client.query(text, params as unknown[]));
    },
  };
}

export function createPgDatabase(opts: PgDatabaseOptions): Database & { pool: pg.Pool } {
  const pool = new Pool({
    connectionString: opts.connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  pool.on('error', (err) => {
    // Idle client errors (e.g. the server restarted) must not crash the process.
    console.error('[db] idle client error', err);
  });

  const db: Database & { pool: pg.Pool } = {
    pool,

    async query<T>(text: string, params: readonly unknown[] = []): Promise<QueryResult<T>> {
      return toResult<T>(await pool.query(text, params as unknown[]));
    },

    async withTransaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(wrap(client));
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
    },

    async migrate(log: (msg: string) => void = console.log): Promise<MigrationResult> {
      await waitForPostgres(db, opts.connectTimeoutMs ?? 60_000, log);
      await db.query(MIGRATIONS_TABLE_SQL);
      const files = await readMigrationFiles(opts.migrationsDir());

      const client = await pool.connect();
      let locked = false;
      try {
        // Cross-process lock so two API instances never race on the same migration.
        await client.query(`SELECT pg_advisory_lock(${MIGRATION_LOCK_KEY})`);
        locked = true;
        const done = new Set((await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
        return await applyPending(
          files,
          done,
          async (file) => {
            await client.query('BEGIN');
            try {
              await client.query(file.sql);
              await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file.name]);
              await client.query('COMMIT');
            } catch (err) {
              await client.query('ROLLBACK');
              throw err;
            }
          },
          log,
        );
      } finally {
        // Session-level advisory locks survive client.release() (the connection goes back to the pool),
        // so always unlock, even when a migration failed.
        if (locked) {
          try {
            await client.query(`SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY})`);
          } catch {
            // the connection is broken; dropping it releases the lock anyway
          }
        }
        client.release();
      }
    },

    async close(): Promise<void> {
      await pool.end();
    },
  };
  return db;
}

/** Block until Postgres accepts connections, retrying for up to `timeoutMs`. */
async function waitForPostgres(db: Queryable, timeoutMs: number, log: (msg: string) => void): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      await db.query('SELECT 1');
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
