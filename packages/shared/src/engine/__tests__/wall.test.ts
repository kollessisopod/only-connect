import { describe, expect, it } from 'vitest';
import { WALL_SECONDS, type GameState } from '../../types.js';
import { allowedActions, applyAction } from '../game.js';
import { wallSecondsRemaining } from '../wall.js';
import {
  currentWall,
  expectError,
  groupTileIds,
  liveWall,
  makeCtx,
  mixedTileIds,
  newGame,
  resolveAndFinish,
  run,
  selectGroup,
  selectTiles,
  NOW,
  SEED,
} from './fixtures.js';

const ctx = makeCtx();

function wallRound(state: GameState) {
  if (!state.wall) throw new Error('no wall round');
  return state.wall;
}

describe('Connecting Wall — setup', () => {
  it('pre-assigns walls (team behind gets wall 1) and lets the admin re-assign', () => {
    const base = newGame('pink');
    let s = applyAction(base, { type: 'round:start', round: 'wall' }, ctx);
    const [w1, w2] = s.pack.walls.map((w) => w.id);
    expect(wallRound(s)).toEqual({ assignment: { pink: w1, blue: w2 }, current: null, completed: [] });

    const blueBehind = run(base, [{ type: 'game:adjustScore', team: 'pink', delta: 2 }, { type: 'round:start', round: 'wall' }]);
    expect(wallRound(blueBehind).assignment).toEqual({ pink: w2, blue: w1 });

    s = applyAction(s, { type: 'wall:assign', team: 'pink', wallId: w2 }, ctx);
    expect(wallRound(s).assignment.pink).toBe(w2);
    expectError(s, { type: 'wall:assign', team: 'pink', wallId: 'nope' });
    expect(allowedActions(s)).toEqual(expect.arrayContaining(['wall:assign', 'wall:show']));
  });

  it('wall:show requires an assignment and builds a deterministic 16-tile layout', () => {
    let s = applyAction(newGame(), { type: 'round:start', round: 'wall' }, ctx);
    const unassigned: GameState = { ...s, wall: { ...wallRound(s), assignment: { pink: null, blue: null } } };
    expectError(unassigned, { type: 'wall:show', team: 'pink' });
    expect(allowedActions(unassigned)).not.toContain('wall:show');

    s = applyAction(s, { type: 'wall:show', team: 'pink' }, ctx);
    const play = currentWall(s);
    expect(play).toMatchObject({ team: 'pink', stage: 'ready', seed: SEED, selected: [], lives: null, startedAt: null, endsAt: null, endReason: null, resolvingGroup: null, awarded: null });
    expect(play.tiles.map((t) => t.id)).toEqual(Array.from({ length: 16 }, (_, i) => i));
    const wall = s.pack.walls.find((w) => w.id === play.wallId);
    const allClues = wall?.groups.flatMap((g) => g.clues).sort() ?? [];
    expect(play.tiles.map((t) => t.text).sort()).toEqual(allClues);
    for (const t of play.tiles) expect(wall?.groups[t.group].clues).toContain(t.text);
    expect(play.groups.map((g) => g.index)).toEqual([0, 1, 2, 3]);
    expect(play.groups.every((g) => g.solvedOrder === null && !g.foundByTeam && !g.connectionRevealed)).toBe(true);

    // Same seed -> same layout; different seed -> different layout; the layout is actually shuffled.
    const again = applyAction(applyAction(newGame(), { type: 'round:start', round: 'wall' }, ctx), { type: 'wall:show', team: 'pink' }, ctx);
    expect(currentWall(again).tiles).toEqual(play.tiles);
    const other = applyAction(applyAction(newGame(), { type: 'round:start', round: 'wall' }, ctx), { type: 'wall:show', team: 'pink' }, makeCtx({ seed: 7 }));
    expect(currentWall(other).tiles.map((t) => t.text)).not.toEqual(play.tiles.map((t) => t.text));
    expect(play.tiles.map((t) => t.group)).not.toEqual([0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3]);

    expectError(s, { type: 'wall:show', team: 'blue' }); // one wall at a time
    expectError(s, { type: 'wall:select', tileId: 0 }, 'wall_not_live');
    expect(allowedActions(s)).toContain('wall:start');
  });

  it('wall:start arms the 3 minute timer', () => {
    const s = liveWall('pink');
    const play = currentWall(s);
    expect(play.stage).toBe('live');
    expect(play.startedAt).toBe(NOW);
    expect(play.endsAt).toBe(NOW + WALL_SECONDS * 1000);
    expect(wallSecondsRemaining(play, NOW)).toBe(180);
    expect(wallSecondsRemaining(play, NOW + 1000)).toBe(179);
    expect(wallSecondsRemaining(play, NOW + 179_500)).toBe(1);
    expect(wallSecondsRemaining(play, NOW + 180_000)).toBe(0);
    expect(wallSecondsRemaining(play, NOW + 999_999)).toBe(0);
    expect(wallSecondsRemaining({ ...play, stage: 'ready', endsAt: null }, NOW)).toBe(0);
    expectError(s, { type: 'wall:start' });
  });
});

