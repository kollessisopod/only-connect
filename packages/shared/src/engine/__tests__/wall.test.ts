import { describe, expect, it } from 'vitest';
import { WALL_SECONDS, type GameState } from '../../types.js';
import { allowedActions, applyAction, describeState, roundProgress } from '../game.js';
import { projectPublic } from '../project.js';
import { nextWallHieroglyph, selectableWallHieroglyphs, wallHieroglyphs, wallOpener, wallSecondsRemaining } from '../wall.js';
import {
  currentWall,
  currentWallGlyph,
  customPack,
  expectError,
  groupTileIds,
  liveWall,
  makeCtx,
  mixedTileIds,
  newGame,
  resolveAndFinish,
  run,
  selectGroup,
  selectNextWall,
  selectTiles,
  unusedWallGlyphs,
  NOW,
  SEED,
} from './fixtures.js';

const ctx = makeCtx();

function wallRound(state: GameState) {
  if (!state.wall) throw new Error('no wall round');
  return state.wall;
}

/** Plays the wall on screen to a perfect 10 (3 groups found, 4th auto-solves, every connection right). */
function playPerfect(state: GameState): GameState {
  let s = applyAction(state, { type: 'wall:start' }, ctx);
  s = selectGroup(s, 0);
  s = selectGroup(s, 1);
  s = selectGroup(s, 2);
  return resolveAndFinish(s);
}

