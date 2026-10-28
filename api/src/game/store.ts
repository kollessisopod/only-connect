/**
 * GameStore — the single authoritative, in-memory GameState (SPEC §4).
 *
 * Every mutation goes through `dispatch()` (or `newGame()`), which runs on a strict FIFO queue: actions are
 * applied one at a time in arrival order, persisted, then announced to listeners (sockets, timers). That queue
 * is what makes buzz races fair — the first `player:buzz` to be *received* is applied first and wins; the ones
 * behind it see a `buzzed` stage and get `GameError('too late', 'buzz_lost')`.
 *
 * The engine's `ctx.now` is the time the action was *received*, not the time the queue got round to
 * applying it, so a wall tap that arrived before `endsAt` is not rejected because an earlier action's database
 * write was slow, and `buzz.at` does not include queueing delay.
 *
 * `undo()` reverts the last admin action (the store keeps a short in-memory ring of the states that preceded
 * admin actions; player presence and the show cue are carried over so nobody is dropped and nothing replays
 * on the monitor because of an undo). The ring is not persisted: after a restart there is nothing to undo.
 *
 * Every state the store holds or hands out carries the V3.2 team fields (`activeTeams`, four team records,
 * `order` on every round state): a persisted game is run through `normalizeGameState` on load, every other
 * state comes from the engine (which writes them), and the undo ring only holds such states.
 */
import { randomInt, randomUUID } from 'node:crypto';
import {
  GameError,
  HIEROGLYPHS,
  applyAction,
  createGame,
  normalizeGameState,
  projectPublic,
  type ActionContext,
  type AdminAction,
  type GameAction,
  type GameState,
  type PublicStateMessage,
  type TeamId,
} from '@only-connect/shared';
import type { GamePersistence } from './persistence.js';

export interface StoreLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  debug(msg: string): void;
}

export interface DispatchMeta {
  /** Who sent it (for the log): "admin", "timer", a socket id, ... */
  who?: string;
}

/** `action` is the action that produced `state` (undefined for new game / load / undo). */
export type StateListener = (state: GameState, previous: GameState | null, action?: GameAction) => void;

export interface GameStoreOptions {
  now?: () => number;
  log?: StoreLogger;
  /** How many admin actions can be undone in a row (default 20). */
  undoDepth?: number;
}

const silent: StoreLogger = { info() {}, warn() {}, error() {}, debug() {} };

/**
 * Admin actions that are not undoable: host-handled ones, and the show cues (undoing a cue would replay the
 * titles on the monitor — `cue:stop` is the correction). Timer-fired actions (`q:timeUp` / `wall:timeUp`
 * with `who: 'timer'`) never enter the history either: only what the admin sent (`who === 'admin'`) does.
 */
const NOT_UNDOABLE = new Set<AdminAction['type']>(['game:new', 'game:undo', 'cue:play', 'cue:stop']);

export function isUndoableAdminAction(action: GameAction, who: string | undefined): action is AdminAction {
  if (who !== 'admin') return false;
  if (NOT_UNDOABLE.has(action.type as AdminAction['type']) || action.type.startsWith('player:')) return false;
  // `wall:select {tileId}` is the panel's tile tap (never from the admin); `wall:select {hieroglyph}` is the
  // admin choosing a wall and can be undone like any other admin action.
  if (action.type === 'wall:select' && 'tileId' in action) return false;
  return true;
}

/**
 * Why a persisted game cannot be resumed by this version of the engine, or null when it can. Games saved
 * before walls were chosen by hieroglyph (wall state keyed by team / per wall id, question state without a
 * grid, pack walls without a glyph) are left in the table but not loaded: the host starts a new game.
 */
export function incompatibleStateReason(state: GameState): string | null {
  const pack = state.pack as Partial<GameState['pack']> | undefined;
  if (!pack || !Array.isArray(pack.walls) || !Array.isArray(pack.questions)) return 'pack snapshot is missing';
  const glyphs = new Set<string>(HIEROGLYPHS);
  if (pack.walls.some((w) => !glyphs.has(w.hieroglyph as string))) return 'pack walls have no hieroglyph';
  if (pack.questions.some((q) => !glyphs.has(q.hieroglyph as string))) return 'pack questions use an unknown hieroglyph';
  for (const round of [state.question, state.suspended?.connections, state.suspended?.sequences]) {
    if (!round) continue;
    if (!Array.isArray(round.available) || typeof round.questionsTotal !== 'number') return 'question round state predates the hieroglyph grid';
  }
  for (const wall of [state.wall, state.suspended?.wall]) {
    if (!wall) continue;
    const w = wall as Partial<NonNullable<GameState['wall']>> & Record<string, unknown>;
    if ('assignment' in w || 'completed' in w || 'remaining' in w) return 'wall round state predates walls chosen by hieroglyph';
    if ((w.stage !== 'selecting' && w.stage !== 'playing') || !Array.isArray(w.available) || !Array.isArray(w.used) || typeof w.wallsTotal !== 'number') {
      return 'wall round state has an unknown shape';
    }
  }
  return null;
}

