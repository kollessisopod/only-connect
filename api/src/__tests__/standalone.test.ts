/**
 * The standalone stack (docs/DESKTOP.md §7): `createApp` + `boot` with the real PGlite and fs drivers — the
 * same code path the Windows app runs — proving that the repositories' SQL behaves on PGlite exactly as on
 * Postgres and that the API can serve the client itself. The last block starts the embedded server for
 * real on a free port.
 */
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GameState, Pack } from '@only-connect/shared';
import { loadConfig, setConfigForTests } from '../config.js';
import { closeDatabase, migrate, migrationsDir, query } from '../db.js';
import { startEmbedded, type EmbeddedServer, type EmbeddedStats } from '../embed.js';
import { PgGamePersistence } from '../game/persistence.js';
import { GameStore } from '../game/store.js';
import type { PackInput } from '../packs/schema.js';
import { CLIENT_CSP, boot, createApp } from '../server.js';
import { resetStorage } from '../storage.js';

const INDEX_HTML = '<!doctype html><html><head><meta charset="utf-8"><title>Only Connect</title></head><body><div id="root"></div></body></html>';

async function writeClient(dir: string): Promise<void> {
  await mkdir(path.join(dir, 'assets'), { recursive: true });
  await mkdir(path.join(dir, 'fonts'), { recursive: true });
  await writeFile(path.join(dir, 'index.html'), INDEX_HTML);
  await writeFile(path.join(dir, 'assets', 'app-abc123.js'), 'console.log("app")');
  await writeFile(path.join(dir, 'fonts', 'x.woff2'), Buffer.from([0, 1, 2, 3]));
  await writeFile(path.join(dir, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
}

function multipart(fieldName: string, filename: string, mime: string, data: Buffer): { body: Buffer; type: string } {
  const boundary = '----only-connect-test-boundary';
  const head = `--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`;
  return {
    body: Buffer.concat([Buffer.from(head), data, Buffer.from(`\r\n--${boundary}--\r\n`)]),
    type: `multipart/form-data; boundary=${boundary}`,
  };
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let tmp: string;
let app: FastifyInstance;
let token = '';
let demo: Pack;
const auth = () => ({ authorization: `Bearer ${token}` });

beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'oc-standalone-'));
  const clientDir = path.join(tmp, 'client');
  await writeClient(clientDir);
  setConfigForTests(
    loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_DRIVER: 'pglite',
      PGLITE_DIR: 'memory://',
      STORAGE_DRIVER: 'fs',
      MEDIA_DIR: path.join(tmp, 'media'),
      SERVE_CLIENT_DIR: clientDir,
      ADMIN_USERNAME: 'admin',
      ADMIN_PASSWORD: '12346789',
      JWT_SECRET: 'test-secret-key',
    }),
  );
  app = await createApp({ logLevel: 'silent' });
  await boot(app);
  await app.ready();
}, 60_000);

afterAll(async () => {
  await app.close().catch(() => undefined);
  await closeDatabase();
  await resetStorage();
  setConfigForTests(null);
  await rm(tmp, { recursive: true, force: true });
});

describe('PGlite database', () => {
  it('applied both migrations once and skips them on the next run', async () => {
    const rows = await query<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name');
    expect(rows.rows.map((r) => r.name)).toEqual(['001_init.sql', '002_hieroglyphs.sql']);
    expect(rows.rowCount).toBe(2);
    const again = await migrate(() => undefined);
    expect(again).toEqual({ applied: [], skipped: ['001_init.sql', '002_hieroglyphs.sql'] });
  });

  it('has the 002 constraints and the walls.hieroglyph column', async () => {
    const cols = await query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'walls' AND column_name = 'hieroglyph'",
    );
    expect(cols.rows).toHaveLength(1);
    const checks = await query<{ conname: string }>(
      "SELECT conname FROM pg_constraint WHERE conname IN ('questions_hieroglyph_check', 'walls_hieroglyph_check') ORDER BY conname",
    );
    expect(checks.rows.map((r) => r.conname)).toEqual(['questions_hieroglyph_check', 'walls_hieroglyph_check']);
  });

  it('returns pg-shaped rows: Date for timestamptz, string for count(*)::text, parsed jsonb', async () => {
    const res = await query<{ n: string; now: Date; j: unknown }>("SELECT count(*)::text AS n, now() AS now, '{\"a\":[1,2]}'::jsonb AS j FROM packs");
    expect(res.rows[0].n).toBe('1');
    expect(res.rows[0].now).toBeInstanceOf(Date);
    expect(res.rows[0].j).toEqual({ a: [1, 2] });
  });
});

