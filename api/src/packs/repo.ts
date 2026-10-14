/**
 * Pack persistence: maps `Pack` <-> the packs / questions / walls / vowel_groups tables (SPEC §6).
 *
 * `PackRepository` is the interface the routes, the store and the seeder depend on; `PgPackRepository` is the
 * Postgres implementation. A PUT is a full replace inside one transaction.
 */
import { randomUUID } from 'node:crypto';
import {
  nextWallHieroglyph,
  validatePack,
  type Clue,
  type Hieroglyph,
  type Pack,
  type PackSummary,
  type Question,
  type VowelGroup,
  type Wall,
} from '@only-connect/shared';
import { query, withTransaction, type PoolClient } from '../db.js';
import type { PackInput } from './schema.js';

export interface PackRepository {
  /** All packs with their full content, oldest first. */
  list(): Promise<Pack[]>;
  count(): Promise<number>;
  get(id: string): Promise<Pack | null>;
  /** Insert a complete pack (ids must be uuids; used by create, duplicate and the seeder). */
  insert(pack: Pack): Promise<Pack>;
  /** Replace name and all content of an existing pack. Returns null when the pack does not exist. */
  replace(id: string, input: PackInput): Promise<Pack | null>;
  /** Returns false when nothing was deleted. */
  delete(id: string): Promise<boolean>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

function uuidOrNew(value: unknown): string {
  return isUuid(value) ? value.toLowerCase() : randomUUID();
}

// ---------------------------------------------------------------------------
// Normalisation: PackInput (editor payload) -> Pack (what the engine sees)
// ---------------------------------------------------------------------------

function normaliseClue(input: PackInput['questions'][number]['clues'][number]): Clue {
  const text = typeof input.text === 'string' ? input.text : '';
  if (input.kind === 'text' || !input.media) return { kind: input.kind, text };
  return {
    kind: input.kind,
    text,
    media: { key: input.media.key, url: input.media.url, mime: input.media.mime, name: input.media.name },
  };
}

/**
 * Stable order of a list of items by their `position` (items without an integer position keep their payload
 * order, after the positioned ones), used to renumber positions `0..n-1` on save.
 */
function byPosition<T extends { position?: unknown }>(items: readonly T[]): T[] {
  const pos = (item: T): number => (Number.isInteger(item.position) ? (item.position as number) : Number.MAX_SAFE_INTEGER);
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => pos(a.item) - pos(b.item) || a.index - b.index)
    .map((x) => x.item);
}

/**
 * Builds the stored `Pack` from an editor payload: fresh uuids where needed, positions renumbered `0..n-1`
 * (per round for questions, per pack for walls and vowel groups) in the payload's order, walls without a
 * hieroglyph given the first free one (lion, water, then the rest; see `nextWallHieroglyph`).
 */
export function normalisePackInput(id: string, input: PackInput, timestamps: { createdAt: string; updatedAt: string }): Pack {
  const questions: Question[] = [];
  for (const round of ['connections', 'sequences'] as const) {
    byPosition(input.questions.filter((q) => q.round === round)).forEach((q, position) => {
      const out: Question = {
        id: uuidOrNew(q.id),
        round,
        hieroglyph: q.hieroglyph,
        position,
        clues: q.clues.map(normaliseClue),
        answer: q.answer ?? '',
      };
      if (typeof q.note === 'string' && q.note.trim().length > 0) out.note = q.note;
      questions.push(out);
    });
  }
  // Explicit glyphs are kept as sent (the engine's validatePack reports duplicates); walls without one take
  // the first glyph no other wall of the payload uses.
  const walls: Wall[] = [];
  const taken: Array<{ hieroglyph: Hieroglyph }> = input.walls.flatMap((w) => (w.hieroglyph ? [{ hieroglyph: w.hieroglyph }] : []));
  byPosition(input.walls).forEach((w, position) => {
    let hieroglyph = w.hieroglyph ?? null;
    if (!hieroglyph) {
      hieroglyph = nextWallHieroglyph(taken) ?? 'lion';
      taken.push({ hieroglyph });
    }
    walls.push({
      id: uuidOrNew(w.id),
      position,
      hieroglyph,
      groups: w.groups.map((g) => ({ connection: g.connection ?? '', clues: [...g.clues] })),
    });
  });
  const vowelGroups: VowelGroup[] = byPosition(input.vowelGroups).map((g, position) => ({
    id: uuidOrNew(g.id),
    position,
    category: g.category ?? '',
    clues: g.clues.map((c) => ({ answer: c.answer ?? '', display: c.display ?? '' })),
  }));
  return {
    id,
    name: input.name.trim(),
    questions,
    walls,
    vowelGroups,
    createdAt: timestamps.createdAt,
    updatedAt: timestamps.updatedAt,
  };
}

