import { describe, expect, it } from 'vitest';
import { clientAddress, handleBuzz, handleJoin, handleLeave, handleSelect, isPresenceChange } from '../index.js';
import { createTestDeps, demoPack } from '../../__tests__/stubs.js';

const TEAMS = [{ id: 'pink' as const, name: 'Pink' }, { id: 'blue' as const, name: 'Blue' }];

async function gameInLobby() {
  const deps = createTestDeps();
  const pack = (await deps.packs.list())[0];
  await deps.store.newGame(pack.id, TEAMS);
  return deps;
}

let n = 0;
const secrets = () => `secret-${++n}`;

describe('socket handlers', () => {
  it('player:join creates a player with a fresh id + secret, rejoins with the secret, rejects bad payloads', async () => {
    const deps = await gameInLobby();
    const bad = await handleJoin(deps.store, { name: '', team: 'pink' }, 's1');
    expect(bad.ack.ok).toBe(false);

    const first = await handleJoin(deps.store, { playerId: null, name: 'Ann', team: 'pink' }, 's1', undefined, () => 'uuid-1', () => 'sec-1');
    expect(first.ack).toEqual({ ok: true, data: { playerId: 'uuid-1', secret: 'sec-1' } });
    expect(deps.store.getState()?.players).toEqual([expect.objectContaining({ id: 'uuid-1', name: 'Ann', team: 'pink', connected: true, secret: 'sec-1' })]);

    // An unknown id from a phone's localStorage is kept (the phone keeps its identity across games).
    const stale = await handleJoin(deps.store, { playerId: 'kept-id', secret: 'kept-secret', name: 'Bob', team: 'blue' }, 's2', undefined, () => 'uuid-2');
    expect(stale.ack.data).toEqual({ playerId: 'kept-id', secret: 'kept-secret' });

    // Known id + right secret -> rejoin, updating name and team; wrong / missing secret -> not_owner.
    const rejoin = await handleJoin(deps.store, { playerId: 'uuid-1', secret: 'sec-1', name: 'Annie', team: 'blue' }, 's3');
    expect(rejoin.ack.data?.playerId).toBe('uuid-1');
    expect(deps.store.getState()?.players.find((p) => p.id === 'uuid-1')).toMatchObject({ name: 'Annie', team: 'blue' });
    const hijack = await handleJoin(deps.store, { playerId: 'uuid-1', secret: 'nope', name: 'Hacked', team: 'pink' }, 's4');
    expect(hijack.ack).toMatchObject({ ok: false, code: 'not_owner' });
    expect(hijack.player).toBeNull();
    const noSecret = await handleJoin(deps.store, { playerId: 'uuid-1', name: 'Hacked', team: 'pink' }, 's4', undefined, undefined, secrets);
    expect(noSecret.ack).toMatchObject({ ok: false, code: 'not_owner' });
    expect(deps.store.getState()?.players.find((p) => p.id === 'uuid-1')).toMatchObject({ name: 'Annie', team: 'blue' });
    expect(deps.store.getState()?.players).toHaveLength(2);
  });

  it('player:join fails cleanly when there is no game', async () => {
    const deps = createTestDeps();
    const res = await handleJoin(deps.store, { playerId: null, name: 'Ann', team: 'pink' }, 's1');
    expect(res.ack).toMatchObject({ ok: false, code: 'no_game' });
    expect(res.player).toBeNull();
  });

  it('player:join refuses a team that is not playing this game (team_inactive) and takes it once it is (V3.2)', async () => {
    const deps = await gameInLobby(); // pink and blue
    const idle = await handleJoin(deps.store, { playerId: null, name: 'Gus', team: 'green' }, 's1', undefined, () => 'uuid-g');
    expect(idle.ack).toMatchObject({ ok: false, code: 'team_inactive' });
    expect(typeof idle.ack.error).toBe('string');
    expect(idle.player).toBeNull();
    expect(deps.store.getState()?.players).toEqual([]);
    // Nor can a rejoin move an existing player onto an idle team.
    await handleJoin(deps.store, { playerId: null, name: 'Ann', team: 'pink' }, 's2', undefined, () => 'uuid-1', () => 'sec-1');
    const moved = await handleJoin(deps.store, { playerId: 'uuid-1', secret: 'sec-1', name: 'Ann', team: 'orange' }, 's2');
    expect(moved.ack).toMatchObject({ ok: false, code: 'team_inactive' });
    expect(deps.store.getState()?.players).toEqual([expect.objectContaining({ id: 'uuid-1', team: 'pink' })]);
    // A four-team game takes every colour.
    const four = await deps.packs.insert(demoPack({ walls: 4 }));
    await deps.store.newGame(four.id, [{ id: 'pink', name: '' }, { id: 'blue', name: '' }, { id: 'green', name: '' }, { id: 'orange', name: '' }]);
    const ok = await handleJoin(deps.store, { playerId: null, name: 'Gus', team: 'green' }, 's1', undefined, () => 'uuid-g', () => 'sec-g');
    expect(ok.ack).toEqual({ ok: true, data: { playerId: 'uuid-g', secret: 'sec-g' } });
    expect(ok.player).toEqual({ id: 'uuid-g', secret: 'sec-g', name: 'Gus', team: 'green' });
    expect(deps.store.getState()?.players).toEqual([expect.objectContaining({ id: 'uuid-g', team: 'green', connected: true })]);
  });

  it('player:leave removes the socket\'s own player and is idempotent', async () => {
    const deps = await gameInLobby();
    await handleJoin(deps.store, { playerId: null, name: 'Ann', team: 'pink' }, 's1', undefined, () => 'uuid-1');
    expect(await handleLeave(deps.store, 'uuid-1', 's1')).toEqual({ ok: true });
    expect(deps.store.getState()?.players).toEqual([]);
    expect(await handleLeave(deps.store, 'uuid-1', 's1')).toEqual({ ok: true });
    expect(await handleLeave(deps.store, null, 's1')).toMatchObject({ ok: false, code: 'not_joined' });
  });

  it('player:buzz: concurrent buzzes -> exactly one won:true, the loser gets won:false; un-joined sockets cannot buzz', async () => {
    const deps = await gameInLobby();
    await handleJoin(deps.store, { playerId: null, name: 'Ann', team: 'pink' }, 's1', undefined, () => 'ann');
    await handleJoin(deps.store, { playerId: null, name: 'Bob', team: 'blue' }, 's2', undefined, () => 'bob');

    const closed = await handleBuzz(deps.store, 'ann', 's1');
    expect(closed).toMatchObject({ ok: false, code: 'buzz_closed', data: { won: false } });
    expect(await handleBuzz(deps.store, null, 's9')).toMatchObject({ ok: false, code: 'not_joined', data: { won: false } });

    await deps.store.dispatch({ type: 'round:start', round: 'vowels' });
    await deps.store.dispatch({ type: 'vowels:showClue' });
    const [a, b] = await Promise.all([handleBuzz(deps.store, 'bob', 's2'), handleBuzz(deps.store, 'ann', 's1')]);
    expect(a).toEqual({ ok: true, data: { won: true } });
    expect(b).toMatchObject({ ok: true, data: { won: false } });
    expect(deps.store.getState()?.vowels?.buzz).toMatchObject({ playerId: 'bob', team: 'blue', playerName: 'Bob' });

    // Reopen: the loser can now win, the locked-out player gets an error.
    await deps.store.dispatch({ type: 'vowels:reopen' });
    expect(await handleBuzz(deps.store, 'bob', 's2')).toMatchObject({ ok: false, code: 'buzz_locked', data: { won: false } });
    expect(await handleBuzz(deps.store, 'ann', 's1')).toEqual({ ok: true, data: { won: true } });
    expect(await handleBuzz(deps.store, 'nobody', 's9')).toMatchObject({ ok: true, data: { won: false } });
  });

  it('wall:select toggles tiles only while the wall is live', async () => {
    const deps = await gameInLobby();
    expect((await handleSelect(deps.store, { tileId: 3 }, 'wall')).ok).toBe(false);
    await deps.store.dispatch({ type: 'round:start', round: 'wall' });
    await deps.store.dispatch({ type: 'wall:select', hieroglyph: 'lion' });
    expect((await handleSelect(deps.store, { tileId: 3 }, 'wall')).ok).toBe(false);
    await deps.store.dispatch({ type: 'wall:start' });
    expect(await handleSelect(deps.store, { tileId: 3 }, 'wall')).toEqual({ ok: true });
    expect(deps.store.getState()?.wall?.current?.selected).toEqual([3]);
    expect(await handleSelect(deps.store, { tileId: 3 }, 'wall')).toEqual({ ok: true });
    expect(deps.store.getState()?.wall?.current?.selected).toEqual([]);
    expect((await handleSelect(deps.store, { tileId: 99 }, 'wall')).ok).toBe(false);
  });

  it('helpers: client address behind the proxy, presence changes', () => {
    const sock = (headers: Record<string, string | string[]>, address = '10.0.0.9') => ({ handshake: { headers, address } }) as never;
    expect(clientAddress(sock({ 'x-forwarded-for': '203.0.113.5, 10.0.0.1' }))).toBe('203.0.113.5');
    expect(clientAddress(sock({}))).toBe('10.0.0.9');
    expect(isPresenceChange({ type: 'player:join', playerId: 'x', name: 'X', team: 'pink' })).toBe(true);
    expect(isPresenceChange({ type: 'player:connected', playerId: 'x', connected: false })).toBe(true);
    expect(isPresenceChange({ type: 'player:buzz', playerId: 'x' })).toBe(false);
    expect(isPresenceChange(undefined)).toBe(false);
  });
});