describe('seeded demo pack through the real repositories', () => {
  it('logs in', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/admin/login', payload: { username: 'admin', password: '12346789' } });
    expect(res.statusCode).toBe(200);
    token = (res.json() as { token: string }).token;
  });

  it('lists the demo pack as playable', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/packs', headers: auth() });
    expect(res.statusCode).toBe(200);
    const packs = res.json() as Array<{ id: string; name: string; playable: boolean; problems: string[] }>;
    expect(packs).toHaveLength(1);
    expect(packs[0].playable, packs[0].problems.join('; ')).toBe(true);
  });

  it('loads the full pack with parsed content and ISO timestamps', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/admin/packs', headers: auth() });
    const id = (list.json() as Array<{ id: string }>)[0].id;
    const res = await app.inject({ method: 'GET', url: `/api/admin/packs/${id}`, headers: auth() });
    expect(res.statusCode).toBe(200);
    demo = res.json() as Pack;
    expect(demo.questions.length).toBeGreaterThan(0);
    expect(Array.isArray(demo.questions[0].clues)).toBe(true);
    expect(demo.questions[0].clues[0]).toMatchObject({ kind: expect.any(String), text: expect.any(String) });
    expect(demo.walls.length).toBeGreaterThanOrEqual(2);
    expect(demo.walls[0].groups).toHaveLength(4);
    expect(demo.walls.map((w) => w.hieroglyph).slice(0, 2)).toEqual(['lion', 'water']);
    expect(demo.vowelGroups[0].clues[0]).toMatchObject({ answer: expect.any(String), display: expect.any(String) });
    expect(demo.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });

  it('seeded the demo media into the fs store', async () => {
    const keys = new Set<string>();
    for (const q of demo.questions) for (const c of q.clues) if (c.media) keys.add(c.media.key);
    expect(keys.size).toBeGreaterThan(0);
    for (const key of keys) {
      const res = await app.inject({ method: 'HEAD', url: `/api/media/${key}` });
      expect(res.statusCode, key).toBe(200);
      await stat(path.join(tmp, 'media', 'objects', ...key.split('/')));
    }
  });

  it('creates, replaces (transaction + ANY(uuid[]) + jsonb) and deletes a pack', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/admin/packs', headers: auth(), payload: { name: 'Standalone pack' } });
    expect(created.statusCode).toBe(201);
    const id = (created.json() as Pack).id;

    // An editor payload copied from the demo pack: same content ids, so the repository must reassign them.
    const input: PackInput = {
      name: 'Standalone pack (edited)',
      questions: demo.questions.map((q) => ({ ...q })),
      walls: demo.walls.map((w) => ({ ...w })),
      vowelGroups: demo.vowelGroups.map((g) => ({ ...g })),
    } as unknown as PackInput;
    const replaced = await app.inject({ method: 'PUT', url: `/api/admin/packs/${id}`, headers: auth(), payload: input });
    expect(replaced.statusCode, replaced.body).toBe(200);
    const pack = replaced.json() as Pack;
    expect(pack.name).toBe('Standalone pack (edited)');
    expect(pack.questions).toHaveLength(demo.questions.length);
    const demoIds = new Set([...demo.questions, ...demo.walls, ...demo.vowelGroups].map((x) => x.id));
    for (const item of [...pack.questions, ...pack.walls, ...pack.vowelGroups]) expect(demoIds.has(item.id)).toBe(false);
    expect(pack.questions[0].clues).toEqual(demo.questions[0].clues);
    expect(pack.walls[0].groups).toEqual(demo.walls[0].groups);

    const count = await query<{ n: string }>('SELECT count(*)::text AS n FROM questions WHERE pack_id = $1', [id]);
    expect(Number(count.rows[0].n)).toBe(demo.questions.length);

    const deleted = await app.inject({ method: 'DELETE', url: `/api/admin/packs/${id}`, headers: auth() });
    expect(deleted.statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: `/api/admin/packs/${id}`, headers: auth() })).statusCode).toBe(404);
    const orphans = await query<{ n: string }>('SELECT count(*)::text AS n FROM questions WHERE pack_id = $1', [id]);
    expect(orphans.rows[0].n).toBe('0');
  });
});