/**
 * Ids of every question / wall / vowel group in a pack (the three content tables each have a uuid primary
 * key, so an id copied from another pack, or repeated inside the payload, would violate it).
 */
export function contentIds(pack: Pick<Pack, 'questions' | 'walls' | 'vowelGroups'>): string[] {
  return [...pack.questions.map((q) => q.id), ...pack.walls.map((w) => w.id), ...pack.vowelGroups.map((g) => g.id)];
}

/**
 * Give a fresh uuid to every content item whose id is `taken` (belongs to another pack) or already used by
 * an earlier item of the same pack, so an editor payload that was copied from another pack (or that repeats
 * an id) can still be saved. Ids that are free are kept, so the editor's references stay stable.
 */
export function reassignTakenIds(pack: Pack, taken: ReadonlySet<string>, newId: () => string = randomUUID): Pack {
  const used = new Set<string>();
  const fresh = (id: string): string => {
    let next = id;
    while (taken.has(next) || used.has(next)) next = newId();
    used.add(next);
    return next;
  };
  return {
    ...pack,
    questions: pack.questions.map((q) => ({ ...q, id: fresh(q.id) })),
    walls: pack.walls.map((w) => ({ ...w, id: fresh(w.id) })),
    vowelGroups: pack.vowelGroups.map((g) => ({ ...g, id: fresh(g.id) })),
  };
}

/** `PackSummary` for the list endpoint (playable + problems from the engine). */
export function toSummary(pack: Pack): PackSummary {
  const problems = validatePack(pack);
  return {
    id: pack.id,
    name: pack.name,
    playable: problems.length === 0,
    problems,
    createdAt: pack.createdAt,
    updatedAt: pack.updatedAt,
  };
}

/** A deep copy with brand new ids and a "(copy)" name. */
export function clonePack(pack: Pack, now: string): Pack {
  const copyClue = (c: Clue): Clue => (c.media ? { kind: c.kind, text: c.text, media: { ...c.media } } : { kind: c.kind, text: c.text });
  return {
    id: randomUUID(),
    name: `${pack.name} (copy)`,
    questions: pack.questions.map((q) => ({ ...q, id: randomUUID(), clues: q.clues.map(copyClue) })),
    walls: pack.walls.map((w) => ({ ...w, id: randomUUID(), groups: w.groups.map((g) => ({ ...g, clues: [...g.clues] })) })),
    vowelGroups: pack.vowelGroups.map((g) => ({ ...g, id: randomUUID(), clues: g.clues.map((c) => ({ ...c })) })),
    createdAt: now,
    updatedAt: now,
  };
}

/** An empty pack shell for `POST /api/admin/packs`. */
export function emptyPack(name: string, now: string): Pack {
  return { id: randomUUID(), name: name.trim(), questions: [], walls: [], vowelGroups: [], createdAt: now, updatedAt: now };
}

// ---------------------------------------------------------------------------
// Postgres implementation
// ---------------------------------------------------------------------------

interface PackRow {
  id: string;
  name: string;
  created_at: Date;
  updated_at: Date;
}
interface QuestionRow {
  id: string;
  pack_id: string;
  round: Question['round'];
  hieroglyph: Question['hieroglyph'];
  position: number;
  clues: Clue[];
  answer: string;
  note: string | null;
}
interface WallRow {
  id: string;
  pack_id: string;
  position: number;
  hieroglyph: Wall['hieroglyph'];
  groups: Wall['groups'];
}
interface VowelGroupRow {
  id: string;
  pack_id: string;
  position: number;
  category: string;
  clues: VowelGroup['clues'];
}

type Queryable = Pick<PoolClient, 'query'>;

function iso(d: Date | string): string {
  return d instanceof Date ? d.toISOString() : new Date(d).toISOString();
}

function stripUndefined<T extends object>(obj: T): T {
  return JSON.parse(JSON.stringify(obj)) as T;
}

