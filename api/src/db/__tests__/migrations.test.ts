import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrationsDir, setMigrationsDir } from '../../db.js';
import { applyPending, readMigrationFiles } from '../migrations.js';

describe('migration runner', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'oc-migrations-'));
    await writeFile(path.join(dir, '002_b.sql'), 'SELECT 2;');
    await writeFile(path.join(dir, '001_a.sql'), 'SELECT 1;');
    await writeFile(path.join(dir, 'README.md'), 'not a migration');
  });

  afterAll(async () => {
    setMigrationsDir(null);
    await rm(dir, { recursive: true, force: true });
  });

  it('reads *.sql in filename order', async () => {
    const files = await readMigrationFiles(dir);
    expect(files.map((f) => f.name)).toEqual(['001_a.sql', '002_b.sql']);
    expect(files[0].sql).toBe('SELECT 1;');
  });

  it('applies only the pending files, in order, and names a failing one', async () => {
    const files = await readMigrationFiles(dir);
    const applied: string[] = [];
    const logs: string[] = [];
    const result = await applyPending(files, new Set(['001_a.sql']), async (f) => void applied.push(f.name), (m) => logs.push(m));
    expect(result).toEqual({ applied: ['002_b.sql'], skipped: ['001_a.sql'] });
    expect(applied).toEqual(['002_b.sql']);
    expect(logs.at(-1)).toMatch(/1 applied, 1 already present/);

    await expect(
      applyPending(
        files,
        new Set(),
        async (f) => {
          if (f.name === '002_b.sql') throw new Error('boom');
        },
        () => undefined,
      ),
    ).rejects.toThrow('Migration 002_b.sql failed: boom');
  });

  it('migrationsDir() defaults to api/migrations and can be overridden', () => {
    expect(migrationsDir()).toMatch(/api[\\/]migrations$/);
    setMigrationsDir(dir);
    expect(migrationsDir()).toBe(path.resolve(dir));
    setMigrationsDir(null);
    expect(migrationsDir()).toMatch(/api[\\/]migrations$/);
  });
});
