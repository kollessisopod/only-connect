/**
 * Server-side game clock (SPEC §4): the engine stamps deadlines (`endsAt`) and this timer turns the *next*
 * one into an action at that instant — `wall:timeUp` for a live wall, `q:timeUp` for a running question clock
 * (V3). It is re-armed on every state change (and on boot via `start()`), so a restart, a manual time-up, a
 * judged question or a completed wall never leaves a stale timeout behind; a timeout that fires for a deadline
 * the state no longer has is ignored.
 */
import { GameError, questionClockRunning, type GameState } from '@only-connect/shared';
import type { GameStore, StoreLogger } from './store.js';

const silent: StoreLogger = { info() {}, warn() {}, error() {}, debug() {} };

export type DeadlineActionType = 'wall:timeUp' | 'q:timeUp';

/** What the timer is (or would be) armed for: the action to fire and the server time to fire it at. */
export interface Deadline {
  type: DeadlineActionType;
  endsAt: number;
}

export interface GameTimerOptions {
  log?: StoreLogger;
  now?: () => number;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
}
/** @deprecated name kept for server.ts / older tests; same shape as `GameTimerOptions`. */
export type WallTimerOptions = GameTimerOptions;

/** The `endsAt` of the live wall in `state`, or null when no wall is live. */
export function liveWallEndsAt(state: GameState | null): number | null {
  if (!state || state.phase !== 'wall' || !state.wall?.current) return null;
  const play = state.wall.current;
  return play.stage === 'live' && play.endsAt !== null ? play.endsAt : null;
}

/** The `endsAt` of a running question clock (stage `question`, clock set, time not up yet), or null. */
export function questionClockEndsAt(state: GameState | null): number | null {
  if (!state || (state.phase !== 'connections' && state.phase !== 'sequences') || !state.question) return null;
  const qs = state.question;
  return questionClockRunning(qs) ? (qs.endsAt ?? null) : null;
}

/**
 * The deadline the server must act on next, or null when nothing is ticking. A wall and a question clock can
 * never run at the same time (one phase at a time), so there is at most one.
 */
export function nextDeadline(state: GameState | null): Deadline | null {
  const wall = liveWallEndsAt(state);
  if (wall !== null) return { type: 'wall:timeUp', endsAt: wall };
  const question = questionClockEndsAt(state);
  if (question !== null) return { type: 'q:timeUp', endsAt: question };
  return null;
}

function sameDeadline(a: Deadline | null, b: Deadline | null): boolean {
  return a !== null && b !== null && a.type === b.type && a.endsAt === b.endsAt;
}

export class GameTimer {
  private handle: unknown = null;
  private armedFor: ({ gameId: string } & Deadline) | null = null;
  private unsubscribe: (() => void) | null = null;
  private readonly log: StoreLogger;
  private readonly now: () => number;
  private readonly setTimeoutFn: (fn: () => void, ms: number) => unknown;
  private readonly clearTimeoutFn: (handle: unknown) => void;

  constructor(private readonly store: GameStore, opts: GameTimerOptions = {}) {
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
  armed(): ({ gameId: string } & Deadline) | null {
    return this.armedFor;
  }

  arm(state: GameState | null): void {
    const deadline = nextDeadline(state);
    if (deadline === null || !state) {
      this.clear();
      return;
    }
    if (this.armedFor && this.armedFor.gameId === state.id && sameDeadline(this.armedFor, deadline)) return;
    this.clear();
    const delay = Math.max(0, deadline.endsAt - this.now());
    this.armedFor = { gameId: state.id, ...deadline };
    this.handle = this.setTimeoutFn(() => this.fire(state.id, deadline), delay);
    this.log.info(`[timer] ${deadline.type} armed in ${Math.round(delay / 1000)}s (game ${state.id})`);
  }

  private clear(): void {
    if (this.handle !== null) {
      this.clearTimeoutFn(this.handle);
      this.handle = null;
    }
    this.armedFor = null;
  }

  private fire(gameId: string, deadline: Deadline): void {
    this.handle = null;
    this.armedFor = null;
    // Only fire for the deadline we armed for: anything else was re-armed or ended in the meantime. The same
    // check runs again when the queue applies the action (`dispatchIf`): actions received before this fire
    // but still waiting behind a slow save (a judgement, `q:next`, the next `q:select`) must win over it.
    const stillDue = (state: GameState) => state.id === gameId && sameDeadline(nextDeadline(state), deadline);
    const current = this.store.getState();
    if (!current || !stillDue(current)) return;
    this.store.dispatchIf({ type: deadline.type }, stillDue, { who: 'timer' }).then(
      () => this.log.info(`[timer] ${deadline.type === 'wall:timeUp' ? 'wall' : 'question'} time is up`),
      (err: unknown) => {
        if (err instanceof GameError) this.log.debug(`[timer] ${deadline.type} ignored: ${err.message}`);
        else this.log.error(`[timer] ${deadline.type} failed: ${(err as Error).message}`);
      },
    );
  }
}

/** The pre-V3 name (the timer only knew the wall); server.ts and older code keep working. */
export { GameTimer as WallTimer };
