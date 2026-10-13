/**
 * Server-side wall timer (SPEC §4): while a wall is `live`, a `wall:timeUp` action is scheduled for its
 * `endsAt`. The timer is re-armed on every state change (and on boot via `start()`), so a restart, a manual
 * time-up or a completed wall never leaves a stale timeout behind.
 */
import { GameError, type GameState } from '@only-connect/shared';
import type { GameStore, StoreLogger } from './store.js';

const silent: StoreLogger = { info() {}, warn() {}, error() {}, debug() {} };

export interface WallTimerOptions {
  log?: StoreLogger;
  now?: () => number;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}

/** The `endsAt` of the live wall in `state`, or null when no wall is live. */
export function liveWallEndsAt(state: GameState | null): number | null {
  if (!state || state.phase !== 'wall' || !state.wall?.current) return null;
  const play = state.wall.current;
  return play.stage === 'live' && play.endsAt !== null ? play.endsAt : null;
}

export class WallTimer {
  private handle: unknown = null;
  private armedFor: { gameId: string; endsAt: number } | null = null;
  private unsubscribe: (() => void) | null = null;
  private readonly log: StoreLogger;
  private readonly now: () => number;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;

  constructor(private readonly store: GameStore, opts: WallTimerOptions = {}) {
    this.log = opts.log ?? silent;
    this.now = opts.now ?? (() => Date.now());
    this.setTimeoutFn = opts.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimeoutFn = opts.clearTimeoutFn ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  }

  /** Follow the store and arm for the current state (call once after `store.load()`). */
  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.store.subscribe((state) => this.arm(state));
    this.arm(this.store.getState());
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.clear();
  }

  /** What the timer is currently armed for (null when idle). */
  armed(): { gameId: string; endsAt: number } | null {
    return this.armedFor;
  }

  arm(state: GameState | null): void {
    const endsAt = liveWallEndsAt(state);
    if (endsAt === null || !state) {
      this.clear();
      return;
    }
    if (this.armedFor && this.armedFor.gameId === state.id && this.armedFor.endsAt === endsAt) return;
    this.clear();
    const delay = Math.max(0, endsAt - this.now());
    this.armedFor = { gameId: state.id, endsAt };
    this.handle = this.setTimeoutFn(() => this.fire(state.id, endsAt), delay);
    this.log.info(`[timer] wall time-up armed in ${Math.round(delay / 1000)}s (game ${state.id})`);
  }

  private clear(): void {
    if (this.handle !== null) {
      this.clearTimeoutFn(this.handle);
      this.handle = null;
    }
    this.armedFor = null;
  }

  private fire(gameId: string, endsAt: number): void {
    this.handle = null;
    this.armedFor = null;
    // Only fire for the wall we armed for: anything else was re-armed or ended in the meantime.
    const current = this.store.getState();
    if (!current || current.id !== gameId || liveWallEndsAt(current) !== endsAt) return;
    this.store.dispatch({ type: 'wall:timeUp' }, { who: 'timer' }).then(
      () => this.log.info('[timer] wall time is up'),
      (err: unknown) => {
        if (err instanceof GameError) this.log.debug(`[timer] wall:timeUp ignored: ${err.message}`);
        else this.log.error(`[timer] wall:timeUp failed: ${(err as Error).message}`);
      },
    );
  }
}
