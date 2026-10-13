import { describe, expect, it } from 'vitest';
import { WALL_SECONDS } from '@only-connect/shared';
import { GameStore } from '../store.js';
import { WallTimer, liveWallEndsAt } from '../timers.js';
import { InMemoryGamePersistence, InMemoryPackRepository, demoPack } from '../../__tests__/stubs.js';

const TEAMS = { pink: { name: 'Pink' }, blue: { name: 'Blue' } };

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
  await store.newGame(pack.id, TEAMS, 'pink');
  await store.dispatch({ type: 'round:start', round: 'wall' });
  await store.dispatch({ type: 'wall:show', team: 'pink' });
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
    expect(timer.armed()).toEqual({ gameId: store.getState()?.id, endsAt });
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
