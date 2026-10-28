import { describe, expect, it } from 'vitest';
import { DEFAULT_TEAM_NAMES, GameError, TEAM_IDS, type GameState, type PublicGameState, type Team, type TeamId } from '@only-connect/shared';
import { GameStore, incompatibleStateReason, isUndoableAdminAction } from '../store.js';
import { InMemoryGamePersistence, InMemoryPackRepository, demoPack } from '../../__tests__/stubs.js';

const TEAMS = [{ id: 'pink' as const, name: 'Pink Panthers' }, { id: 'blue' as const, name: 'Blue Whales' }];
/** A four-team game in a deliberately non-default creation order (orange first). */
const FOUR: Array<{ id: TeamId; name: string }> = [
  { id: 'orange', name: 'Tangerines' },
  { id: 'green', name: '' },
  { id: 'pink', name: 'Pink Panthers' },
  { id: 'blue', name: 'Blue Whales' },
];

function setup() {
  const pack = demoPack();
  const packs = new InMemoryPackRepository([pack]);
  const persistence = new InMemoryGamePersistence(packs);
  const store = new GameStore(persistence);
  return { pack, packs, persistence, store };
}

async function vowelsClue(store: GameStore, packId: string): Promise<GameState> {
  await store.newGame(packId, TEAMS);
  await store.dispatch({ type: 'player:join', playerId: 'p-ann', name: 'Ann', team: 'pink' });
  await store.dispatch({ type: 'player:join', playerId: 'p-bob', name: 'Bob', team: 'blue' });
  await store.dispatch({ type: 'round:start', round: 'vowels' });
  return store.dispatch({ type: 'vowels:showClue' });
}

