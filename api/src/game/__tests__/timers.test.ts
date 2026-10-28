import { describe, expect, it } from 'vitest';
import { QUESTION_INTRO_MS, QUESTION_SECONDS, WALL_SECONDS } from '@only-connect/shared';
import { GameStore } from '../store.js';
import { GameTimer, WallTimer, liveWallEndsAt, nextDeadline, questionClockEndsAt } from '../timers.js';
import { InMemoryGamePersistence, InMemoryPackRepository, demoPack } from '../../__tests__/stubs.js';

const TEAMS = [{ id: 'pink' as const, name: 'Pink' }, { id: 'blue' as const, name: 'Blue' }];

function fakeClock(start = 1_700_000_000_000) {
  let now = start;
  const timeouts = new Map<number, { fn: () => void; at: number }>();
  let seq = 0;
  return {
    now: () => now,
    advance(ms: number) {
      now += ms;
      for (const [id, t] of [...timeouts]) {
        if (t.at <= now) {
          timeouts.delete(id);
          t.fn();
        }
      }
    },
    setTimeoutFn: (fn: () => void, ms: number) => {
      const id = ++seq;
      timeouts.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimeoutFn: (h: unknown) => {
      timeouts.delete(h as number);
    },
    pending: () => timeouts.size,
  };
}

async function liveWall() {
  const pack = demoPack();
  const packs = new InMemoryPackRepository([pack]);
  const persistence = new InMemoryGamePersistence(packs);
  const clock = fakeClock();
  const store = new GameStore(persistence, { now: clock.now });
  await store.newGame(pack.id, TEAMS);
  await store.dispatch({ type: 'round:start', round: 'wall' });
  await store.dispatch({ type: 'wall:select', hieroglyph: 'lion' });
  return { store, clock, persistence, packs };
}

describe('WallTimer', () => {
  it('arms at wall:start, fires wall:timeUp at endsAt and disarms afterwards', async () => {
    const { store, clock } = await liveWall();
    const timer = new WallTimer(store, { now: clock.now, setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn });
    timer.start();
    expect(timer.armed()).toBeNull();

    await store.dispatch({ type: 'wall:start' });
    const endsAt = liveWallEndsAt(store.getState());
    expect(endsAt).toBe(clock.now() + WALL_SECONDS * 1000);
    expect(timer.armed()).toEqual({ gameId: store.getState()?.id, type: 'wall:timeUp', endsAt });
    expect(clock.pending()).toBe(1);

    clock.advance(WALL_SECONDS * 1000 - 1);
    expect(store.getState()?.wall?.current?.stage).toBe('live');
    clock.advance(1);
    await store.idle();
    expect(store.getState()?.wall?.current).toMatchObject({ stage: 'frozen', endReason: 'time' });
    expect(timer.armed()).toBeNull();
    expect(clock.pending()).toBe(0);
  });

  it('is cleared when the wall ends early and ignores stale timeouts', async () => {
    const { store, clock } = await liveWall();
    const timer = new WallTimer(store, { now: clock.now, setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn });
    timer.start();
    await store.dispatch({ type: 'wall:start' });
    expect(clock.pending()).toBe(1);
    await store.dispatch({ type: 'wall:timeUp' }); // admin forces time-up
    expect(timer.armed()).toBeNull();
    expect(clock.pending()).toBe(0);
    const version = store.getState()?.version;
    clock.advance(WALL_SECONDS * 1000 + 10);
    await store.idle();
    expect(store.getState()?.version).toBe(version);
  });

  it('re-arms on boot for a wall that is live in the loaded state', async () => {
    const { store, clock, persistence } = await liveWall();
    await store.dispatch({ type: 'wall:start' });
    clock.advance(60_000);

    const restarted = new GameStore(persistence, { now: clock.now });
    await restarted.load();
    const timer = new WallTimer(restarted, { now: clock.now, setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn });
    timer.start();
    expect(timer.armed()?.endsAt).toBe(liveWallEndsAt(restarted.getState()));
    clock.advance(WALL_SECONDS * 1000 - 60_000);
    await restarted.idle();
    expect(restarted.getState()?.wall?.current).toMatchObject({ stage: 'frozen', endReason: 'time' });
    timer.stop();
  });

  it('fires immediately when the deadline already passed while the server was down', async () => {
    const { store, clock, persistence } = await liveWall();
    await store.dispatch({ type: 'wall:start' });
    clock.advance(WALL_SECONDS * 1000 + 5_000);
    const restarted = new GameStore(persistence, { now: clock.now });
    await restarted.load();
    const timer = new WallTimer(restarted, { now: clock.now, setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn });
    timer.start();
    clock.advance(0);
    await restarted.idle();
    expect(restarted.getState()?.wall?.current).toMatchObject({ stage: 'frozen', endReason: 'time' });
  });
});

async function questionRound() {
  const pack = demoPack();
  const packs = new InMemoryPackRepository([pack]);
  const persistence = new InMemoryGamePersistence(packs);
  const clock = fakeClock();
  const store = new GameStore(persistence, { now: clock.now });
  await store.newGame(pack.id, TEAMS);
  await store.dispatch({ type: 'round:start', round: 'connections' });
  const timer = new GameTimer(store, { now: clock.now, setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn });
  timer.start();
  return { store, clock, persistence, timer };
}

/**
 * The question deadline is the pick time plus the intro (V3.1, `QUESTION_INTRO_MS`: the clock starts after
 * the glyph-pulse / whoosh / clue-in-slot intro) plus the 40 s; the timer is armed from the pick itself.
 */
const QUESTION_DEADLINE_MS = QUESTION_INTRO_MS + QUESTION_SECONDS * 1000;

describe('GameTimer — question clock (V3)', () => {
  it('is the same class as WallTimer', () => {
    expect(WallTimer).toBe(GameTimer);
  });

  it('arms at q:select for T + 5300 + 40000, fires q:timeUp at endsAt (not undoable) and disarms afterwards', async () => {
    const { store, clock, timer } = await questionRound();
    expect(timer.armed()).toBeNull();
    expect(nextDeadline(store.getState())).toBeNull();

    const pickedAt = clock.now();
    await store.dispatch({ type: 'q:select', hieroglyph: 'lion' }, { who: 'admin' });
    const endsAt = questionClockEndsAt(store.getState());
    expect(QUESTION_DEADLINE_MS).toBe(45_300);
    expect(endsAt).toBe(pickedAt + 5300 + 40_000);
    expect(store.getState()?.question?.startedAt).toBe(pickedAt + 5300);
    expect(nextDeadline(store.getState())).toEqual({ type: 'q:timeUp', endsAt });
    expect(timer.armed()).toEqual({ gameId: store.getState()?.id, type: 'q:timeUp', endsAt });
    expect(clock.pending()).toBe(1);

    // Nothing fires during the intro nor during the 40 s; the deadline is the last millisecond.
    clock.advance(QUESTION_INTRO_MS);
    expect(store.getState()?.question?.timeUp).toBe(false);
    clock.advance(QUESTION_SECONDS * 1000 - 1);
    expect(store.getState()?.question?.timeUp).toBe(false);
    clock.advance(1);
    await store.idle();
    expect(store.getState()?.question).toMatchObject({ stage: 'question', timeUp: true, endsAt });
    expect(store.getState()?.undoable).toBe('q:select'); // the timer's action never enters the undo history
    expect(timer.armed()).toBeNull();
    expect(clock.pending()).toBe(0);
    expect(questionClockEndsAt(store.getState())).toBeNull();
    // Reveals are refused; judging works and leaves nothing armed.
    await expect(store.dispatch({ type: 'q:reveal' })).rejects.toMatchObject({ code: 'question_time_up' });
    await store.dispatch({ type: 'q:correct' });
    expect(timer.armed()).toBeNull();
  });

  it('is cleared by a judgement before the deadline, ignores the stale timeout and re-arms for the next question', async () => {
    const { store, clock, timer } = await questionRound();
    await store.dispatch({ type: 'q:select', hieroglyph: 'lion' });
    expect(clock.pending()).toBe(1);
    clock.advance(10_000);
    await store.dispatch({ type: 'q:reveal' });
    expect(timer.armed()?.type).toBe('q:timeUp'); // a reveal does not touch the clock
    expect(clock.pending()).toBe(1);
    await store.dispatch({ type: 'q:incorrect' });
    expect(timer.armed()).toBeNull(); // the steal has no clock
    expect(clock.pending()).toBe(0);
    const version = store.getState()?.version;
    clock.advance(QUESTION_DEADLINE_MS);
    await store.idle();
    expect(store.getState()?.version).toBe(version);
    await store.dispatch({ type: 'q:stealIncorrect' });
    await store.dispatch({ type: 'q:next' });
    expect(timer.armed()).toBeNull();
    // Next question: a fresh deadline.
    await store.dispatch({ type: 'q:select', hieroglyph: 'water' });
    const endsAt = questionClockEndsAt(store.getState());
    expect(endsAt).toBe(clock.now() + QUESTION_DEADLINE_MS);
    expect(timer.armed()).toEqual({ gameId: store.getState()?.id, type: 'q:timeUp', endsAt });
    clock.advance(QUESTION_DEADLINE_MS);
    await store.idle();
    expect(store.getState()?.question).toMatchObject({ timeUp: true });
  });

  it("the host's early time-up disarms it; a timer that fires late is harmless", async () => {
    const { store, clock, timer } = await questionRound();
    await store.dispatch({ type: 'q:select', hieroglyph: 'lion' });
    clock.advance(5_000);
    await store.dispatch({ type: 'q:timeUp' }, { who: 'admin' });
    expect(timer.armed()).toBeNull();
    expect(clock.pending()).toBe(0);
    const version = store.getState()?.version;
    clock.advance(QUESTION_DEADLINE_MS);
    await store.idle();
    expect(store.getState()?.version).toBe(version);
  });

  it('re-arms on boot from the persisted question clock and fires at the right moment', async () => {
    const { store, clock, persistence, timer } = await questionRound();
    await store.dispatch({ type: 'q:select', hieroglyph: 'lion' });
    timer.stop();
    clock.advance(15_000);

    const restarted = new GameStore(persistence, { now: clock.now });
    await restarted.load();
    const again = new GameTimer(restarted, { now: clock.now, setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn });
    again.start();
    expect(again.armed()).toMatchObject({ type: 'q:timeUp', endsAt: questionClockEndsAt(restarted.getState()) });
    clock.advance(QUESTION_DEADLINE_MS - 15_000 - 1);
    expect(restarted.getState()?.question?.timeUp).toBe(false);
    clock.advance(1);
    await restarted.idle();
    expect(restarted.getState()?.question).toMatchObject({ stage: 'question', timeUp: true });
    again.stop();
  });

  it('fires immediately when the question deadline passed while the server was down', async () => {
    const { store, clock, persistence, timer } = await questionRound();
    await store.dispatch({ type: 'q:select', hieroglyph: 'lion' });
    timer.stop();
    clock.advance(QUESTION_DEADLINE_MS + 3_000);
    const restarted = new GameStore(persistence, { now: clock.now });
    await restarted.load();
    const again = new GameTimer(restarted, { now: clock.now, setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn });
    again.start();
    clock.advance(0);
    await restarted.idle();
    expect(restarted.getState()?.question).toMatchObject({ timeUp: true });
    again.stop();
  });

  it('a fired q:timeUp queued behind a stalled save never times out the next question', async () => {
    // The host judges, moves on and picks the next hieroglyph just before the clock runs out, but a slow
    // database save holds the queue: the timer fires for question 1 while those actions are still waiting.
    const pack = demoPack();
    const packs = new InMemoryPackRepository([pack]);
    let release: (() => void) | null = null;
    class StallingPersistence extends InMemoryGamePersistence {
      stallNext = false;
      override async save(state: Parameters<InMemoryGamePersistence['save']>[0]): Promise<void> {
        if (this.stallNext) {
          this.stallNext = false;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return super.save(state);
      }
    }
    const persistence = new StallingPersistence(packs);
    const clock = fakeClock();
    const store = new GameStore(persistence, { now: clock.now });
    await store.newGame(pack.id, TEAMS);
    await store.dispatch({ type: 'round:start', round: 'connections' });
    const timer = new GameTimer(store, { now: clock.now, setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn });
    timer.start();
    await store.dispatch({ type: 'q:select', hieroglyph: 'lion' }, { who: 'admin' });
    const firstId = store.getState()?.question?.questionId;
    clock.advance(QUESTION_DEADLINE_MS - 10);

    persistence.stallNext = true;
    const stalled = store.dispatch({ type: 'q:reveal' }, { who: 'admin' });
    const queued = Promise.all([
      store.dispatch({ type: 'q:correct' }, { who: 'admin' }),
      store.dispatch({ type: 'q:next' }, { who: 'admin' }),
      store.dispatch({ type: 'q:select', hieroglyph: 'water' }, { who: 'admin' }),
    ]);
    await Promise.resolve();
    expect(clock.pending()).toBe(1); // the question-1 deadline is still armed: nothing has been applied yet
    clock.advance(10); // fire() sees question 1 still running and enqueues q:timeUp behind the three actions
    expect(release).not.toBeNull();
    (release as unknown as () => void)();
    await stalled;
    await queued;
    await store.idle();

    const qs = store.getState()?.question;
    expect(qs?.questionId).not.toBe(firstId);
    expect(qs).toMatchObject({ stage: 'question', timeUp: false, endsAt: clock.now() + QUESTION_DEADLINE_MS - 10 });
    expect(store.getState()?.version).toBe(6); // select, reveal, correct, next, select — the stale time-up was dropped
    expect(timer.armed()).toMatchObject({ type: 'q:timeUp', endsAt: qs?.endsAt });
    await store.dispatch({ type: 'q:reveal' }); // still allowed: the new clock is running
    clock.advance(QUESTION_DEADLINE_MS);
    await store.idle();
    expect(store.getState()?.question).toMatchObject({ timeUp: true });
    timer.stop();
  });

  it('follows the game from a question clock to a wall clock and back to idle', async () => {
    const { store, clock, timer } = await questionRound();
    await store.dispatch({ type: 'q:select', hieroglyph: 'lion' });
    expect(timer.armed()?.type).toBe('q:timeUp');
    await store.dispatch({ type: 'q:correct' });
    await store.dispatch({ type: 'round:start', round: 'wall' });
    await store.dispatch({ type: 'wall:select', hieroglyph: 'lion' });
    expect(timer.armed()).toBeNull(); // ready: nothing ticking
    await store.dispatch({ type: 'wall:start' });
    expect(timer.armed()).toMatchObject({ type: 'wall:timeUp', endsAt: liveWallEndsAt(store.getState()) });
    expect(clock.pending()).toBe(1);
    clock.advance(WALL_SECONDS * 1000);
    await store.idle();
    expect(store.getState()?.wall?.current).toMatchObject({ stage: 'frozen', endReason: 'time' });
    expect(timer.armed()).toBeNull();
    expect(clock.pending()).toBe(0);
  });
});