describe('game persistence on PGlite', () => {
  let state: GameState;

  it('saves a new game (jsonb state, to_timestamp, upsert)', async () => {
    state = await app.deps.store.newGame(demo.id, [
      { id: 'pink', name: 'Pink' },
      { id: 'blue', name: 'Blue' },
    ]);
    const rows = await query<{ id: string; pack_id: string; created_at: Date }>('SELECT id, pack_id, created_at FROM games');
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].id).toBe(state.id);
    expect(rows.rows[0].pack_id).toBe(demo.id);
    expect(Math.abs(rows.rows[0].created_at.getTime() - state.createdAt)).toBeLessThan(1000);
  });

  it('reloads the same state through a fresh store', async () => {
    const again = new GameStore(new PgGamePersistence(app.deps.packs));
    await again.load();
    const loaded = again.getState();
    expect(loaded?.id).toBe(state.id);
    expect(loaded?.phase).toBe(state.phase);
    expect(loaded?.teams.pink.name).toBe('Pink');
    expect(loaded?.pack.id).toBe(demo.id);
  });

  it('upserts on the same id and keeps the pack_id nullable', async () => {
    await app.deps.store.dispatch({ type: 'game:setTeamName', team: 'pink', name: 'Rosa' }, { who: 'test' });
    const rows = await query<{ n: string; name: string }>("SELECT count(*)::text AS n, max(state->'teams'->'pink'->>'name') AS name FROM games");
    expect(rows.rows[0].n).toBe('1');
    expect(rows.rows[0].name).toBe('Rosa');
    expect(app.deps.store.getState()?.id).toBe(state.id);
  });
});

