/**
 * Test helpers: a deterministic context, a playable demo pack, and a few "play through" helpers.
 */
import { expect } from 'vitest';
import {
  GameError,
  HIEROGLYPHS,
  WALL_HIEROGLYPH_ORDER,
  otherTeam,
  type ActionContext,
  type GameAction,
  type GameState,
  type Hieroglyph,
  type Pack,
  type Question,
  type QuestionRound,
  type TeamId,
  type Wall,
  type WallPlay,
} from '../../types.js';
import { applyAction, createGame } from '../game.js';
import { buildDemoPack, type DemoPackOptions } from '../demo-pack.js';

export { buildDemoPack };

export const NOW = 1_700_000_000_000;
export const SEED = 42;

export function makeCtx(overrides: Partial<ActionContext> = {}): ActionContext {
  let n = 0;
  return { now: NOW, seed: SEED, newId: () => `id-${++n}`, ...overrides };
}

export function demoPack(options?: DemoPackOptions): Pack {
  let n = 0;
  return buildDemoPack(() => `pack-${++n}`, options);
}

/**
 * A demo-pack variant with a chosen number of questions per round (1..12) and walls (0..4; only 2 and 4 are
 * playable). Extra questions are text copies of the demo ones tagged with the next free hieroglyphs; extra
 * walls are copies of the demo walls (clues only have to be unique within a wall) tagged in
 * `WALL_HIEROGLYPH_ORDER` (lion, water, twoReeds, twistedFlax, ...). Ids stay unique and deterministic.
 */
export function customPack(opts: { connections?: number; sequences?: number; walls?: number } = {}): Pack {
  const base = demoPack({ media: false });
  const counts: Record<QuestionRound, number> = { connections: opts.connections ?? 6, sequences: opts.sequences ?? 6 };
  const questions: Question[] = [];
  for (const round of ['connections', 'sequences'] as const) {
    const demo = base.questions.filter((q) => q.round === round);
    for (let i = 0; i < counts[round]; i++) {
      const src = demo[i % demo.length];
      questions.push({
        ...src,
        id: `${round}-${i + 1}`,
        hieroglyph: HIEROGLYPHS[i],
        position: i,
        clues: src.clues.map((c) => ({ ...c, text: i < demo.length ? c.text : `${c.text} #${i + 1}` })),
        answer: i < demo.length ? src.answer : `${src.answer} #${i + 1}`,
      });
    }
  }
  const wallCount = opts.walls ?? 2;
  const walls: Wall[] = [];
  for (let i = 0; i < wallCount; i++) {
    const src = base.walls[i % base.walls.length];
    walls.push({
      id: `wall-${i + 1}`,
      position: i,
      hieroglyph: WALL_HIEROGLYPH_ORDER[i],
      groups: src.groups.map((g) => ({ connection: g.connection, clues: [...g.clues] })),
    });
  }
  return { ...base, id: 'custom-pack', name: 'Custom pack', questions, walls };
}

export const TEAM_NAMES: Record<TeamId, { name: string }> = {
  pink: { name: 'Pink Panthers' },
  blue: { name: 'Blue Whales' },
  green: { name: 'Green Geckos' },
  orange: { name: 'Orange Owls' },
};

/** The `game:new` team list for the given ids (creation order), named from `TEAM_NAMES`. */
export function teamList(ids: readonly TeamId[]): Array<{ id: TeamId; name: string }> {
  return ids.map((id) => ({ id, name: TEAM_NAMES[id].name }));
}

/** The show's two teams, pink created first. */
export const TEAM_LIST = teamList(['pink', 'blue']);

/**
 * A two-team game (pink and blue) with `first` created first, so with level scores the default round order
 * puts `first` first (`suggestedRoundOrder`): `newGame('blue')` is a game blue opens.
 */
export function newGame(first: TeamId = 'pink', ctx: ActionContext = makeCtx(), pack: Pack = demoPack()): GameState {
  return createGame(pack, teamList([first, otherTeam(first)]), ctx);
}

/** A game of the given teams, in creation order (3- and 4-team games need a 4-wall pack). */
export function newGameWith(ids: readonly TeamId[], pack: Pack = customPack({ walls: 4 }), ctx: ActionContext = makeCtx()): GameState {
  return createGame(pack, teamList(ids), ctx);
}

export function run(state: GameState, actions: GameAction[], ctx: ActionContext = makeCtx()): GameState {
  return actions.reduce((s, a) => applyAction(s, a, ctx), state);
}

/** Asserts that applying `action` throws a GameError (optionally with a given code). */
export function expectError(state: GameState, action: GameAction, code?: string, ctx: ActionContext = makeCtx()): void {
  let caught: unknown = null;
  try {
    applyAction(state, action, ctx);
  } catch (e) {
    caught = e;
  }
  expect(caught, `expected ${action.type} to throw`).toBeInstanceOf(GameError);
  if (code) expect((caught as GameError).code).toBe(code);
}