describe('GameStore', () => {
  it('reports no game until one is created, then projects public state', async () => {
    const { store, pack } = setup();
    expect(store.getState()).toBeNull();
    expect(store.getPublic()).toMatchObject({ id: null, phase: 'none' });
    expect(typeof store.getPublic().serverNow).toBe('number');

    const state = await store.newGame(pack.id, TEAMS);
    expect(state.phase).toBe('lobby');
    expect(state.teams.pink.name).toBe('Pink Panthers');
    // V3.2: the two playing teams, the idle colours present with their default names, no firstTeam.
    expect(state.activeTeams).toEqual(['pink', 'blue']);
    expect(state.teams.green).toEqual({ id: 'green', name: DEFAULT_TEAM_NAMES.green, score: 0 });
    expect(state.firstTeam).toBeUndefined();
    const pub = store.getPublic();
    expect(pub).toMatchObject({ id: state.id, phase: 'lobby', packName: pack.name, version: 0, activeTeams: ['pink', 'blue'] });
    expect(JSON.stringify(pub)).not.toContain('"pack"');
  });

  it('rejects unknown packs and game:new via dispatch', async () => {
    const { store, pack } = setup();
    await expect(store.newGame('00000000-0000-0000-0000-000000000000', TEAMS)).rejects.toMatchObject({ code: 'unknown_pack' });
    await expect(store.dispatch({ type: 'q:reveal' })).rejects.toMatchObject({ code: 'no_game' });
    await store.newGame(pack.id, TEAMS);
    await expect(store.dispatch({ type: 'game:new', packId: pack.id, teams: TEAMS })).rejects.toBeInstanceOf(GameError);
  });

  it('persists every change and notifies listeners in order', async () => {
    const { store, persistence, pack } = setup();
    const seen: number[] = [];
    store.subscribe((s) => seen.push(s.version));
    await store.newGame(pack.id, TEAMS);
    await store.dispatch({ type: 'game:adjustScore', team: 'pink', delta: 2 });
    await store.dispatch({ type: 'game:setTeamName', team: 'blue', name: 'Azul' });
    expect(seen).toEqual([0, 1, 2]);
    expect(persistence.saves.map((s) => s.version)).toEqual([0, 1, 2]);
    expect(persistence.latest?.teams.blue.name).toBe('Azul');
  });

  it('applies concurrent dispatches strictly sequentially', async () => {
    const { store, pack } = setup();
    await store.newGame(pack.id, TEAMS);
    const results = await Promise.all(
      Array.from({ length: 25 }, () => store.dispatch({ type: 'game:adjustScore', team: 'blue', delta: 1 })),
    );
    expect(results.map((s) => s.version)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    expect(store.getState()?.teams.blue.score).toBe(25);
  });

  it('buzz race: two simultaneous buzzes — exactly one wins, the other gets buzz_lost', async () => {
    const { store, pack } = setup();
    await vowelsClue(store, pack.id);
    const outcomes = await Promise.allSettled([
      store.dispatch({ type: 'player:buzz', playerId: 'p-ann' }, { who: 'ann' }),
      store.dispatch({ type: 'player:buzz', playerId: 'p-bob' }, { who: 'bob' }),
    ]);
    expect(outcomes[0].status).toBe('fulfilled');
    expect(outcomes[1].status).toBe('rejected');
    const lost = outcomes[1] as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(GameError);
    expect((lost.reason as GameError).code).toBe('buzz_lost');
    expect(store.getState()?.vowels).toMatchObject({ stage: 'buzzed', buzz: { playerId: 'p-ann', team: 'pink' } });
    // A failed action must not have bumped the version.
    expect(store.getState()?.version).toBe((outcomes[0] as PromiseFulfilledResult<GameState>).value.version);
  });

  it('buzz race in the other order: receipt order decides, not team or name', async () => {
    const { store, pack } = setup();
    await vowelsClue(store, pack.id);
    const outcomes = await Promise.allSettled([
      store.dispatch({ type: 'player:buzz', playerId: 'p-bob' }),
      store.dispatch({ type: 'player:buzz', playerId: 'p-ann' }),
      store.dispatch({ type: 'player:buzz', playerId: 'p-ann' }),
    ]);
    expect(outcomes.map((o) => o.status)).toEqual(['fulfilled', 'rejected', 'rejected']);
    expect(store.getState()?.vowels?.buzz?.playerId).toBe('p-bob');
  });

  it('load() restores the latest saved game with every player marked disconnected', async () => {
    const { store, persistence, pack, packs } = setup();
    await store.newGame(pack.id, TEAMS);
    await store.dispatch({ type: 'player:join', playerId: 'p-ann', name: 'Ann', team: 'pink' });
    await store.dispatch({ type: 'round:start', round: 'connections' });
    const before = store.getState() as GameState;

    const reloaded = new GameStore(new InMemoryGamePersistence(packs));
    expect(await reloaded.load()).toBeNull();

    const fresh = new GameStore(persistence);
    const state = await fresh.load();
    expect(state?.id).toBe(before.id);
    expect(state?.version).toBe(before.version);
    expect(state?.phase).toBe('connections');
    expect(state?.players.map((p) => p.connected)).toEqual([false]);
    expect(fresh.isLoaded()).toBe(true);
    // Rejoining flips it back without changing anything else.
    await fresh.dispatch({ type: 'player:join', playerId: 'p-ann', name: 'Ann', team: 'pink' });
    expect(fresh.getState()?.players[0]).toMatchObject({ id: 'p-ann', connected: true });
  });

  it('keeps serving when persistence fails and recovers on the next save', async () => {
    const { store, persistence, pack } = setup();
    await store.newGame(pack.id, TEAMS);
    persistence.failSaves = true;
    const s1 = await store.dispatch({ type: 'game:adjustScore', team: 'pink', delta: 1 });
    expect(s1.teams.pink.score).toBe(1);
    expect(persistence.latest?.version).toBe(0);
    persistence.failSaves = false;
    await store.dispatch({ type: 'game:adjustScore', team: 'pink', delta: 1 });
    expect(persistence.latest?.version).toBe(2);
    expect(persistence.latest?.teams.pink.score).toBe(2);
  });

  it('rejects invalid actions with GameError and leaves the state untouched', async () => {
    const { store, pack } = setup();
    const s0 = await store.newGame(pack.id, TEAMS);
    await expect(store.dispatch({ type: 'q:reveal' })).rejects.toBeInstanceOf(GameError);
    expect(store.getState()).toBe(s0);
  });

  it('stamps actions with their receipt time, not the time the queue applied them', async () => {
    let clock = 1_000_000;
    const pack = demoPack();
    const packs = new InMemoryPackRepository([pack]);
    const persistence = new InMemoryGamePersistence(packs);
    const slowSave = persistence.save.bind(persistence);
    persistence.save = async (s) => {
      clock += 200; // every write costs 200 "ms"
      await slowSave(s);
    };
    const store = new GameStore(persistence, { now: () => clock });
    await store.newGame(pack.id, TEAMS);
    await store.dispatch({ type: 'round:start', round: 'wall' });
    await store.dispatch({ type: 'wall:select', hieroglyph: 'lion' });
    const live = await store.dispatch({ type: 'wall:start' });
    const endsAt = live.wall?.current?.endsAt ?? 0;
    clock = endsAt - 50; // a tap 50 ms before the deadline, queued behind another action's slow write
    const [, tap] = await Promise.allSettled([store.dispatch({ type: 'game:adjustScore', team: 'blue', delta: 1 }), store.dispatch({ type: 'wall:select', tileId: 0 })]);
    expect(tap.status).toBe('fulfilled');
    expect(store.getState()?.wall?.current?.selected).toEqual([0]);
  });

  it('undo reverts the last admin action, keeps presence, and runs out gracefully', async () => {
    const { store, pack, persistence } = setup();
    await store.newGame(pack.id, TEAMS);
    expect(store.getState()?.undoable).toBeNull();
    await expect(store.undo()).rejects.toMatchObject({ code: 'nothing_to_undo' });
    await store.dispatch({ type: 'round:start', round: 'connections' }, { who: 'admin' });
    await store.dispatch({ type: 'q:select', hieroglyph: 'lion' }, { who: 'admin' });
    const judged = await store.dispatch({ type: 'q:correct' }, { who: 'admin' });
    expect(judged.teams.pink.score).toBe(5);
    expect(judged.undoable).toBe('q:correct');
    // A phone joins after the mistake; the undo must not drop it.
    await store.dispatch({ type: 'player:join', playerId: 'p-late', name: 'Late', team: 'blue' }, { who: 'socket x' });
    const undone = await store.undo({ who: 'admin' });
    expect(undone.teams.pink.score).toBe(0);
    expect(undone.question).toMatchObject({ stage: 'question', revealed: 1 });
    expect(undone.players.map((p) => p.id)).toEqual(['p-late']);
    expect(undone.version).toBe(judged.version + 2);
    expect(undone.undoable).toBe('q:select');
    expect(persistence.latest?.version).toBe(undone.version);
    await store.undo({ who: 'admin' });
    const back = await store.undo({ who: 'admin' });
    expect(back.phase).toBe('lobby');
    expect(back.undoable).toBeNull();
    await expect(store.undo()).rejects.toMatchObject({ code: 'nothing_to_undo' });
    // Non-admin actions (timer, sockets) are never undone and never offered.
    await store.dispatch({ type: 'game:adjustScore', team: 'pink', delta: 1 }, { who: 'timer' });
    expect(store.getState()?.undoable).toBeNull();
    // A new game clears the history.
    await store.dispatch({ type: 'game:adjustScore', team: 'pink', delta: 1 }, { who: 'admin' });
    await store.newGame(pack.id, TEAMS);
    await expect(store.undo()).rejects.toMatchObject({ code: 'nothing_to_undo' });
  });

  it('undo covers the admin\'s wall pick (wall:select {hieroglyph}) but never the panel\'s tile tap (wall:select {tileId})', async () => {
    const { store, pack } = setup();
    expect(isUndoableAdminAction({ type: 'wall:select', hieroglyph: 'lion' }, 'admin')).toBe(true);
    expect(isUndoableAdminAction({ type: 'wall:select', tileId: 3 }, 'admin')).toBe(false);
    expect(isUndoableAdminAction({ type: 'wall:select', hieroglyph: 'lion' }, 'socket x')).toBe(false);
    await store.newGame(pack.id, TEAMS);
    await store.dispatch({ type: 'round:start', round: 'wall' }, { who: 'admin' });
    const chosen = await store.dispatch({ type: 'wall:select', hieroglyph: 'water' }, { who: 'admin' });
    expect(chosen.wall).toMatchObject({ stage: 'playing', team: 'pink', used: ['water'], wallsDone: 0, wallsTotal: 2 });
    expect(chosen.undoable).toBe('wall:select');
    const undone = await store.undo({ who: 'admin' });
    expect(undone.wall).toMatchObject({ stage: 'selecting', team: 'pink', used: [], current: null });
    expect(undone.undoable).toBe('round:start');
    await store.dispatch({ type: 'wall:select', hieroglyph: 'lion' }, { who: 'admin' });
    await store.dispatch({ type: 'wall:start' }, { who: 'admin' });
    await store.dispatch({ type: 'wall:select', tileId: 0 }, { who: 'socket wall' });
    expect(store.getState()?.wall?.current?.selected).toEqual([0]);
    expect(store.getState()?.undoable).toBe('wall:start');
  });

  it('show cues and timer-fired time-ups never enter the undo history (V3)', async () => {
    const { store, pack } = setup();
    expect(isUndoableAdminAction({ type: 'cue:play', cue: 'openingTitles' }, 'admin')).toBe(false);
    expect(isUndoableAdminAction({ type: 'cue:stop' }, 'admin')).toBe(false);
    expect(isUndoableAdminAction({ type: 'q:timeUp' }, 'timer')).toBe(false);
    expect(isUndoableAdminAction({ type: 'wall:timeUp' }, 'timer')).toBe(false);
    expect(isUndoableAdminAction({ type: 'q:timeUp' }, 'admin')).toBe(true); // the host's early press can be undone
    expect(isUndoableAdminAction({ type: 'wall:timeUp' }, 'admin')).toBe(true);
    await store.newGame(pack.id, TEAMS);
    const cued = await store.dispatch({ type: 'cue:play', cue: 'introClip' }, { who: 'admin' });
    expect(cued.cue).toEqual({ name: 'introClip', nonce: cued.version });
    expect(cued.undoable).toBeNull();
    await store.dispatch({ type: 'cue:stop' }, { who: 'admin' });
    expect(store.getState()?.undoable).toBeNull();
    await expect(store.undo({ who: 'admin' })).rejects.toMatchObject({ code: 'nothing_to_undo' });
    await store.dispatch({ type: 'round:start', round: 'connections' }, { who: 'admin' });
    await store.dispatch({ type: 'q:select', hieroglyph: 'lion' }, { who: 'admin' });
    const timed = await store.dispatch({ type: 'q:timeUp' }, { who: 'timer' });
    expect(timed.question).toMatchObject({ timeUp: true });
    expect(timed.undoable).toBe('q:select');
    const undone = await store.undo({ who: 'admin' });
    expect(undone.question).toMatchObject({ stage: 'selecting', timeUp: false });
    // A cue set while a question is on does not get undone with the question.
    await store.dispatch({ type: 'q:select', hieroglyph: 'water' }, { who: 'admin' });
    await store.dispatch({ type: 'cue:play', cue: 'openingTitles' }, { who: 'admin' });
    await store.dispatch({ type: 'q:correct' }, { who: 'admin' });
    const back = await store.undo({ who: 'admin' });
    expect(back.question).toMatchObject({ stage: 'question' });
    expect(back.cue?.name).toBe('openingTitles'); // the snapshot taken before q:correct already had the cue
  });

  it('undo never changes the show cue: a stopped cue stays stopped and a playing one keeps playing (V3)', async () => {
    const { store, pack } = setup();
    await store.newGame(pack.id, TEAMS);
    // cue:play -> an undoable action snapshots the cue -> cue:stop -> undo must not bring the cue back.
    const cued = await store.dispatch({ type: 'cue:play', cue: 'introClip' }, { who: 'admin' });
    await store.dispatch({ type: 'round:start', round: 'connections' }, { who: 'admin' });
    await store.dispatch({ type: 'cue:stop' }, { who: 'admin' });
    expect(store.getState()?.cue).toBeNull();
    const undone = await store.undo({ who: 'admin' });
    expect(undone.phase).toBe('lobby');
    expect(undone.cue).toBeNull();
    expect(store.getPublic()).toMatchObject({ cue: null });
    // The mirror: a cue fired after the snapshot survives the undo (the monitor keeps playing it).
    await store.dispatch({ type: 'game:adjustScore', team: 'pink', delta: 1 }, { who: 'admin' });
    const titles = await store.dispatch({ type: 'cue:play', cue: 'openingTitles' }, { who: 'admin' });
    expect(titles.cue?.nonce).toBeGreaterThan(cued.cue?.nonce ?? 0);
    const back = await store.undo({ who: 'admin' });
    expect(back.teams.pink.score).toBe(0);
    expect(back.cue).toEqual(titles.cue);
  });

  it('load() fills in the team fields of a game saved before V3.2 (normalizeGameState) and writes it back', async () => {
    const { store, persistence, pack } = setup();
    await store.newGame(pack.id, TEAMS);
    await store.dispatch({ type: 'round:start', round: 'connections' });
    const grid = store.getState()?.question?.available ?? [];
    await store.dispatch({ type: 'q:select', hieroglyph: grid[0] });
    await store.dispatch({ type: 'q:correct' }); // pink 5
    await store.dispatch({ type: 'q:next' });
    await store.dispatch({ type: 'round:start', round: 'sequences' }); // suspends Connections; blue (behind) opens
    const current = persistence.latest as GameState;
    expect(current.question).toMatchObject({ round: 'sequences', order: ['blue', 'pink'], team: 'blue' });
    expect(current.suspended?.connections?.order).toEqual(['pink', 'blue']);

    // Strip what a V3 row did not have: activeTeams, the idle team records and every round order; V3 kept firstTeam.
    const legacy = structuredClone(current) as Omit<GameState, 'teams'> & { teams: Partial<Record<TeamId, Team>> };
    delete legacy.activeTeams;
    delete legacy.teams.green;
    delete legacy.teams.orange;
    if (legacy.question) delete legacy.question.order;
    if (legacy.suspended?.connections) delete legacy.suspended.connections.order;
    legacy.firstTeam = 'pink';
    persistence.latest = legacy as GameState;
    persistence.saves.length = 0;

    const fresh = new GameStore(persistence);
    const loaded = await fresh.load();
    expect(loaded?.id).toBe(current.id);
    expect(loaded?.version).toBe(current.version);
    expect(loaded?.activeTeams).toEqual(['pink', 'blue']);
    expect(loaded?.teams.green).toEqual({ id: 'green', name: DEFAULT_TEAM_NAMES.green, score: 0 });
    expect(loaded?.teams.orange).toEqual({ id: 'orange', name: DEFAULT_TEAM_NAMES.orange, score: 0 });
    expect(loaded?.teams.pink).toMatchObject({ name: 'Pink Panthers', score: 5 });
    // Orders derived from the V3 rules: Sequences opened with the other team, Connections with firstTeam.
    expect(loaded?.question).toMatchObject({ round: 'sequences', order: ['blue', 'pink'], team: 'blue' });
    expect(loaded?.suspended?.connections?.order).toEqual(['pink', 'blue']);
    // The normalised row is written back once, and the public projection never lacks the new fields.
    expect(persistence.saves).toHaveLength(1);
    expect(persistence.latest?.activeTeams).toEqual(['pink', 'blue']);
    expect(Object.keys(persistence.latest?.teams ?? {}).sort()).toEqual([...TEAM_IDS].sort());
    const pub = fresh.getPublic() as PublicGameState;
    expect(pub.activeTeams).toEqual(['pink', 'blue']);
    expect(pub.question?.order).toEqual(['blue', 'pink']);
    expect(Object.keys(pub.teams).sort()).toEqual([...TEAM_IDS].sort());
    // The game goes on from there: the legacy round plays with its derived order.
    const seqGrid = loaded?.question?.available ?? [];
    const picked = await fresh.dispatch({ type: 'q:select', hieroglyph: seqGrid[0] });
    expect(picked.question).toMatchObject({ team: 'blue', stage: 'question' });
    // A row that already has everything is loaded as is (no extra write).
    persistence.saves.length = 0;
    const again = await new GameStore(persistence).load();
    expect(again?.activeTeams).toEqual(['pink', 'blue']);
    expect(persistence.saves).toHaveLength(0);
  });

  it('game:new with four teams (V3.2): creation order, default names, one wall per team, orders per round', async () => {
    const pack = demoPack();
    const four = demoPack({ walls: 4 });
    const packs = new InMemoryPackRepository([pack, four]);
    const persistence = new InMemoryGamePersistence(packs);
    const store = new GameStore(persistence);
    await expect(store.newGame(pack.id, FOUR)).rejects.toMatchObject({ code: 'not_enough_walls' }); // 2 walls, 4 teams
    await expect(store.newGame(four.id, [{ id: 'pink', name: 'Solo' }])).rejects.toMatchObject({ code: 'invalid_teams' });
    await expect(store.newGame(four.id, [...FOUR, { id: 'pink', name: 'Again' }])).rejects.toMatchObject({ code: 'invalid_teams' });
    expect(store.getState()).toBeNull();
    expect(persistence.saves).toHaveLength(0);

    const state = await store.newGame(four.id, FOUR);
    expect(state.activeTeams).toEqual(['orange', 'green', 'pink', 'blue']);
    expect(state.teams.orange.name).toBe('Tangerines');
    expect(state.teams.green.name).toBe(DEFAULT_TEAM_NAMES.green); // empty name -> default
    expect(state.firstTeam).toBeUndefined();
    expect(store.getPublic()).toMatchObject({ activeTeams: ['orange', 'green', 'pink', 'blue'] });
    // Players join active teams only; every colour is active here.
    await store.dispatch({ type: 'player:join', playerId: 'p-gus', name: 'Gus', team: 'green' });
    expect(store.getState()?.players[0]).toMatchObject({ team: 'green' });
    // Suggested order: lowest score first, ties in creation order; every team plays one wall.
    await store.dispatch({ type: 'game:adjustScore', team: 'pink', delta: 3 });
    await store.dispatch({ type: 'game:adjustScore', team: 'green', delta: 1 });
    const wall = await store.dispatch({ type: 'round:start', round: 'wall' });
    expect(wall.wall).toMatchObject({ order: ['orange', 'blue', 'green', 'pink'], team: 'orange', wallsTotal: 4, wallsDone: 0 });
    expect((store.getPublic() as PublicGameState).wall?.order).toEqual(['orange', 'blue', 'green', 'pink']);
    // The host's own order must be a permutation of the active teams.
    await expect(store.dispatch({ type: 'round:start', round: 'connections', order: ['pink', 'blue'] })).rejects.toMatchObject({ code: 'invalid_order' });
    const conn = await store.dispatch({ type: 'round:start', round: 'connections', order: ['blue', 'pink', 'orange', 'green'] });
    expect(conn.question).toMatchObject({ order: ['blue', 'pink', 'orange', 'green'], team: 'blue' });
    // Question k goes to order[k % 4]: blue plays the first, pink is up next.
    await store.dispatch({ type: 'q:select', hieroglyph: conn.question?.available[0] ?? 'twoReeds' });
    await store.dispatch({ type: 'q:correct' }); // blue 5
    const next = await store.dispatch({ type: 'q:next' });
    expect(next.question).toMatchObject({ team: 'pink', questionsDone: 1 });
    // The wall round above had not progressed, so it was not kept: it starts afresh with the suggested order
    // (orange 0, green 1, pink 3, blue 5) ...
    const wallAgain = await store.dispatch({ type: 'round:start', round: 'wall' });
    expect(wallAgain.wall).toMatchObject({ order: ['orange', 'green', 'pink', 'blue'], team: 'orange', wallsDone: 0 });
    // ... while Connections, with a question played, resumes with the order it was started with (`order` ignored).
    const resumed = await store.dispatch({ type: 'round:start', round: 'connections', order: ['green', 'orange', 'blue', 'pink'] });
    expect(resumed.question).toMatchObject({ order: ['blue', 'pink', 'orange', 'green'], team: 'pink', questionsDone: 1 });
    expect(persistence.latest?.activeTeams).toEqual(['orange', 'green', 'pink', 'blue']);
  });

  it('load() refuses to resume a game persisted before walls were chosen by hieroglyph', async () => {
    const { store, persistence, pack } = setup();
    await store.newGame(pack.id, TEAMS);
    await store.dispatch({ type: 'round:start', round: 'wall' });
    await store.dispatch({ type: 'wall:select', hieroglyph: 'lion' });
    const current = persistence.latest as GameState;
    expect(incompatibleStateReason(current)).toBeNull();

    const oldWall = structuredClone(current) as GameState & { wall: Record<string, unknown> };
    oldWall.wall = { assignment: { [pack.walls[0].id]: 'pink' }, current: null, completed: [] };
    expect(incompatibleStateReason(oldWall)).toMatch(/wall round state/);
    const byTeam = structuredClone(current) as GameState & { wall: Record<string, unknown> };
    byTeam.wall = { pink: null, blue: null, current: null, completed: [] };
    expect(incompatibleStateReason(byTeam)).toMatch(/wall round state/);
    const oldPack = structuredClone(current);
    oldPack.pack.walls = oldPack.pack.walls.map((w) => ({ id: w.id, position: w.position, groups: w.groups })) as typeof oldPack.pack.walls;
    expect(incompatibleStateReason(oldPack)).toMatch(/walls have no hieroglyph/);
    const oldQuestion = structuredClone(current);
    oldQuestion.suspended = { connections: { round: 'connections', stage: 'selecting', team: 'pink', used: [], questionId: null, revealed: 0, pointsOnOffer: 0, result: null, questionsDone: 0 } as never };
    expect(incompatibleStateReason(oldQuestion)).toMatch(/question round state/);

    persistence.latest = oldWall;
    const fresh = new GameStore(persistence);
    expect(await fresh.load()).toBeNull();
    expect(fresh.getState()).toBeNull();
    expect(fresh.isLoaded()).toBe(true);
    persistence.latest = current;
    expect((await new GameStore(persistence).load())?.wall).toMatchObject({ stage: 'playing', used: ['lion'] });
  });
});