async function loadContent(db: Queryable, packIds: string[]): Promise<Map<string, Pick<Pack, 'questions' | 'walls' | 'vowelGroups'>>> {
  const out = new Map<string, Pick<Pack, 'questions' | 'walls' | 'vowelGroups'>>();
  for (const id of packIds) out.set(id, { questions: [], walls: [], vowelGroups: [] });
  if (packIds.length === 0) return out;
  const [qs, ws, vs] = await Promise.all([
    db.query<QuestionRow>(
      'SELECT id, pack_id, round, hieroglyph, position, clues, answer, note FROM questions WHERE pack_id = ANY($1::uuid[]) ORDER BY round, position, id',
      [packIds],
    ),
    db.query<WallRow>('SELECT id, pack_id, position, hieroglyph, groups FROM walls WHERE pack_id = ANY($1::uuid[]) ORDER BY position, id', [packIds]),
    db.query<VowelGroupRow>(
      'SELECT id, pack_id, position, category, clues FROM vowel_groups WHERE pack_id = ANY($1::uuid[]) ORDER BY position, id',
      [packIds],
    ),
  ]);
  for (const r of qs.rows) {
    const q: Question = { id: r.id, round: r.round, hieroglyph: r.hieroglyph, position: r.position, clues: Array.isArray(r.clues) ? r.clues : [], answer: r.answer };
    if (r.note) q.note = r.note;
    out.get(r.pack_id)?.questions.push(q);
  }
  for (const r of ws.rows) {
    out.get(r.pack_id)?.walls.push({ id: r.id, position: r.position, hieroglyph: r.hieroglyph, groups: Array.isArray(r.groups) ? r.groups : [] });
  }
  for (const r of vs.rows) {
    out.get(r.pack_id)?.vowelGroups.push({ id: r.id, position: r.position, category: r.category, clues: Array.isArray(r.clues) ? r.clues : [] });
  }
  return out;
}

/** Content ids of `pack` that already exist in the tables (rows of other packs; call after this pack's rows are gone). */
async function takenContentIds(db: Queryable, pack: Pack): Promise<Set<string>> {
  const ids = contentIds(pack);
  const taken = new Set<string>();
  if (ids.length === 0) return taken;
  for (const table of ['questions', 'walls', 'vowel_groups'] as const) {
    const res = await db.query<{ id: string }>(`SELECT id FROM ${table} WHERE id = ANY($1::uuid[])`, [ids]);
    for (const r of res.rows) taken.add(r.id);
  }
  return taken;
}

async function insertContent(db: Queryable, pack: Pack): Promise<void> {
  for (const q of pack.questions) {
    await db.query(
      `INSERT INTO questions (id, pack_id, round, hieroglyph, position, clues, answer, note)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`,
      [q.id, pack.id, q.round, q.hieroglyph, q.position, JSON.stringify(q.clues), q.answer, q.note ?? null],
    );
  }
  for (const w of pack.walls) {
    await db.query('INSERT INTO walls (id, pack_id, position, hieroglyph, groups) VALUES ($1, $2, $3, $4, $5::jsonb)', [
      w.id,
      pack.id,
      w.position,
      w.hieroglyph,
      JSON.stringify(w.groups),
    ]);
  }
  for (const g of pack.vowelGroups) {
    await db.query('INSERT INTO vowel_groups (id, pack_id, position, category, clues) VALUES ($1, $2, $3, $4, $5::jsonb)', [
      g.id,
      pack.id,
      g.position,
      g.category,
      JSON.stringify(g.clues),
    ]);
  }
}

export class PgPackRepository implements PackRepository {
  async list(): Promise<Pack[]> {
    const packs = await query<PackRow>('SELECT id, name, created_at, updated_at FROM packs ORDER BY created_at ASC, id');
    const content = await loadContent({ query } as Queryable, packs.rows.map((p) => p.id));
    return packs.rows.map((p) => ({
      id: p.id,
      name: p.name,
      ...(content.get(p.id) ?? { questions: [], walls: [], vowelGroups: [] }),
      createdAt: iso(p.created_at),
      updatedAt: iso(p.updated_at),
    }));
  }

  async count(): Promise<number> {
    const res = await query<{ n: string }>('SELECT count(*)::text AS n FROM packs');
    return Number(res.rows[0]?.n ?? 0);
  }

