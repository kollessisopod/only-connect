/**
 * In-memory implementations of the persistence / storage interfaces so the API tests never touch Postgres
 * or MinIO.
 */
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { WALL_HIEROGLYPH_ORDER, buildDemoPack, type GameState, type Hieroglyph, type Pack } from '@only-connect/shared';
import type { Config } from '../config.js';
import type { AppDeps } from '../deps.js';
import type { GamePersistence } from '../game/persistence.js';
import { GameStore } from '../game/store.js';
import { contentIds, normalisePackInput, reassignTakenIds, type MediaRecord, type MediaRepository, type PackRepository, type StoredMedia } from '../packs/repo.js';
import type { PackInput } from '../packs/schema.js';
import type { GetObjectOptions, ObjectStore, ObjectStream, PutResult } from '../storage.js';

export const TEST_CONFIG: Config = {
  NODE_ENV: 'test',
  PORT: 3000,
  HOST: '127.0.0.1',
  LOG_LEVEL: 'silent',
  DATABASE_DRIVER: 'pg',
  DATABASE_URL: 'postgres://test:test@localhost:5432/test',
  STORAGE_DRIVER: 's3',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_REGION: 'us-east-1',
  S3_ACCESS_KEY: 'test',
  S3_SECRET_KEY: 'testtest',
  S3_BUCKET: 'media',
  ADMIN_USERNAME: 'admin',
  ADMIN_PASSWORD: '12346789',
  JWT_SECRET: 'test-secret-key',
  MAX_UPLOAD_BYTES: 25 * 1024 * 1024,
  MAX_IMPORT_BYTES: 512 * 1024 * 1024,
  ALLOWED_ORIGINS: '',
};

/**
 * The engine's demo pack (no media by default). `walls: 4` pads its two walls to four — copies with fresh
 * ids and the next free wall hieroglyphs — for 3- and 4-team games (V3.2: at least one wall per team).
 */
export function demoPack(options: { media?: boolean; walls?: 2 | 4 } = {}): Pack {
  const pack = buildDemoPack(() => randomUUID(), { media: options.media ?? false });
  while (pack.walls.length < (options.walls ?? pack.walls.length)) {
    const used = new Set(pack.walls.map((w) => w.hieroglyph));
    const hieroglyph = WALL_HIEROGLYPH_ORDER.find((h) => !used.has(h)) as Hieroglyph;
    const template = pack.walls[pack.walls.length % 2];
    pack.walls.push({ ...structuredClone(template), id: randomUUID(), position: pack.walls.length, hieroglyph });
  }
  return pack;
}

export class InMemoryPackRepository implements PackRepository {
  readonly packs = new Map<string, Pack>();

  constructor(initial: Pack[] = []) {
    for (const p of initial) this.packs.set(p.id, structuredClone(p));
  }