describe('Connecting Wall — play', () => {
  it('selects and deselects tiles', () => {
    let s = liveWall();
    s = selectTiles(s, [3]);
    expect(currentWall(s).selected).toEqual([3]);
    s = selectTiles(s, [5]);
    expect(currentWall(s).selected).toEqual([3, 5]);
    s = selectTiles(s, [3]);
    expect(currentWall(s).selected).toEqual([5]);
    expectError(s, { type: 'wall:select', tileId: 99 });
  });

  it('locks a correct group, colours it in solve order and moves it to the top row', () => {
    let s = liveWall();
    const ids = groupTileIds(s, 2);
    s = selectTiles(s, ids.slice(0, 3));
    expect(currentWall(s).selected).toEqual(ids.slice(0, 3));
    s = selectTiles(s, ids.slice(3));
    const play = currentWall(s);
    expect(play.selected).toEqual([]);
    expect(play.lastWrong).toBeNull();
    expect(play.groups[2]).toMatchObject({ solvedOrder: 0, foundByTeam: true, connectionRevealed: false });
    expect(play.tiles.slice(0, 4).every((t) => t.group === 2)).toBe(true);
    expect(play.tiles.map((t) => t.id).sort((a, b) => a - b)).toEqual(Array.from({ length: 16 }, (_, i) => i));
    expect(play.lives).toBeNull();
    expect(play.stage).toBe('live');
    expectError(s, { type: 'wall:select', tileId: ids[0] });

    s = selectGroup(s, 0);
    const p2 = currentWall(s);
    expect(p2.groups[0].solvedOrder).toBe(1);
    expect(p2.tiles.slice(0, 4).every((t) => t.group === 2)).toBe(true);
    expect(p2.tiles.slice(4, 8).every((t) => t.group === 0)).toBe(true);
    expect(p2.lives).toBe(3);
  });

  it('flashes and clears a wrong guess; lives only count after two groups', () => {
    let s = liveWall();
    const wrong = mixedTileIds(s, [0, 1, 2, 3]);
    s = selectTiles(s, wrong);
    expect(currentWall(s)).toMatchObject({ selected: [], lastWrong: wrong, lives: null, stage: 'live' });
    s = selectTiles(s, [wrong[0]]);
    expect(currentWall(s).lastWrong).toBeNull();
    s = selectTiles(s, [wrong[0]]); // deselect
    // Unlimited wrong guesses before two groups are found.
    for (let i = 0; i < 5; i++) s = selectTiles(s, mixedTileIds(s, [0, 1, 2, 3]));
    expect(currentWall(s).lives).toBeNull();

    s = selectGroup(s, 1);
    s = selectGroup(s, 3);
    expect(currentWall(s).lives).toBe(3);
    const a = groupTileIds(s, 0);
    const b = groupTileIds(s, 2);
    s = selectTiles(s, [a[0], a[1], b[0], b[1]]);
    expect(currentWall(s).lastWrong).toEqual([a[0], a[1], b[0], b[1]]);
    expect(currentWall(s).lives).toBe(2);
    expect(currentWall(s).stage).toBe('live');
  });

  it('freezes the wall with endReason "lives" when the last life is lost', () => {
    let s = liveWall();
    s = selectGroup(s, 1);
    s = selectGroup(s, 3);
    const wrongGuess = () => {
      const a = groupTileIds(s, 0);
      const b = groupTileIds(s, 2);
      return [a[0], a[1], b[0], b[1]];
    };
    s = selectTiles(s, wrongGuess());
    expect(currentWall(s).lives).toBe(2);
    s = selectTiles(s, wrongGuess());
    expect(currentWall(s).lives).toBe(1);
    s = selectTiles(s, wrongGuess());
    const play = currentWall(s);
    expect(play).toMatchObject({ lives: 0, stage: 'frozen', endReason: 'lives', selected: [], endedAt: NOW });
    expectError(s, { type: 'wall:select', tileId: groupTileIds(s, 0)[0] }, 'wall_not_live');
    expect(allowedActions(s)).toContain('wall:resolve');
    expect(allowedActions(s)).not.toContain('wall:timeUp');
  });

  it('auto-solves the 4th group when the 3rd is found and freezes as complete', () => {
    let s = liveWall();
    s = selectGroup(s, 3);
    s = selectGroup(s, 1);
    s = selectGroup(s, 2);
    const play = currentWall(s);
    expect(play.stage).toBe('frozen');
    expect(play.endReason).toBe('complete');
    expect(play.endedAt).toBe(NOW);
    expect(play.groups.map((g) => g.solvedOrder)).toEqual([3, 1, 2, 0]);
    expect(play.groups.every((g) => g.foundByTeam)).toBe(true);
    expect(play.tiles.map((t) => t.group)).toEqual([3, 3, 3, 3, 1, 1, 1, 1, 2, 2, 2, 2, 0, 0, 0, 0]);
    expect(play.lives).toBe(3);
  });

  it('wall:timeUp freezes a live wall, is a no-op afterwards, and blocks late selections', () => {
    let s = liveWall();
    s = selectTiles(s, [1, 2]);
    const late = makeCtx({ now: NOW + WALL_SECONDS * 1000 });
    expectError(s, { type: 'wall:select', tileId: 3 }, 'wall_time_up', late);
    expect(() => applyAction(s, { type: 'wall:select', tileId: 3 }, makeCtx({ now: NOW + WALL_SECONDS * 1000 - 1 }))).not.toThrow();

    s = applyAction(s, { type: 'wall:timeUp' }, late);
    expect(currentWall(s)).toMatchObject({ stage: 'frozen', endReason: 'time', selected: [], endedAt: NOW + WALL_SECONDS * 1000 });
    // An early admin "time up" ends the wall at that instant, not at endsAt.
    const early = applyAction(liveWall(), { type: 'wall:timeUp' }, makeCtx({ now: NOW + 5_000 }));
    expect(currentWall(early).endedAt).toBe(NOW + 5_000);
    const again = applyAction(s, { type: 'wall:timeUp' }, late);
    expect(again.wall).toEqual(s.wall);
    expect(again.version).toBe(s.version + 1);

    const ready = run(newGame(), [{ type: 'round:start', round: 'wall' }, { type: 'wall:show', team: 'pink' }]);
    expectError(ready, { type: 'wall:timeUp' });
  });
});