describe('media on the fs store through the API', () => {
  const data = Buffer.from('PNG-ish bytes 0123456789abcdef');
  let key = '';

  it('uploads', async () => {
    const { body, type } = multipart('file', 'photo.png', 'image/png', data);
    const res = await app.inject({ method: 'POST', url: '/api/admin/media', headers: { ...auth(), 'content-type': type }, payload: body });
    expect(res.statusCode, res.body).toBe(201);
    const ref = res.json() as { key: string; url: string; mime: string; name: string };
    expect(ref.key).toMatch(/^uploads\/[0-9a-f-]{36}\.png$/);
    expect(ref.mime).toBe('image/png');
    key = ref.key;
    expect((await stat(path.join(tmp, 'media', 'objects', ...key.split('/')))).size).toBe(data.length);
    const meta = JSON.parse(await readFile(path.join(tmp, 'media', 'meta', ...`${key}.json`.split('/')), 'utf8'));
    expect(meta).toMatchObject({ mime: 'image/png', size: data.length });
  });

  it('streams it back in full', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/media/${key}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.headers['content-length']).toBe(String(data.length));
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers.etag).toMatch(/^"\d+-\d+"$/);
    expect(res.headers['last-modified']).toBeTruthy();
    expect(res.rawPayload).toEqual(data);
  });

  it('honours Range headers like S3', async () => {
    const part = await app.inject({ method: 'GET', url: `/api/media/${key}`, headers: { range: 'bytes=4-9' } });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe(`bytes 4-9/${data.length}`);
    expect(part.headers['content-length']).toBe('6');
    expect(part.rawPayload).toEqual(data.subarray(4, 10));

    const tail = await app.inject({ method: 'GET', url: `/api/media/${key}`, headers: { range: 'bytes=-5' } });
    expect(tail.statusCode).toBe(206);
    expect(tail.rawPayload).toEqual(data.subarray(data.length - 5));

    const bad = await app.inject({ method: 'GET', url: `/api/media/${key}`, headers: { range: `bytes=${data.length}-` } });
    expect(bad.statusCode).toBe(416);
    expect(bad.json()).toMatchObject({ code: 'range_not_satisfiable' });
  });

  it('answers HEAD and 404s unknown or unsafe keys', async () => {
    const head = await app.inject({ method: 'HEAD', url: `/api/media/${key}` });
    expect(head.statusCode).toBe(200);
    expect(head.headers['content-length']).toBe(String(data.length));
    expect((await app.inject({ method: 'GET', url: '/api/media/uploads/missing.png' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/media/..%2F..%2Fetc%2Fpasswd' })).statusCode).toBe(404);
  });
});

describe('pack bundle round trip on pglite + fs', () => {
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(96, 7)]);
  let uploadKey = '';
  let source: Pack;
  let zip: Buffer;

  it('exports a pack with its uploaded and seed media as .only-connect.zip', async () => {
    const up = multipart('file', 'tile.png', 'image/png', png);
    const uploaded = await app.inject({ method: 'POST', url: '/api/admin/media', headers: { ...auth(), 'content-type': up.type }, payload: up.body });
    expect(uploaded.statusCode, uploaded.body).toBe(201);
    uploadKey = (uploaded.json() as { key: string }).key;

    const input = structuredClone(demo) as Pack;
    input.name = 'Bundle me';
    input.questions[0].clues[0] = { kind: 'image', text: 'pic', media: { key: uploadKey, url: `/api/media/${uploadKey}`, mime: 'image/png', name: 'tile.png' } };
    const created = await app.inject({ method: 'POST', url: '/api/admin/packs/import', headers: auth(), payload: input });
    expect(created.statusCode, created.body).toBe(201);
    source = created.json() as Pack;

    const exp = await app.inject({ method: 'GET', url: `/api/admin/packs/${source.id}/export.zip`, headers: auth() });
    expect(exp.statusCode).toBe(200);
    expect(exp.headers['content-type']).toBe('application/zip');
    expect(exp.headers['content-disposition']).toBe('attachment; filename="Bundle_me.only-connect.zip"');
    zip = exp.rawPayload;
    expect(zip.subarray(0, 4)).toEqual(Buffer.from('504b0304', 'hex'));
    expect(zip.includes(Buffer.from('manifest.json'))).toBe(true);
    expect(zip.includes(Buffer.from('pack.json'))).toBe(true);
    expect(zip.includes(Buffer.from('media.json'))).toBe(true);
    expect(zip.includes(Buffer.from(`media/${uploadKey}`))).toBe(true);
    expect(zip.includes(png)).toBe(true);
    const seedKeys = new Set<string>();
    for (const q of demo.questions) for (const c of q.clues) if (c.media) seedKeys.add(c.media.key);
    for (const key of seedKeys) expect(zip.includes(Buffer.from(`media/${key}`)), key).toBe(true);
  });

  it('imports it on the same instance: new id, same clues, every object already present', async () => {
    const form = multipart('file', 'Bundle_me.only-connect.zip', 'application/zip', zip);
    const res = await app.inject({ method: 'POST', url: '/api/admin/packs/import', headers: { ...auth(), 'content-type': form.type }, payload: form.body });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json() as { pack: Pack; imported: number; skipped: number; warnings: string[] };
    expect(body.imported).toBe(0);
    expect(body.skipped).toBeGreaterThan(1);
    expect(body.warnings).toEqual([]);
    expect(body.pack.id).not.toBe(source.id);
    expect(body.pack.name).toBe('Bundle me');
    expect(body.pack.questions.map((q) => q.clues)).toEqual(source.questions.map((q) => q.clues));
    expect(body.pack.walls.map((w) => w.groups)).toEqual(source.walls.map((w) => w.groups));
    expect(body.pack.vowelGroups.map((g) => g.clues)).toEqual(source.vowelGroups.map((g) => g.clues));
    expect((await app.inject({ method: 'DELETE', url: `/api/admin/packs/${body.pack.id}`, headers: auth() })).statusCode).toBe(204);
  });

  it('restores the uploaded media on an instance that lacks it', async () => {
    await rm(path.join(tmp, 'media', 'objects', ...uploadKey.split('/')));
    await rm(path.join(tmp, 'media', 'meta', ...`${uploadKey}.json`.split('/')));
    await query('DELETE FROM media WHERE key = $1', [uploadKey]);
    expect((await app.inject({ method: 'GET', url: `/api/media/${uploadKey}` })).statusCode).toBe(404);

    const form = multipart('file', 'bundle.zip', 'application/octet-stream', zip);
    const res = await app.inject({ method: 'POST', url: '/api/admin/packs/import', headers: { ...auth(), 'content-type': form.type }, payload: form.body });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json() as { pack: Pack; imported: number; skipped: number; warnings: string[] };
    expect(body.imported).toBe(1);
    expect(body.warnings).toEqual([]);
    expect(body.pack.questions[0].clues[0].media?.key).toBe(uploadKey);

    expect((await stat(path.join(tmp, 'media', 'objects', ...uploadKey.split('/')))).size).toBe(png.length);
    const back = await app.inject({ method: 'GET', url: `/api/media/${uploadKey}` });
    expect(back.statusCode).toBe(200);
    expect(back.headers['content-type']).toBe('image/png');
    expect(back.rawPayload).toEqual(png);
    const row = await query<{ mime: string; size: string; original_name: string }>('SELECT mime, size::text AS size, original_name FROM media WHERE key = $1', [uploadKey]);
    expect(row.rows[0]).toMatchObject({ mime: 'image/png', size: String(png.length), original_name: 'tile.png' });

    for (const id of [source.id, body.pack.id]) {
      expect((await app.inject({ method: 'DELETE', url: `/api/admin/packs/${id}`, headers: auth() })).statusCode).toBe(204);
    }
  });
});