  async list(): Promise<Pack[]> {
    return [...this.packs.values()].map((p) => structuredClone(p)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  async count(): Promise<number> {
    return this.packs.size;
  }
  async get(id: string): Promise<Pack | null> {
    const p = this.packs.get(id);
    return p ? structuredClone(p) : null;
  }
  /** Content ids owned by packs other than `exceptId` (the Postgres tables have uuid primary keys). */
  private takenIds(exceptId: string): Set<string> {
    const taken = new Set<string>();
    for (const p of this.packs.values()) if (p.id !== exceptId) for (const cid of contentIds(p)) taken.add(cid);
    return taken;
  }
  async insert(pack: Pack): Promise<Pack> {
    if (this.packs.has(pack.id)) throw new Error('duplicate pack id');
    const stored = reassignTakenIds(structuredClone(pack), this.takenIds(pack.id));
    this.packs.set(pack.id, stored);
    return structuredClone(stored);
  }
  async replace(id: string, input: PackInput): Promise<Pack | null> {
    const existing = this.packs.get(id);
    if (!existing) return null;
    const pack = reassignTakenIds(
      normalisePackInput(id, input, { createdAt: existing.createdAt, updatedAt: new Date().toISOString() }),
      this.takenIds(id),
    );
    this.packs.set(id, structuredClone(pack));
    return structuredClone(pack);
  }
  async delete(id: string): Promise<boolean> {
    return this.packs.delete(id);
  }
}

export class InMemoryGamePersistence implements GamePersistence {
  latest: GameState | null = null;
  readonly saves: GameState[] = [];
  /** Set to make `save` reject (to test resilience). */
  failSaves = false;

  constructor(private readonly packs: PackRepository) {}

  async loadLatest(): Promise<GameState | null> {
    return this.latest ? structuredClone(this.latest) : null;
  }
  async save(state: GameState): Promise<void> {
    if (this.failSaves) throw new Error('database down');
    this.latest = structuredClone(state);
    this.saves.push(this.latest);
  }
  loadPack(packId: string): Promise<Pack | null> {
    return this.packs.get(packId);
  }
}

export class InMemoryMediaRepository implements MediaRepository {
  readonly records: Array<MediaRecord & { createdAt: string }> = [];
  async record(media: MediaRecord): Promise<void> {
    this.records.push({ ...media, createdAt: new Date().toISOString() });
  }
  async list(): Promise<StoredMedia[]> {
    return this.records.map((r) => ({ key: r.key, createdAt: r.createdAt }));
  }
  async delete(key: string): Promise<void> {
    const i = this.records.findIndex((r) => r.key === key);
    if (i >= 0) this.records.splice(i, 1);
  }
}

export class InMemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, { body: Buffer; mime: string }>();
  /** Set to make every put reject. */
  failPuts = false;

  async putObject(key: string, body: Buffer | Readable, mime: string): Promise<PutResult> {
    if (this.failPuts) throw new Error('bucket unreachable');
    const chunks: Buffer[] = [];
    if (Buffer.isBuffer(body)) chunks.push(body);
    else for await (const chunk of body) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
    const buf = Buffer.concat(chunks);
    this.objects.set(key, { body: buf, mime });
    return { key, size: buf.length };
  }

  async getObjectStream(key: string, opts: GetObjectOptions = {}): Promise<ObjectStream> {
    const obj = this.objects.get(key);
    if (!obj) {
      const err = new Error(`Object not found: ${key}`) as Error & { code: string };
      err.code = 'ENOENT';
      throw err;
    }
    let body = obj.body;
    let contentRange: string | null = null;
    if (opts.range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(opts.range);
      const total = obj.body.length;
      let start = m && m[1] ? Number(m[1]) : 0;
      let end = m && m[2] ? Number(m[2]) : total - 1;
      if (m && !m[1] && m[2]) {
        start = Math.max(0, total - Number(m[2]));
        end = total - 1;
      }
      if (start >= total || start > end) {
        const err = new Error('range') as Error & { code: string };
        err.code = 'ERANGE';
        throw err;
      }
      end = Math.min(end, total - 1);
      body = obj.body.subarray(start, end + 1);
      contentRange = `bytes ${start}-${end}/${total}`;
    }
    return { stream: Readable.from(body), mime: obj.mime, size: body.length, etag: '"stub"', lastModified: new Date(0), contentRange };
  }

  async headObject(key: string): Promise<{ mime: string; size: number | null } | null> {
    const obj = this.objects.get(key);
    return obj ? { mime: obj.mime, size: obj.body.length } : null;
  }

  async deleteObject(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

export interface TestDeps extends AppDeps {
  packs: InMemoryPackRepository;
  media: InMemoryMediaRepository;
  objects: InMemoryObjectStore;
  persistence: InMemoryGamePersistence;
}

export function createTestDeps(packs: Pack[] = [demoPack()]): TestDeps {
  const packRepo = new InMemoryPackRepository(packs);
  const persistence = new InMemoryGamePersistence(packRepo);
  const store = new GameStore(persistence);
  return { store, packs: packRepo, media: new InMemoryMediaRepository(), objects: new InMemoryObjectStore(), persistence };
}