  async get(id: string): Promise<Pack | null> {
    if (!isUuid(id)) return null;
    const res = await query<PackRow>('SELECT id, name, created_at, updated_at FROM packs WHERE id = $1', [id]);
    const row = res.rows[0];
    if (!row) return null;
    const content = (await loadContent({ query } as Queryable, [row.id])).get(row.id);
    return {
      id: row.id,
      name: row.name,
      ...(content ?? { questions: [], walls: [], vowelGroups: [] }),
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    };
  }

  async insert(pack: Pack): Promise<Pack> {
    const clean = stripUndefined(pack);
    await withTransaction(async (client) => {
      await client.query('INSERT INTO packs (id, name, created_at, updated_at) VALUES ($1, $2, $3, $4)', [
        clean.id,
        clean.name,
        clean.createdAt,
        clean.updatedAt,
      ]);
      await insertContent(client, reassignTakenIds(clean, await takenContentIds(client, clean)));
    });
    const stored = await this.get(clean.id);
    if (!stored) throw new Error(`pack ${clean.id} vanished after insert`);
    return stored;
  }

  async replace(id: string, input: PackInput): Promise<Pack | null> {
    if (!isUuid(id)) return null;
    const replaced = await withTransaction(async (client) => {
      const existing = await client.query<PackRow>('SELECT id, name, created_at, updated_at FROM packs WHERE id = $1 FOR UPDATE', [id]);
      const row = existing.rows[0];
      if (!row) return false;
      const now = new Date().toISOString();
      const pack = stripUndefined(normalisePackInput(id, input, { createdAt: iso(row.created_at), updatedAt: now }));
      await client.query('UPDATE packs SET name = $2, updated_at = $3 WHERE id = $1', [id, pack.name, now]);
      await client.query('DELETE FROM questions WHERE pack_id = $1', [id]);
      await client.query('DELETE FROM walls WHERE pack_id = $1', [id]);
      await client.query('DELETE FROM vowel_groups WHERE pack_id = $1', [id]);
      // Ids copied from another pack (e.g. an editor payload built from the demo pack) would collide with
      // that pack's rows: give those items fresh ids instead of failing the whole save.
      await insertContent(client, reassignTakenIds(pack, await takenContentIds(client, pack)));
      return true;
    });
    return replaced ? this.get(id) : null;
  }

  async delete(id: string): Promise<boolean> {
    if (!isUuid(id)) return false;
    const res = await query('DELETE FROM packs WHERE id = $1', [id]);
    return (res.rowCount ?? 0) > 0;
  }
}

/** Record an uploaded object in the `media` table (idempotent on key). */
export interface MediaRecord {
  key: string;
  mime: string;
  size: number;
  originalName: string;
}

export interface StoredMedia {
  key: string;
  createdAt: string;
}

export interface MediaRepository {
  record(media: MediaRecord): Promise<void>;
  /** Every recorded object key (uploads and seeded demo media alike). */
  list(): Promise<StoredMedia[]>;
  /** Forget a key (no error when unknown). */
  delete(key: string): Promise<void>;
}

/** Object keys referenced by a pack's clues (images / audio). */
export function mediaKeysOf(pack: Pick<Pack, 'questions'>): Set<string> {
  const keys = new Set<string>();
  for (const q of pack.questions) for (const c of q.clues ?? []) if (c.media?.key) keys.add(c.media.key);
  return keys;
}

export class PgMediaRepository implements MediaRepository {
  async record(media: MediaRecord): Promise<void> {
    await query(
      `INSERT INTO media (key, mime, size, original_name) VALUES ($1, $2, $3, $4)
       ON CONFLICT (key) DO UPDATE SET mime = EXCLUDED.mime, size = EXCLUDED.size, original_name = EXCLUDED.original_name`,
      [media.key, media.mime, media.size, media.originalName],
    );
  }

  async list(): Promise<StoredMedia[]> {
    const res = await query<{ key: string; created_at: Date | string }>('SELECT key, created_at FROM media ORDER BY created_at ASC, key');
    return res.rows.map((r) => ({ key: r.key, createdAt: iso(r.created_at) }));
  }

  async delete(key: string): Promise<void> {
    await query('DELETE FROM media WHERE key = $1', [key]);
  }
}
