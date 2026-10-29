/**
 * The PGlite driver of the database facade (docs/DESKTOP.md §3.1): a real Postgres compiled to WASM, data in
 * a directory (or `memory://`), one session per process. The same SQL and migration files as the `pg`
 * driver; the only differences are that a migration file (several statements) goes through `exec` instead
 * of a prepared query, and that there is no advisory lock because nothing else can open the directory.
 *
 * PGlite returns rows the way `pg` does for everything this app reads: jsonb parsed, timestamptz as `Date`,
 * uuid as string, `count(*)::text` as string. `rowCount` comes from the command tag of the statement
 * (`SELECT n`, `DELETE n`, …) like `pg`'s.
 */
import { mkdir } from 'node:fs/promises';
import { PGlite, type Results } from '@electric-sql/pglite';
import type { Database, Queryable, QueryResult } from '../db.js';
import { MIGRATIONS_TABLE_SQL, applyPending, readMigrationFiles, type MigrationResult } from './migrations.js';

export interface PgliteDatabaseOptions {
  /** Directory for the data files, or `memory://`. */
  dir: string;
  /** Resolved when `migrate()` runs, so `setMigrationsDir` may be called after the driver was created. */
  migrationsDir: () => string;
}

export const PGLITE_MEMORY = 'memory://';

function toResult<T>(res: Results<T>): QueryResult<T> {
  return { rows: res.rows as T[], rowCount: typeof res.rowCount === 'number' ? res.rowCount : res.rows.length };
}

export function createPgliteDatabase(opts: PgliteDatabaseOptions): Database {
  let instance: Promise<PGlite> | null = null;

  const open = (): Promise<PGlite> => {
    if (!instance) {
      instance = (async () => {
        if (opts.dir !== PGLITE_MEMORY && !opts.dir.startsWith('memory://')) await mkdir(opts.dir, { recursive: true });
        const pg = new PGlite(opts.dir);
        await pg.waitReady;
        return pg;
      })();
      // A failed open must not poison every later call: let the next one retry.
      instance.catch(() => {
        instance = null;
      });
    }
    return instance;
  };

  const db: Database = {
    async query<T>(text: string, params: readonly unknown[] = []): Promise<QueryResult<T>> {
      const pg = await open();
      return toResult<T>(await pg.query<T>(text, params as unknown[]));
    },

    async withTransaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      const pg = await open();
      // PGlite's transaction() issues BEGIN/COMMIT itself and rolls back when the callback throws.
      return pg.transaction(async (tx) =>
        fn({
          async query<R>(text: string, params: readonly unknown[] = []): Promise<QueryResult<R>> {
            return toResult<R>(await tx.query<R>(text, params as unknown[]));
          },
        }),
      );
    },

    async migrate(log: (msg: string) => void = console.log): Promise<MigrationResult> {
      const pg = await open();
      await pg.query(MIGRATIONS_TABLE_SQL);
      const files = await readMigrationFiles(opts.migrationsDir());
      const done = new Set((await pg.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
      return applyPending(
        files,
        done,
        async (file) => {
          await pg.transaction(async (tx) => {
            await tx.exec(file.sql);
            await tx.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file.name]);
          });
        },
        log,
      );
    },

    async close(): Promise<void> {
      if (!instance) return;
      const pending = instance;
      instance = null;
      const pg = await pending.catch(() => null);
      if (pg && !pg.closed) await pg.close();
    },
  };
  return db;
}