// --- players ---------------------------------------------------------------

export const PLAYERS = [
  { type: 'player:join', playerId: 'p-ann', name: 'Ann', team: 'pink' },
  { type: 'player:join', playerId: 'p-bob', name: 'Bob', team: 'blue' },
  { type: 'player:join', playerId: 'p-cat', name: 'Cat', team: 'pink' },
] as const satisfies readonly GameAction[];

export function withPlayers(state: GameState, ctx: ActionContext = makeCtx()): GameState {
  return run(state, [...PLAYERS], ctx);
}

// --- wall helpers ----------------------------------------------------------

export function currentWall(state: GameState): WallPlay {
  const play = state.wall?.current;
  if (!play) throw new Error('no wall on screen');
  return play;
}

/** Ids of the pack's walls in pack order. */
export function wallIds(state: GameState): string[] {
  return [...state.pack.walls].sort((a, b) => a.position - b.position).map((w) => w.id);
}

/** The wall glyphs not chosen yet, in grid (HIEROGLYPHS) order. */
export function unusedWallGlyphs(state: GameState): Hieroglyph[] {
  const round = state.wall;
  if (!round) throw new Error('no wall round');
  return round.available.filter((h) => !round.used.includes(h));
}

/** `wall:select` of the first glyph still on the wall grid (for the team whose turn it is). */
export function selectNextWall(state: GameState, ctx: ActionContext = makeCtx()): GameState {
  const [glyph] = unusedWallGlyphs(state);
  if (!glyph) throw new Error('every wall has been chosen');
  return applyAction(state, { type: 'wall:select', hieroglyph: glyph }, ctx);
}

/** The glyph of the wall on screen. */
export function currentWallGlyph(state: GameState): Hieroglyph {
  const wall = state.pack.walls.find((w) => w.id === currentWall(state).wallId);
  if (!wall) throw new Error('wall on screen is not in the pack');
  return wall.hieroglyph;
}

/** Tile ids (in display order) belonging to pack group `groupIndex` of the wall on screen. */
export function groupTileIds(state: GameState, groupIndex: number): number[] {
  return currentWall(state)
    .tiles.filter((t) => t.group === groupIndex)
    .map((t) => t.id);
}

/** One tile id from each of the given groups (a guaranteed wrong guess when 4 different groups are given). */
export function mixedTileIds(state: GameState, groups: number[]): number[] {
  return groups.map((g) => groupTileIds(state, g)[0]);
}

export function selectTiles(state: GameState, ids: number[], ctx: ActionContext = makeCtx()): GameState {
  return run(state, ids.map((tileId) => ({ type: 'wall:select', tileId })), ctx);
}

export function selectGroup(state: GameState, groupIndex: number, ctx: ActionContext = makeCtx()): GameState {
  return selectTiles(state, groupTileIds(state, groupIndex), ctx);
}

/**
 * Lobby -> wall round -> the first wall on the grid chosen and live for `team`. By default the game is created
 * with `team` as `firstTeam`, so (scores level) it is the one choosing; with a given `state` the fixture checks
 * that `team` really is the chooser.
 */
export function liveWall(team: TeamId = 'pink', ctx: ActionContext = makeCtx(), state: GameState = newGame(team)): GameState {
  const started = state.phase === 'wall' ? state : applyAction(state, { type: 'round:start', round: 'wall' }, ctx);
  if (started.wall?.team !== team) throw new Error(`fixture: ${started.wall?.team ?? '?'} chooses the wall, not ${team}`);
  return applyAction(selectNextWall(started, ctx), { type: 'wall:start' }, ctx);
}

/** Answers every connection with the given verdicts (default all correct) and finishes the wall. */
export function resolveAndFinish(state: GameState, verdicts: boolean[] = [true, true, true, true], ctx: ActionContext = makeCtx()): GameState {
  const actions: GameAction[] = [{ type: 'wall:resolve' }];
  for (const v of verdicts) actions.push({ type: v ? 'wall:connectionCorrect' : 'wall:connectionIncorrect' });
  actions.push({ type: 'wall:finish' });
  return run(state, actions, ctx);
}

// --- question helpers ------------------------------------------------------

/** Everything the audience must never see before it is revealed. */
export function packSecrets(pack: Pack): string[] {
  const out: string[] = [];
  for (const q of pack.questions) {
    out.push(q.answer);
    if (q.note) out.push(q.note);
  }
  for (const w of pack.walls) for (const g of w.groups) out.push(g.connection);
  for (const g of pack.vowelGroups) for (const c of g.clues) out.push(c.answer);
  return out;
}
