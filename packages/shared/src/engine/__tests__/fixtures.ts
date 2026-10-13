/**
 * Test helpers: a deterministic context, a playable demo pack, and a few "play through" helpers.
 */
import { expect } from 'vitest';
import {
  GameError,
  type ActionContext,
  type GameAction,
  type GameState,
  type Pack,
  type TeamId,
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

export const TEAM_NAMES = { pink: { name: 'Pink Panthers' }, blue: { name: 'Blue Whales' } };

export function newGame(firstTeam: TeamId = 'pink', ctx: ActionContext = makeCtx(), pack: Pack = demoPack()): GameState {
  return createGame(pack, TEAM_NAMES, firstTeam, ctx);
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

/** Lobby -> wall round -> the given team's wall on screen and live. */
export function liveWall(team: TeamId = 'pink', ctx: ActionContext = makeCtx(), state: GameState = newGame()): GameState {
  return run(state, [{ type: 'round:start', round: 'wall' }, { type: 'wall:show', team }, { type: 'wall:start' }], ctx);
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