export class GameStore {
  private state: GameState | null = null;
  private loaded = false;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<StateListener>();
  private readonly now: () => number;
  private readonly log: StoreLogger;
  private readonly undoDepth: number;
  /** States that preceded admin actions, oldest first; the last entry is what `undo()` restores. */
  private history: Array<{ before: GameState; action: AdminAction }> = [];
  /** Set when the last save failed; the next successful save clears it (saves always write the full row). */
  private unsaved = false;

  constructor(private readonly persistence: GamePersistence, opts: GameStoreOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.log = opts.log ?? silent;
    this.undoDepth = opts.undoDepth ?? 20;
  }

  /** The full authoritative state, or null when no game exists. */
  getState(): GameState | null {
    return this.state;
  }

  /** Public projection for the monitor / wall / button screens. */
  getPublic(): PublicStateMessage {
    const now = this.now();
    return this.state ? projectPublic(this.state, now) : { id: null, phase: 'none', serverNow: now };
  }

  /** Register a listener called after every applied change (new game, action, reload). */
  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Load the most recent game from persistence (boot). Players are marked disconnected — nobody holds a
   * socket yet — without bumping the version, a game saved before V3.2 gets its team fields filled in
   * (`normalizeGameState`), and the normalised row is written back.
   */
  load(): Promise<GameState | null> {
    return this.enqueue(async () => {
      const stored = await this.persistence.loadLatest();
      this.loaded = true;
      if (!stored) {
        this.log.info('[store] no saved game');
        return null;
      }
      const incompatible = incompatibleStateReason(stored);
      if (incompatible) {
        this.log.warn(`[store] not resuming game ${stored.id}: ${incompatible} — start a new game`);
        return null;
      }
      const previous = this.state;
      const normalized = normalizeGameState(stored);
      const state: GameState = {
        ...normalized,
        players: (normalized.players ?? []).map((p) => (p.connected ? { ...p, connected: false } : p)),
        undoable: null,
      };
      this.history = [];
      this.state = state;
      this.log.info(`[store] loaded game ${state.id} (phase ${state.phase}, version ${state.version}, teams ${(state.activeTeams ?? []).join('/')})`);
      if (normalized !== stored) this.log.info(`[store] game ${state.id} was saved before V3.2: team fields filled in`);
      const presenceChanged = state.players.some((p, i) => p.connected !== stored.players[i]?.connected);
      if (presenceChanged || stored.undoable || normalized !== stored) await this.persist(state);
      this.notify(state, previous);
      return state;
    });
  }

  /**
   * Start a brand new game from a stored pack (SPEC §5 `game:new`): 2..4 distinct teams in the order they
   * will be listed (`activeTeams`). Rejects with the engine's `invalid_teams` / `not_enough_walls`.
   */
  newGame(packId: string, teams: ReadonlyArray<{ id: TeamId; name: string }>): Promise<GameState> {
    const receivedAt = this.now();
    return this.enqueue(async () => {
      const pack = await this.persistence.loadPack(packId);
      if (!pack) throw new GameError(`unknown pack "${packId}"`, 'unknown_pack');
      const previous = this.state;
      const state: GameState = { ...createGame(pack, teams, this.context(receivedAt)), undoable: null };
      this.history = [];
      this.state = state;
      this.log.info(`[store] new game ${state.id} from pack "${pack.name}" (${pack.id}) with ${(state.activeTeams ?? []).join('/')}`);
      await this.persist(state);
      this.notify(state, previous);
      return state;
    });
  }

  /**
   * Apply an action strictly after every action dispatched before it. Resolves with the new state or rejects
   * with the engine's GameError (the state is untouched in that case).
   */
  dispatch(action: GameAction, meta: DispatchMeta = {}): Promise<GameState> {
    return this.dispatchIf(action, null, meta);
  }