describe('Connecting Wall — setup', () => {
  it('starts on the wall grid with the team behind choosing (tie: the team that started the game)', () => {
    const base = newGame('pink');
    const s = applyAction(base, { type: 'round:start', round: 'wall' }, ctx);
    expect(wallRound(s)).toEqual({ stage: 'selecting', team: 'pink', available: ['lion', 'water'], used: [], current: null, wallsDone: 0, wallsTotal: 2 });
    expect(wallHieroglyphs(s.pack)).toEqual(['lion', 'water']);
    expect(selectableWallHieroglyphs(s)).toEqual(['lion', 'water']);
    expect(allowedActions(s).filter((a) => a.startsWith('wall:'))).toEqual(['wall:select']);
    expect(describeState(s)).toBe('Connecting Wall — wall 1 of 2: Pink Panthers to choose');
    expect(roundProgress(s)).toBeNull();
    expect(projectPublic(s, NOW).wall).toEqual({ stage: 'selecting', team: 'pink', available: ['lion', 'water'], used: [], current: null, wallsDone: 0, wallsTotal: 2 });

    const blueBehind = run(base, [{ type: 'game:adjustScore', team: 'pink', delta: 2 }, { type: 'round:start', round: 'wall' }]);
    expect(wallRound(blueBehind).team).toBe('blue');
    const pinkBehind = run(base, [{ type: 'game:adjustScore', team: 'blue', delta: 2 }, { type: 'round:start', round: 'wall' }]);
    expect(wallRound(pinkBehind).team).toBe('pink');
    const blueFirst = applyAction(newGame('blue'), { type: 'round:start', round: 'wall' }, ctx);
    expect(wallRound(blueFirst).team).toBe('blue');
    expect(wallOpener(newGame('blue'))).toBe('blue');
    expect(describeState(blueFirst)).toBe('Connecting Wall — wall 1 of 2: Blue Whales to choose');
  });

  it('a 4-wall pack puts all four glyphs on the grid, in HIEROGLYPHS order', () => {
    const s = applyAction(newGame('pink', makeCtx(), customPack({ walls: 4 })), { type: 'round:start', round: 'wall' }, ctx);
    expect(s.pack.walls.map((w) => w.hieroglyph)).toEqual(['lion', 'water', 'twoReeds', 'twistedFlax']);
    expect(wallRound(s)).toMatchObject({ available: ['twoReeds', 'lion', 'twistedFlax', 'water'], wallsTotal: 4, wallsDone: 0, team: 'pink' });
    expect(describeState(s)).toBe('Connecting Wall — wall 1 of 4: Pink Panthers to choose');
  });

  it('nextWallHieroglyph hands out lion, water, then the rest in grid order', () => {
    expect(nextWallHieroglyph([])).toBe('lion');
    expect(nextWallHieroglyph([{ hieroglyph: 'lion' }])).toBe('water');
    expect(nextWallHieroglyph([{ hieroglyph: 'water' }, { hieroglyph: 'lion' }])).toBe('twoReeds');
    expect(nextWallHieroglyph([{ hieroglyph: 'lion' }, { hieroglyph: 'water' }, { hieroglyph: 'twoReeds' }, { hieroglyph: 'twistedFlax' }])).toBe('hornedViper');
    expect(nextWallHieroglyph(customPack({ walls: 4 }).walls)).toBe('hornedViper');
  });

  it('wall:select needs an available, unused glyph and builds a deterministic 16-tile layout for the chooser', () => {
    let s = applyAction(newGame(), { type: 'round:start', round: 'wall' }, ctx);
    expectError(s, { type: 'wall:select', hieroglyph: 'twoReeds' }); // a question glyph, not a wall
    expectError(s, { type: 'wall:select', hieroglyph: 'sphinx' as 'lion' });
    expectError(s, { type: 'wall:select', tileId: 0 }); // a tile tap: no wall is on screen

    s = applyAction(s, { type: 'wall:select', hieroglyph: 'water' }, ctx);
    expect(wallRound(s)).toMatchObject({ stage: 'playing', team: 'pink', used: ['water'], wallsDone: 0 });
    const play = currentWall(s);
    expect(play.wallId).toBe(s.pack.walls.find((w) => w.hieroglyph === 'water')?.id);
    expect(play).toMatchObject({ team: 'pink', stage: 'ready', seed: SEED, selected: [], lives: null, startedAt: null, endsAt: null, endReason: null, resolvingGroup: null, awarded: null });
    expect(play.tiles.map((t) => t.id)).toEqual(Array.from({ length: 16 }, (_, i) => i));
    const wall = s.pack.walls.find((w) => w.id === play.wallId);
    const allClues = wall?.groups.flatMap((g) => g.clues).sort() ?? [];
    expect(play.tiles.map((t) => t.text).sort()).toEqual(allClues);
    for (const t of play.tiles) expect(wall?.groups[t.group].clues).toContain(t.text);
    expect(play.groups.map((g) => g.index)).toEqual([0, 1, 2, 3]);
    expect(play.groups.every((g) => g.solvedOrder === null && !g.foundByTeam && !g.connectionRevealed)).toBe(true);
    expect(describeState(s)).toBe('Connecting Wall — Pink Panthers (wall 1 of 2, Water): wall on screen, waiting to start');

    // Same seed -> same layout; different seed -> different layout; the layout is actually shuffled.
    const started = applyAction(newGame(), { type: 'round:start', round: 'wall' }, ctx);
    const again = applyAction(started, { type: 'wall:select', hieroglyph: 'water' }, ctx);
    expect(currentWall(again).tiles).toEqual(play.tiles);
    const other = applyAction(started, { type: 'wall:select', hieroglyph: 'water' }, makeCtx({ seed: 7 }));
    expect(currentWall(other).tiles.map((t) => t.text)).not.toEqual(play.tiles.map((t) => t.text));
    expect(play.tiles.map((t) => t.group)).not.toEqual([0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3]);

    expectError(s, { type: 'wall:select', hieroglyph: 'lion' }); // one wall at a time
    expectError(s, { type: 'wall:select', hieroglyph: 'water' });
    expect(selectableWallHieroglyphs(s)).toEqual([]);
    expect(allowedActions(s)).not.toContain('wall:select');
    expectError(s, { type: 'wall:select', tileId: 0 }, 'wall_not_live');
    expect(allowedActions(s)).toContain('wall:start');
    expect(projectPublic(s, NOW).wall).toMatchObject({ stage: 'playing', used: ['water'], current: { team: 'pink', stage: 'ready' } });
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

    const ready = selectNextWall(applyAction(newGame(), { type: 'round:start', round: 'wall' }, ctx));
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
    expect(wallRound(s)).toMatchObject({ stage: 'playing', used: ['lion'], wallsDone: 0 });
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

  it('2 walls: pink chooses, then blue chooses the one left; the round ends after the second', () => {
    let s = liveWall('pink');
    expect(currentWallGlyph(s)).toBe('lion');
    s = selectGroup(s, 0);
    s = selectGroup(s, 1);
    s = selectGroup(s, 2);
    s = resolveAndFinish(s);
    expect(s.finishedRounds).toEqual([]);
    expectError(s, { type: 'wall:select', hieroglyph: 'water' }); // must clear first
    expectError(s, { type: 'wall:abort' }); // scored: clear, not abort
    s = applyAction(s, { type: 'wall:clear' }, ctx);
    expect(wallRound(s)).toMatchObject({ stage: 'selecting', team: 'blue', used: ['lion'], current: null, wallsDone: 1, wallsTotal: 2 });
    expect(roundProgress(s)).toBe('1 of 2 walls played');
    expect(describeState(s)).toBe('Connecting Wall — wall 2 of 2: Blue Whales to choose');
    expectError(s, { type: 'wall:select', hieroglyph: 'lion' }); // already played
    expect(allowedActions(s)).toContain('wall:select');
    expect(selectableWallHieroglyphs(s)).toEqual(['water']);
    expect(unusedWallGlyphs(s)).toEqual(['water']);
    expect(projectPublic(s, NOW).wall).toEqual({ stage: 'selecting', team: 'blue', available: ['lion', 'water'], used: ['lion'], current: null, wallsDone: 1, wallsTotal: 2 });

    // The last glyph is still chosen explicitly (the grid shows it alone, lit).
    s = run(s, [{ type: 'wall:select', hieroglyph: 'water' }, { type: 'wall:start' }]);
    expect(currentWall(s).team).toBe('blue');
    expect(currentWallGlyph(s)).toBe('water');
    s = applyAction(s, { type: 'wall:timeUp' }, ctx);
    s = resolveAndFinish(s, [false, false, false, false]);
    expect(currentWall(s).awarded).toEqual({ groups: 0, connections: 0, bonus: 0, total: 0 });
    expect(wallRound(s).used).toEqual(['lion', 'water']);
    expect(s.finishedRounds).toEqual(['wall']);
    expect(s.teams).toMatchObject({ pink: { score: 10 }, blue: { score: 0 } });
    s = applyAction(s, { type: 'wall:clear' }, ctx);
    expect(wallRound(s)).toMatchObject({ stage: 'selecting', current: null, wallsDone: 2, wallsTotal: 2 });
    const allowed = allowedActions(s);
    expect(allowed.filter((a) => a.startsWith('wall:'))).toEqual([]);
    expect(allowed).toContain('round:start');
    expect(describeState(s)).toBe('Connecting Wall — all walls played; start the next round');
    expect(roundProgress(s)).toBeNull();
    expect(projectPublic(s, NOW).wall).toMatchObject({ stage: 'selecting', used: ['lion', 'water'], current: null, wallsDone: 2 });
    expectError(s, { type: 'round:start', round: 'wall' });
  });

  it('4 walls: the teams alternate A, B, A, B in any glyph order and points accumulate per team', () => {
    let s = applyAction(newGame('pink', makeCtx(), customPack({ walls: 4 })), { type: 'round:start', round: 'wall' }, ctx);
    expect(wallRound(s)).toMatchObject({ team: 'pink', available: ['twoReeds', 'lion', 'twistedFlax', 'water'], wallsTotal: 4 });
    expect(s.pack.walls.every((w) => w.groups.length === 4)).toBe(true);

    // Wall 1 — pink picks Water, perfect 10.
    s = applyAction(s, { type: 'wall:select', hieroglyph: 'water' }, ctx);
    expect(currentWall(s)).toMatchObject({ wallId: 'wall-2', team: 'pink', stage: 'ready' });
    s = playPerfect(s);
    expect(currentWall(s).awarded?.total).toBe(10);
    expect(s.teams.pink.score).toBe(10);
    expect(s.finishedRounds).toEqual([]);
    s = applyAction(s, { type: 'wall:clear' }, ctx);
    expect(wallRound(s)).toMatchObject({ team: 'blue', used: ['water'], wallsDone: 1 });
    expect(selectableWallHieroglyphs(s)).toEqual(['twoReeds', 'lion', 'twistedFlax']);
    expect(describeState(s)).toBe('Connecting Wall — wall 2 of 4: Blue Whales to choose');

    // Wall 2 — blue picks Lion, 2 groups + 1 connection = 3.
    s = run(s, [{ type: 'wall:select', hieroglyph: 'lion' }, { type: 'wall:start' }]);
    expect(currentWall(s)).toMatchObject({ wallId: 'wall-1', team: 'blue' });
    s = selectGroup(s, 3);
    s = selectGroup(s, 0);
    s = applyAction(s, { type: 'wall:timeUp' }, ctx);
    s = resolveAndFinish(s, [true, false, false, false]);
    expect(currentWall(s).awarded).toEqual({ groups: 2, connections: 1, bonus: 0, total: 3 });
    expect(s.teams.blue.score).toBe(3);
    s = applyAction(s, { type: 'wall:clear' }, ctx);
    expect(roundProgress(s)).toBe('2 of 4 walls played');
    expect(wallRound(s).team).toBe('pink');

    // Wall 3 — pink picks Twisted Flax.
    s = applyAction(s, { type: 'wall:select', hieroglyph: 'twistedFlax' }, ctx);
    expect(currentWall(s)).toMatchObject({ wallId: 'wall-4', team: 'pink' });
    s = playPerfect(s);
    expect(s.teams.pink.score).toBe(20);
    expect(s.finishedRounds).toEqual([]);
    s = applyAction(s, { type: 'wall:clear' }, ctx);
    expect(wallRound(s)).toMatchObject({ team: 'blue', used: ['water', 'lion', 'twistedFlax'], wallsDone: 3 });
    expect(projectPublic(s, NOW).wall).toMatchObject({ stage: 'selecting', team: 'blue', used: ['water', 'lion', 'twistedFlax'], current: null, wallsDone: 3, wallsTotal: 4 });

    // Wall 4 — blue takes the last glyph (Two Reeds), 4 groups, 3 connections = 7; the round is over.
    s = run(s, [{ type: 'wall:select', hieroglyph: 'twoReeds' }, { type: 'wall:start' }]);
    expect(currentWall(s)).toMatchObject({ wallId: 'wall-3', team: 'blue' });
    s = selectGroup(s, 0);
    s = selectGroup(s, 1);
    s = selectGroup(s, 2);
    s = resolveAndFinish(s, [true, true, true, false]);
    expect(currentWall(s).awarded).toEqual({ groups: 4, connections: 3, bonus: 0, total: 7 });
    expect(s.teams).toMatchObject({ pink: { score: 20 }, blue: { score: 10 } });
    expect(s.finishedRounds).toEqual(['wall']);
    s = applyAction(s, { type: 'wall:clear' }, ctx);
    expect(wallRound(s)).toMatchObject({ used: ['water', 'lion', 'twistedFlax', 'twoReeds'], wallsDone: 4, wallsTotal: 4 });
    expect(allowedActions(s).filter((a) => a.startsWith('wall:'))).toEqual([]);
    expect(describeState(s)).toBe('Connecting Wall — all walls played; start the next round');
  });

  it('wall:abort hands the wall back: glyph available again, same team chooses, nothing scored', () => {
    let s = liveWall('blue');
    expect(wallRound(s)).toMatchObject({ team: 'blue', used: ['lion'] });
    s = selectGroup(s, 0);
    s = applyAction(s, { type: 'wall:abort' }, ctx);
    expect(wallRound(s)).toEqual({ stage: 'selecting', team: 'blue', available: ['lion', 'water'], used: [], current: null, wallsDone: 0, wallsTotal: 2 });
    expect(s.teams).toMatchObject({ pink: { score: 0 }, blue: { score: 0 } });
    expect(s.finishedRounds).toEqual([]);
    expect(selectableWallHieroglyphs(s)).toEqual(['lion', 'water']);
    expect(describeState(s)).toBe('Connecting Wall — wall 1 of 2: Blue Whales to choose');
    // The same wall can be chosen again (freshly shuffled with a new seed) or the other one.
    const again = applyAction(s, { type: 'wall:select', hieroglyph: 'lion' }, makeCtx({ seed: 7 }));
    expect(currentWall(again)).toMatchObject({ team: 'blue', stage: 'ready' });
    expect(currentWall(again).tiles.map((t) => t.text)).not.toEqual(currentWall(liveWall('blue')).tiles.map((t) => t.text));

    // After the first wall is done, aborting the second one keeps the second chooser and the first result.
    s = playPerfect(selectNextWall(s));
    s = applyAction(s, { type: 'wall:clear' }, ctx);
    expect(wallRound(s)).toMatchObject({ team: 'pink', used: ['lion'], wallsDone: 1 });
    s = run(s, [{ type: 'wall:select', hieroglyph: 'water' }, { type: 'wall:start' }, { type: 'wall:timeUp' }, { type: 'wall:resolve' }]);
    s = applyAction(s, { type: 'wall:abort' }, ctx);
    expect(wallRound(s)).toMatchObject({ stage: 'selecting', team: 'pink', used: ['lion'], current: null, wallsDone: 1 });
    expect(s.teams).toMatchObject({ pink: { score: 0 }, blue: { score: 10 } });
    expect(s.finishedRounds).toEqual([]);
    s = playPerfect(applyAction(s, { type: 'wall:select', hieroglyph: 'water' }, ctx));
    expect(s.finishedRounds).toEqual(['wall']);
    expect(s.teams).toMatchObject({ pink: { score: 10 }, blue: { score: 10 } });
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