describe('serving the client (SERVE_CLIENT_DIR)', () => {
  const securityHeaders = {
    'content-security-policy': CLIENT_CSP,
    'x-frame-options': 'DENY',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin',
    'cache-control': 'no-cache',
  };

  it('serves index.html at / with the nginx headers', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    expect(res.body).toBe(INDEX_HTML);
    expect(res.headers).toMatchObject(securityHeaders);
  });

  it('falls back to index.html for SPA routes (GET and HEAD)', async () => {
    for (const url of ['/admin', '/admin/packs/123', '/monitor', '/wall', '/button?x=1']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
      expect(res.body, url).toBe(INDEX_HTML);
      expect(res.headers, url).toMatchObject(securityHeaders);
    }
    const head = await app.inject({ method: 'HEAD', url: '/monitor' });
    expect(head.statusCode).toBe(200);
    expect(head.headers['content-type']).toMatch(/^text\/html/);
  });

  it('serves real files with the cache rules of their location', async () => {
    const asset = await app.inject({ method: 'GET', url: '/assets/app-abc123.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.body).toBe('console.log("app")');
    expect(asset.headers['cache-control']).toBe('public, max-age=604800');
    expect(asset.headers['x-content-type-options']).toBe('nosniff');
    expect(asset.headers['content-security-policy']).toBeUndefined();

    const font = await app.inject({ method: 'GET', url: '/fonts/x.woff2' });
    expect(font.statusCode).toBe(200);
    expect(font.headers['cache-control']).toBe('public, max-age=2592000, immutable');

    const icon = await app.inject({ method: 'GET', url: '/favicon.svg' });
    expect(icon.statusCode).toBe(200);
    expect(icon.headers['content-type']).toMatch(/svg/);
    expect(icon.headers['cache-control']).toBe('no-cache');
  });

  it('keeps the JSON 404 for the API and for non-GET requests', async () => {
    const api = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(api.statusCode).toBe(404);
    expect(api.json()).toMatchObject({ code: 'not_found' });
    const post = await app.inject({ method: 'POST', url: '/admin' });
    expect(post.statusCode).toBe(404);
    expect(post.json()).toMatchObject({ code: 'not_found' });
    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.json()).toEqual({ ok: true });
  });
});