  /**
   * `dispatch`, but the action is only applied when `guard(state)` still holds for the state it is applied
   * to — checked inside the queue, not when the action was sent. The game timer uses it: a `q:timeUp` /
   * `wall:timeUp` fired for a deadline is dropped (`GameError` code `stale_deadline`) when, by the time the
   * queue reaches it, the actions received before it have already judged that question or started another
   * one, so a fired time-up can never time out the *next* question at 0 s.
   */
  dispatchIf(action: GameAction, guard: ((state: GameState) => boolean) | null, meta: DispatchMeta = {}): Promise<GameState> {
    const receivedAt = this.now();
    return this.enqueue(async () => {
      if (action.type === 'game:new') throw new GameError('use newGame() for game:new', 'invalid_action');
      if (action.type === 'game:undo') return this.applyUndo(meta);
      const previous = this.state;
      if (!previous) throw new GameError('no game in progress — start one first', 'no_game');
      if (guard && !guard(previous)) throw new GameError(`${action.type} no longer applies to the current state`, 'stale_deadline');
      const ctx = this.context(receivedAt);
      const applied = applyAction(previous, action, ctx); // throws GameError on invalid actions
      if (isUndoableAdminAction(action, meta.who)) {
        this.history.push({ before: previous, action });
        if (this.history.length > this.undoDepth) this.history.shift();
      }
      const next: GameState = { ...applied, undoable: this.undoableType() };
      this.state = next;
      const line = `[store] ${action.type} by ${meta.who ?? 'unknown'} -> v${next.version} ${next.phase}`;
      if (action.type === 'player:connected') this.log.debug(line);
      else this.log.info(line);
      await this.persist(next);
      this.notify(next, previous, action);
      return next;
    });
  }

  /** Type of the admin action `undo()` would revert, or null. */
  undoableType(): AdminAction['type'] | null {
    const last = this.history[this.history.length - 1];
    return last ? last.action.type : null;
  }

  /** Revert the last admin action (see the class comment). Queued like every other change. */
  undo(meta: DispatchMeta = {}): Promise<GameState> {
    return this.dispatch({ type: 'game:undo' }, meta);
  }

  private async applyUndo(meta: DispatchMeta): Promise<GameState> {
    const current = this.state;
    if (!current) throw new GameError('no game in progress — start one first', 'no_game');
    const entry = this.history.pop();
    if (!entry || entry.before.id !== current.id) {
      this.history = [];
      throw new GameError('nothing to undo', 'nothing_to_undo');
    }
    const next: GameState = {
      ...entry.before,
      // Presence changed since the snapshot (joins, reconnects) must survive the undo.
      players: current.players,
      removedPlayers: current.removedPlayers,
      // Show cues are not part of the game (cue:play / cue:stop are NOT_UNDOABLE): the live value stays, or
      // undoing an unrelated action would bring back a stopped cue — its old nonce reads as a new request on
      // the monitor and the opening clip replays mid-show — or cut a playing one.
      cue: current.cue ?? null,
      version: current.version + 1,
      updatedAt: this.now(),
      undoable: this.undoableType(),
    };
    this.state = next;
    this.log.info(`[store] undo ${entry.action.type} by ${meta.who ?? 'unknown'} -> v${next.version} ${next.phase}`);
    await this.persist(next);
    this.notify(next, current);
    return next;
  }

  /** Wait for everything queued so far (tests, shutdown). */
  async idle(): Promise<void> {
    await this.chain;
  }

  /** Whether `load()` has completed (used by the health/state endpoints to avoid serving before boot). */
  isLoaded(): boolean {
    return this.loaded;
  }

  private context(now: number): ActionContext {
    return { now, seed: randomInt(0, 0x7fffffff), newId: () => randomUUID() };
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /**
   * Persist the state. A failing database must not stop the show: the in-memory state stays authoritative,
   * the failure is logged and the next save (which rewrites the whole row) heals it.
   */
  private async persist(state: GameState): Promise<void> {
    try {
      await this.persistence.save(state);
      if (this.unsaved) this.log.info('[store] persistence recovered');
      this.unsaved = false;
    } catch (err) {
      this.unsaved = true;
      this.log.error(`[store] failed to save game ${state.id} v${state.version}: ${(err as Error).message}`);
    }
  }

  private notify(state: GameState, previous: GameState | null, action?: GameAction): void {
    for (const listener of this.listeners) {
      try {
        listener(state, previous, action);
      } catch (err) {
        this.log.error(`[store] listener failed: ${(err as Error).message}`);
      }
    }
  }
}
