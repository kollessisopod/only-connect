/**
 * Game persistence: the `games` table (one JSONB row per game, upserted on every mutation) plus pack loading
 * for `game:new`. The store only sees the `GamePersistence` interface so tests can inject an in-memory stub.
 */
import type { GameState, Pack } from '@only-connect/shared';
import { query } from '../db.js';
import type { PackRepository } from '../packs/repo.js';

export interface GamePersistence {
  /** The most recently updated game, or null when the table is empty. */
  loadLatest(): Promise<GameState | null>;
  /** Insert or replace the row for `state.id`. */
  save(state: GameState): Promise<void>;
  /** Full pack (questions, walls, vowel groups) or null when unknown. */
  loadPack(packId: string): Promise<Pack | null>;
}

interface GameRow {
  state: GameState;
}

export class PgGamePersistence implements GamePersistence {
  constructor(private readonly packs: PackRepository) {}

  async loadLatest(): Promise<GameState | null> {
    const res = await query<GameRow>(
      'SELECT state FROM games ORDER BY updated_at DESC, created_at DESC LIMIT 1',
    );
    const row = res.rows[0];
    if (!row || !row.state || typeof row.state !== 'object') return null;
    return row.state;
  }

  async save(state: GameState): Promise<void> {
    // `pack_id` is a nullable FK: if the pack was deleted since the game started, the sub-select yields NULL
    // instead of violating the constraint (the game keeps its own pack snapshot in `state`).
    await query(
      `INSERT INTO games (id, pack_id, state, created_at, updated_at)
       VALUES ($1, (SELECT id FROM packs WHERE id = $2::uuid), $3::jsonb, to_timestamp($4 / 1000.0), now())
       ON CONFLICT (id) DO UPDATE
         SET state = EXCLUDED.state, pack_id = EXCLUDED.pack_id, updated_at = now()`,
      [state.id, isUuid(state.packId) ? state.packId : null, JSON.stringify(state), state.createdAt],
    );
  }

  loadPack(packId: string): Promise<Pack | null> {
    if (!isUuid(packId)) return Promise.resolve(null);
    return this.packs.get(packId);
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}