describe('startEmbedded', () => {
  let dataDir: string;
  let clientDir: string;
  let port: number;
  let server: EmbeddedServer | null = null;
  const base = () => `http://127.0.0.1:${port}`;

  const options = () => ({
    port,
    host: '127.0.0.1',
    dataDir,
    clientDir,
    migrationsDir: migrationsDir(),
    adminUsername: 'admin',
    adminPassword: '12346789',
    jwtSecret: 'embedded-secret',
    logLevel: 'silent',
  });

  beforeAll(async () => {
    // The createApp stack above shares the module-level driver singletons; release them first.
    await app.close();
    await closeDatabase();
    await resetStorage();
    dataDir = path.join(tmp, 'embedded-data');
    clientDir = path.join(tmp, 'embedded-client');
    await writeClient(clientDir);
    port = await freePort();
  });

  afterAll(async () => {
    await server?.close();
  });

  it('starts on disk, serves the API and the SPA, reports empty stats', async () => {
    server = await startEmbedded(options());
    expect(server.port).toBe(port);
    expect((await stat(path.join(dataDir, 'db'))).isDirectory()).toBe(true);
    expect((await stat(path.join(dataDir, 'media', 'objects'))).isDirectory()).toBe(true);

    const health = await fetch(`${base()}/api/health`);
    expect(await health.json()).toEqual({ ok: true });
    const admin = await fetch(`${base()}/admin`);
    expect(admin.status).toBe(200);
    expect(admin.headers.get('content-security-policy')).toBe(CLIENT_CSP);
    expect(await admin.text()).toBe(INDEX_HTML);

    const stats = server.stats();
    expect(stats.startedAt).toBeGreaterThan(0);
    expect(stats.connections).toEqual({ monitor: 0, wall: 0, button: 0, other: 0, admin: 0 });
    expect(stats.players).toBe(0);
    expect(stats.game).toBeNull();
  }, 60_000);

  it('counts screens by their handshake role and fires onStatsChange (coalesced)', async () => {
    if (!server) throw new Error('no server');
    const seen: EmbeddedStats[] = [];
    const off = server.onStatsChange((s) => seen.push(s));

    // A socket.io client over long polling, by hand: open the engine.io session, then send the CONNECT
    // packet of the "/" namespace with the auth payload (`40{"screen":"monitor"}`).
    const open = await fetch(`${base()}/socket.io/?EIO=4&transport=polling&t=1`);
    const text = await open.text();
    expect(text[0]).toBe('0');
    const { sid } = JSON.parse(text.slice(1)) as { sid: string };
    const connect = await fetch(`${base()}/socket.io/?EIO=4&transport=polling&sid=${sid}`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain;charset=UTF-8' },
      body: '40{"screen":"monitor"}',
    });
    expect(await connect.text()).toBe('ok');

    await sleep(600);
    expect(server.stats().connections.monitor).toBe(1);
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen.length).toBeLessThanOrEqual(2);
    expect(seen.at(-1)?.connections.monitor).toBe(1);

    off();
    const before = seen.length;
    // Disconnect the client: the server-side socket goes away (its poll is not continued).
    await fetch(`${base()}/socket.io/?EIO=4&transport=polling&sid=${sid}`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain;charset=UTF-8' },
      body: '41',
    }).catch(() => undefined);
    await sleep(600);
    expect(server.stats().connections.monitor).toBe(0);
    expect(seen.length).toBe(before); // unsubscribed listeners are not called again
  });

  it('reports the game once one is started', async () => {
    if (!server) throw new Error('no server');
    const login = await fetch(`${base()}/api/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: '12346789' }),
    });
    const { token: jwt } = (await login.json()) as { token: string };
    const packs = await fetch(`${base()}/api/admin/packs`, { headers: { authorization: `Bearer ${jwt}` } });
    const [pack] = (await packs.json()) as Array<{ id: string; name: string }>;
    const started = await fetch(`${base()}/api/admin/actions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` },
      body: JSON.stringify({
        type: 'game:new',
        packId: pack.id,
        teams: [
          { id: 'blue', name: 'Blue' },
          { id: 'pink', name: 'Pink' },
        ],
      }),
    });
    expect(started.status, await started.text().catch(() => '')).toBeLessThan(300);
    const game = server.stats().game;
    expect(game?.pack).toBe(pack.name);
    expect(game?.phase).toBe('lobby');
    expect(game?.teams.map((t) => t.id)).toEqual(['blue', 'pink']);
    expect(game?.teams[0]).toEqual({ id: 'blue', name: 'Blue', score: 0 });
  });

  it('refuses a second server on the same port with EADDRINUSE', async () => {
    await expect(startEmbedded(options())).rejects.toMatchObject({ code: 'EADDRINUSE' });
    // The failed start must not have torn down the running one.
    expect((await fetch(`${base()}/api/health`)).status).toBe(200);
  }, 60_000);

  it('closes, frees the port and can be started again with the saved game', async () => {
    if (!server) throw new Error('no server');
    await server.close();
    server = null;
    await expect(fetch(`${base()}/api/health`)).rejects.toThrow();

    server = await startEmbedded(options());
    expect((await (await fetch(`${base()}/api/health`)).json()).ok).toBe(true);
    expect(server.stats().game?.teams.map((t) => t.id)).toEqual(['blue', 'pink']);
    expect(server.stats().connections.admin).toBe(0);
  }, 60_000);

  it('rejects bad options before touching anything', async () => {
    await expect(startEmbedded({ ...options(), port: 0 })).rejects.toMatchObject({ code: 'EINVAL' });
    await expect(startEmbedded({ ...options(), jwtSecret: 'short' })).rejects.toMatchObject({ code: 'EINVAL' });
  });
});