describe('Connecting Wall — resolution and scoring', () => {
  it('reveals unfound groups in pack order after the found ones, then asks each connection', () => {
    let s = liveWall();
    s = selectGroup(s, 2);
    s = applyAction(s, { type: 'wall:timeUp' }, makeCtx({ now: NOW + 200_000 }));
    s = applyAction(s, { type: 'wall:resolve' }, ctx);
    let play = currentWall(s);
    expect(play.stage).toBe('resolving');
    expect(play.resolvingGroup).toBe(0);
    expect(play.groups.map((g) => g.solvedOrder)).toEqual([1, 2, 0, 3]);
    expect(play.groups.map((g) => g.foundByTeam)).toEqual([false, false, true, false]);
    expect(play.tiles.map((t) => t.group)).toEqual([2, 2, 2, 2, 0, 0, 0, 0, 1, 1, 1, 1, 3, 3, 3, 3]);
    expect(allowedActions(s)).toEqual(expect.arrayContaining(['wall:connectionCorrect', 'wall:connectionIncorrect']));
    expectError(s, { type: 'wall:finish' });
    expectError(s, { type: 'wall:resolve' });

    s = applyAction(s, { type: 'wall:connectionCorrect' }, ctx);
    play = currentWall(s);
    expect(play.groups[2]).toMatchObject({ connectionRevealed: true, connectionCorrect: true });
    expect(play.resolvingGroup).toBe(1);
    s = applyAction(s, { type: 'wall:connectionIncorrect' }, ctx);
    expect(currentWall(s).groups[0]).toMatchObject({ connectionRevealed: true, connectionCorrect: false });
    s = run(s, [{ type: 'wall:connectionCorrect' }, { type: 'wall:connectionCorrect' }]);
    play = currentWall(s);
    expect(play.resolvingGroup).toBeNull();
    expect(play.groups.every((g) => g.connectionRevealed)).toBe(true);
    expect(allowedActions(s)).toContain('wall:finish');
    expectError(s, { type: 'wall:connectionCorrect' });

    s = applyAction(s, { type: 'wall:finish' }, ctx);
    play = currentWall(s);
    expect(play.stage).toBe('done');
    expect(play.awarded).toEqual({ groups: 1, connections: 3, bonus: 0, total: 4 });
    expect(s.teams.pink.score).toBe(4);
    expect(wallRound(s).completed).toEqual(['pink']);
    expect(allowedActions(s)).toContain('wall:clear');
  });

  it('awards 10 for a perfect 8/8 (bonus 2) and 3 for 2 groups + 1 connection', () => {
    let perfect = liveWall('blue');
    perfect = selectGroup(perfect, 0);
    perfect = selectGroup(perfect, 1);
    perfect = selectGroup(perfect, 2);
    perfect = resolveAndFinish(perfect);
    expect(currentWall(perfect).awarded).toEqual({ groups: 4, connections: 4, bonus: 2, total: 10 });
    expect(perfect.teams.blue.score).toBe(10);

    let partial = liveWall('pink');
    partial = selectGroup(partial, 3);
    partial = selectGroup(partial, 0);
    partial = applyAction(partial, { type: 'wall:timeUp' }, ctx);
    partial = resolveAndFinish(partial, [true, false, false, false]);
    expect(currentWall(partial).awarded).toEqual({ groups: 2, connections: 1, bonus: 0, total: 3 });
    expect(partial.teams.pink.score).toBe(3);

    // All groups found but one connection missed: no bonus.
    let nearly = liveWall('pink');
    nearly = selectGroup(nearly, 0);
    nearly = selectGroup(nearly, 1);
    nearly = selectGroup(nearly, 2);
    nearly = resolveAndFinish(nearly, [true, true, true, false]);
    expect(currentWall(nearly).awarded).toEqual({ groups: 4, connections: 3, bonus: 0, total: 7 });
  });

  it('completes the round once both teams have played their walls', () => {
    let s = liveWall('pink');
    s = selectGroup(s, 0);
    s = selectGroup(s, 1);
    s = selectGroup(s, 2);
    s = resolveAndFinish(s);
    expect(s.finishedRounds).toEqual([]);
    expectError(s, { type: 'wall:show', team: 'blue' }); // must clear first
    s = applyAction(s, { type: 'wall:clear' }, ctx);
    expect(wallRound(s).current).toBeNull();
    expectError(s, { type: 'wall:show', team: 'pink' }); // already played
    expect(allowedActions(s)).toContain('wall:show');

    s = run(s, [{ type: 'wall:show', team: 'blue' }, { type: 'wall:start' }]);
    expect(currentWall(s).team).toBe('blue');
    s = applyAction(s, { type: 'wall:timeUp' }, ctx);
    s = resolveAndFinish(s, [false, false, false, false]);
    expect(currentWall(s).awarded).toEqual({ groups: 0, connections: 0, bonus: 0, total: 0 });
    expect(wallRound(s).completed).toEqual(['pink', 'blue']);
    expect(s.finishedRounds).toEqual(['wall']);
    expect(s.teams).toMatchObject({ pink: { score: 10 }, blue: { score: 0 } });
    s = applyAction(s, { type: 'wall:clear' }, ctx);
    const allowed = allowedActions(s);
    expect(allowed.filter((a) => a.startsWith('wall:'))).toEqual([]);
    expect(allowed).toContain('round:start');
    expectError(s, { type: 'round:start', round: 'wall' });
  });

  it('cannot be abandoned while live, frozen or resolving', () => {
    let s = liveWall();
    expectError(s, { type: 'round:start', round: 'vowels' });
    expectError(s, { type: 'round:final' });
    s = applyAction(s, { type: 'wall:timeUp' }, ctx);
    expectError(s, { type: 'round:start', round: 'vowels' });
    s = applyAction(s, { type: 'wall:resolve' }, ctx);
    expectError(s, { type: 'round:start', round: 'vowels' });
    expect(allowedActions(s)).not.toContain('round:start');
    expect(allowedActions(s)).toContain('game:lobby'); // the escape hatch
  });
});
