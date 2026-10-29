/**
 * The part of the migration runner both database drivers share (docs/DESKTOP.md §3.1): reading
 * api/migrations/*.sql in filename order and deciding which files are still pending. Applying a file is
 * driver-specific (Postgres takes an advisory lock and runs the file on one pooled connection; PGlite is a
 * single session and uses `exec`), so the drivers pass an `applyOne` callback that must run the SQL and
 * record the file in `schema_migrations` inside one transaction.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export interface MigrationFile {
  name: string;
  sql: string;
}

/** Cross-process advisory lock key used by the Postgres driver. */
export const MIGRATION_LOCK_KEY = 727312;

export const MIGRATIONS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`;

/** Every `*.sql` file of `dir`, sorted by name, with its contents. */
export async function readMigrationFiles(dir: string): Promise<MigrationFile[]> {
  const names = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const files: MigrationFile[] = [];
  for (const name of names) files.push({ name, sql: await readFile(path.join(dir, name), 'utf8') });
  return files;
}

/**
 * Apply the files not yet listed in `done` through `applyOne`, in order. A failing file stops the run with
 * an error naming it; the files applied before it stay applied (each is its own transaction).
 */
export async function applyPending(
  files: readonly MigrationFile[],
  done: ReadonlySet<string>,
  applyOne: (file: MigrationFile) => Promise<void>,
  log: (msg: string) => void,
): Promise<MigrationResult> {
  const result: MigrationResult = { applied: [], skipped: [] };
  for (const file of files) {
    if (done.has(file.name)) {
      result.skipped.push(file.name);
      continue;
    }
    try {
      await applyOne(file);
    } catch (err) {
      throw new Error(`Migration ${file.name} failed: ${(err as Error).message}`);
    }
    result.applied.push(file.name);
    log(`[db] applied migration ${file.name}`);
  }
  log(`[db] migrations up to date (${result.applied.length} applied, ${result.skipped.length} already present)`);
  return result;
}
