/**
 * Round 3 (Connecting Wall) reducers. SPEC §3.3, §10.
 *
 * Walls are chosen by hieroglyph exactly like questions: the team whose turn it is picks one of the pack's
 * wall glyphs (`wall:select`), plays it, and after `wall:clear` the next team in the round's order picks from
 * what is left (V3.2: wall k is chosen by `order[k % n]`; the round plays `wallsTotalFor` walls so every team
 * plays the same number).
 */
import {
  HIEROGLYPHS,
  HIEROGLYPH_LABELS,
  WALL_CONNECTION_POINT,
  WALL_GROUP_POINT,
  WALL_HIEROGLYPH_ORDER,
  WALL_LIVES,
  WALL_PERFECT_BONUS,
  WALL_SECONDS,
  type ActionContext,
  type GameState,
  type Hieroglyph,
  type Pack,
  type PublicWallPlay,
  type TeamId,
  type Wall,
  type WallGroupState,
  type WallPlay,
  type WallRoundState,
  type WallTile,
} from '../types.js';
import { addScore, fail, isRoundFinished, markRoundFinished, withPlayMedia } from './common.js';
import { shuffleWithSeed } from './random.js';
import { wallOrder } from './teams.js';

export const WALL_MS = WALL_SECONDS * 1000;

function requireWallRound(state: GameState): WallRoundState {
  if (state.phase !== 'wall' || !state.wall) return fail('the wall round is not in progress');
  return state.wall;
}

/** The pack's walls in pack order (by position). */
export function packWalls(state: GameState): Wall[] {
  return [...state.pack.walls].sort((a, b) => a.position - b.position);
}

/** The hieroglyphs of a pack's walls (the wall grid), in HIEROGLYPHS order. */
export function wallHieroglyphs(pack: Pack): Hieroglyph[] {
  const tagged = new Set(pack.walls.map((w) => w.hieroglyph));
  return HIEROGLYPHS.filter((h) => tagged.has(h));
}

/** The pack wall tagged with `hieroglyph`, or null. */
export function wallByHieroglyph(pack: Pack, hieroglyph: Hieroglyph): Wall | null {
  return pack.walls.find((w) => w.hieroglyph === hieroglyph) ?? null;
}

/**
 * The glyph the editor gives a new wall: the first one no existing wall uses, in `WALL_HIEROGLYPH_ORDER`
 * (lion, water, then the rest). Null when all twelve are taken.
 */
export function nextWallHieroglyph(walls: ReadonlyArray<Pick<Wall, 'hieroglyph'>>): Hieroglyph | null {
  const taken = new Set(walls.map((w) => w.hieroglyph));
  return WALL_HIEROGLYPH_ORDER.find((h) => !taken.has(h)) ?? null;
}

/**
 * How many walls a round plays: the largest multiple of the team count the pack can supply, so every team
 * chooses and plays the same number (2 teams / 4 walls → 4; 3 teams / 4 walls → 3; 4 teams / 4 walls → 4).
 * `game:new` refuses a pack with fewer walls than teams, so this is never 0 for a real game.
 */
export function wallsTotalFor(packWallCount: number, teamCount: number): number {
  return Math.floor(packWallCount / teamCount) * teamCount;
}

/** The team that chooses wall `wallsDone` of the round: the order wraps (`order[k % n]`). */
export function teamForWall(order: readonly TeamId[], wallsDone: number): TeamId {
  return order[wallsDone % order.length];
}

/**
 * Glyphs the choosing team can pick right now (none unless stage `selecting` with walls left). A pack can
 * hold more walls than the round plays (4 walls, 3 teams): the extra glyph stays on the grid, never chosen.
 */
export function selectableWallHieroglyphs(state: GameState): Hieroglyph[] {
  const round = state.phase === 'wall' ? state.wall : null;
  if (!round || round.stage !== 'selecting' || round.current || isRoundFinished(state, 'wall')) return [];
  if (round.used.length >= round.wallsTotal) return [];
  return round.available.filter((h) => !round.used.includes(h));
}

function requireCurrent(state: GameState): { round: WallRoundState; play: WallPlay } {
  const round = requireWallRound(state);
  if (!round.current) return fail('no wall is on screen');
  return { round, play: round.current };
}

function setWall(state: GameState, round: WallRoundState): GameState {
  return { ...state, wall: round };
}

function setPlay(state: GameState, play: WallPlay): GameState {
  const round = requireWallRound(state);
  return setWall(state, { ...round, current: play });
}

/**
 * Starts the round on the wall grid: every wall of the pack is available, nothing is used, and the first team
 * of `order` (chosen by the host at `round:start`, already validated) chooses first.
 */
export function startWallRound(state: GameState, order: TeamId[]): GameState {
  const available = wallHieroglyphs(state.pack);
  const round: WallRoundState = {
    stage: 'selecting',
    order: [...order],
    team: teamForWall(order, 0),
    available,
    used: [],
    current: null,
    wallsDone: 0,
    wallsTotal: wallsTotalFor(available.length, order.length),
  };
  return withPlayMedia({ ...state, phase: 'wall', question: null, vowels: null, wall: round }, null);
}

/** Builds the shuffled tile layout for a wall: tile ids are positions (0..15) in the shuffled display order. */
export function buildWallPlay(wall: Wall, team: TeamId, seed: number): WallPlay {
  const raw: Array<{ text: string; group: number }> = [];
  wall.groups.forEach((g, gi) => g.clues.forEach((text) => raw.push({ text, group: gi })));
  const shuffled = shuffleWithSeed(raw, seed);
  const tiles: WallTile[] = shuffled.map((t, i) => ({ id: i, text: t.text, group: t.group }));
  const groups: WallGroupState[] = wall.groups.map((g, gi) => ({
    index: gi,
    connection: g.connection,
    solvedOrder: null,
    foundByTeam: false,
    connectionRevealed: false,
    connectionCorrect: null,
  }));
  return {
    wallId: wall.id,
    team,
    stage: 'ready',
    seed,
    tiles,
    groups,
    selected: [],
    lastWrong: null,
    lives: null,
    startedAt: null,
    endsAt: null,
    endReason: null,
    endedAt: null,
    resolvingGroup: null,
    awarded: null,
  };
}

/**
 * The choosing team picks a wall by its glyph: the wall goes on screen (stage `ready`) for that team, the
 * glyph is marked used and the round moves to `playing`.
 */
export function selectWall(state: GameState, hieroglyph: Hieroglyph, ctx: ActionContext): GameState {
  const round = requireWallRound(state);
  if (round.stage !== 'selecting' || round.current) return fail('a wall is already on screen (clear it first)');
  if (!HIEROGLYPHS.includes(hieroglyph)) return fail(`unknown hieroglyph "${String(hieroglyph)}"`);
  if (round.used.includes(hieroglyph)) return fail(`the ${HIEROGLYPH_LABELS[hieroglyph]} wall has already been played`);
  if (!round.available.includes(hieroglyph)) return fail(`${HIEROGLYPH_LABELS[hieroglyph]} is not one of this pack's walls`);
  if (isRoundFinished(state, 'wall') || round.used.length >= round.wallsTotal) return fail('the wall round is over');
  const wall = wallByHieroglyph(state.pack, hieroglyph);
  if (!wall) return fail(`no wall for ${HIEROGLYPH_LABELS[hieroglyph]}`);
  return setWall(state, {
    ...round,
    stage: 'playing',
    used: [...round.used, hieroglyph],
    current: buildWallPlay(wall, round.team, ctx.seed),
  });
}

export function startWall(state: GameState, ctx: ActionContext): GameState {
  const { play } = requireCurrent(state);
  if (play.stage !== 'ready') return fail('the wall has already started');
  return setPlay(state, { ...play, stage: 'live', startedAt: ctx.now, endsAt: ctx.now + WALL_MS });
}

/** Re-orders tiles so solved groups occupy the top rows in solve order; the rest keep their relative order. */
function reorderTiles(play: WallPlay): WallTile[] {
  const solved = play.groups
    .filter((g) => g.solvedOrder !== null)
    .sort((a, b) => (a.solvedOrder as number) - (b.solvedOrder as number));
  const out: WallTile[] = [];
  for (const g of solved) out.push(...play.tiles.filter((t) => t.group === g.index));
  const solvedIdx = new Set(solved.map((g) => g.index));
  out.push(...play.tiles.filter((t) => !solvedIdx.has(t.group)));
  return out;
}

function solvedCount(play: WallPlay): number {
  return play.groups.filter((g) => g.solvedOrder !== null).length;
}

function solveGroup(play: WallPlay, groupIndex: number, foundByTeam: boolean): WallPlay {
  const order = solvedCount(play);
  const groups = play.groups.map((g) => (g.index === groupIndex ? { ...g, solvedOrder: order, foundByTeam } : g));
  const next = { ...play, groups };
  return { ...next, tiles: reorderTiles(next) };
}

export function selectTile(state: GameState, tileId: number, ctx: ActionContext): GameState {
  const { play } = requireCurrent(state);
  if (play.stage !== 'live') return fail('the wall is not live', 'wall_not_live');
  if (play.endsAt !== null && ctx.now >= play.endsAt) return fail('time is up', 'wall_time_up');
  const tile = play.tiles.find((t) => t.id === tileId);
  if (!tile) return fail('unknown tile');
  const group = play.groups[tile.group];
  if (group.solvedOrder !== null) return fail('that tile is already in a solved group');

  if (play.selected.includes(tileId)) {
    return setPlay(state, { ...play, selected: play.selected.filter((id) => id !== tileId), lastWrong: null });
  }
  const selected = [...play.selected, tileId];
  if (selected.length < 4) return setPlay(state, { ...play, selected, lastWrong: null });

  // Fourth tile: resolve the guess immediately.
  const groupsOfSelection = new Set(selected.map((id) => play.tiles.find((t) => t.id === id)?.group));
  if (groupsOfSelection.size === 1) {
    let next = solveGroup({ ...play, selected: [], lastWrong: null }, tile.group, true);
    const found = solvedCount(next);
    if (found === 2) next = { ...next, lives: WALL_LIVES };
    if (found === 3) {
      const last = next.groups.find((g) => g.solvedOrder === null);
      if (last) next = solveGroup(next, last.index, true);
      next = { ...next, stage: 'frozen', endReason: 'complete', endedAt: ctx.now };
    }
    return setPlay(state, next);
  }

  let next: WallPlay = { ...play, selected: [], lastWrong: selected };
  if (next.lives !== null) {
    const lives = Math.max(0, next.lives - 1);
    next = { ...next, lives };
    if (lives === 0) next = { ...next, stage: 'frozen', endReason: 'lives', endedAt: ctx.now };
  }
  return setPlay(state, next);
}

/** Time is up. Returns the state unchanged (bar the version bump) if the wall already ended. */
export function wallTimeUp(state: GameState, ctx: ActionContext): GameState {
  const { play } = requireCurrent(state);
  if (play.stage === 'ready') return fail('the wall has not started');
  if (play.stage !== 'live') return state;
  // The clock ran out at `endsAt`; an admin "time up" pressed early ends it right now.
  const endedAt = play.endsAt !== null ? Math.min(play.endsAt, ctx.now) : ctx.now;
  return setPlay(state, { ...play, stage: 'frozen', endReason: 'time', selected: [], endedAt });
}

export function resolveWall(state: GameState): GameState {
  const { play } = requireCurrent(state);
  if (play.stage !== 'frozen') return fail('the wall has not ended yet');
  let next: WallPlay = { ...play, selected: [], lastWrong: null };
  for (const g of play.groups) {
    if (g.solvedOrder === null) next = solveGroup(next, g.index, false);
  }
  return setPlay(state, { ...next, stage: 'resolving', resolvingGroup: 0 });
}

function judgeConnection(state: GameState, correct: boolean): GameState {
  const { play } = requireCurrent(state);
  if (play.stage !== 'resolving' || play.resolvingGroup === null) return fail('no connection is being asked');
  const current = play.resolvingGroup;
  const groups = play.groups.map((g) =>
    g.solvedOrder === current ? { ...g, connectionRevealed: true, connectionCorrect: correct } : g,
  );
  const resolvingGroup = current + 1 < groups.length ? current + 1 : null;
  return setPlay(state, { ...play, groups, resolvingGroup });
}

export function connectionCorrect(state: GameState): GameState {
  return judgeConnection(state, true);
}

export function connectionIncorrect(state: GameState): GameState {
  return judgeConnection(state, false);
}

export function computeAwarded(play: WallPlay): NonNullable<WallPlay['awarded']> {
  const groups = play.groups.filter((g) => g.foundByTeam).length * WALL_GROUP_POINT;
  const connections = play.groups.filter((g) => g.connectionCorrect === true).length * WALL_CONNECTION_POINT;
  const perfect = play.groups.every((g) => g.foundByTeam && g.connectionCorrect === true);
  const bonus = perfect ? WALL_PERFECT_BONUS : 0;
  return { groups, connections, bonus, total: groups + connections + bonus };
}

/**
 * Awards the wall's points (stage `done`). The round is finished as soon as the last wall is scored: every
 * glyph has been chosen (`used.length === wallsTotal`) and the wall on screen is banked.
 */
export function finishWall(state: GameState): GameState {
  const { round, play } = requireCurrent(state);
  if (play.stage !== 'resolving') return fail('the wall is not being resolved');
  if (play.resolvingGroup !== null) return fail('not every connection has been judged yet');
  const awarded = computeAwarded(play);
  const scored = addScore(state, play.team, awarded.total);
  const next = setWall(scored, { ...round, current: { ...play, stage: 'done', awarded } });
  return round.used.length >= round.wallsTotal ? markRoundFinished(next, 'wall') : next;
}

/**
 * Takes a scored wall off screen: one more wall done, and the next team in the order chooses. The resolved
 * `order` is written back so a state persisted before V3.2 carries it from here on.
 */
export function clearWall(state: GameState): GameState {
  const { round, play } = requireCurrent(state);
  if (play.stage !== 'done') return fail('the wall has not been finished yet');
  const order = wallOrder(state, round);
  const wallsDone = round.wallsDone + 1;
  return setWall(state, {
    ...round,
    order,
    stage: 'selecting',
    team: teamForWall(order, wallsDone),
    current: null,
    wallsDone,
  });
}

/**
 * Hand an unfinished wall back (shown by mistake, started by mistake, a stray "time up"): it goes off screen,
 * nothing is awarded, its glyph becomes available again and the same team chooses again. A `done` wall cannot
 * be aborted (its points are banked; use `wall:clear`).
 */
export function abortWall(state: GameState): GameState {
  const { round, play } = requireCurrent(state);
  if (play.stage === 'done') return fail('the wall has already been scored (clear it instead)');
  const wall = state.pack.walls.find((w) => w.id === play.wallId);
  const glyph = wall ? wall.hieroglyph : null;
  return setWall(state, {
    ...round,
    stage: 'selecting',
    current: null,
    used: glyph === null ? round.used : round.used.filter((h) => h !== glyph),
  });
}

/** Seconds left on a live wall (0 when ended or not started). */
export function wallSecondsRemaining(play: PublicWallPlay | WallPlay, now: number): number {
  if (play.stage !== 'live' || play.endsAt === null) return 0;
  return Math.max(0, Math.ceil((play.endsAt - now) / 1000));
}

export type WallAdminActionType =
  | 'wall:select'
  | 'wall:start'
  | 'wall:timeUp'
  | 'wall:abort'
  | 'wall:resolve'
  | 'wall:connectionCorrect'
  | 'wall:connectionIncorrect'
  | 'wall:finish'
  | 'wall:clear';

export function allowedWallActions(state: GameState): WallAdminActionType[] {
  if (state.phase !== 'wall' || !state.wall) return [];
  const play = state.wall.current;
  const out: WallAdminActionType[] = [];
  if (!play) {
    // Selecting: a wall can be chosen while any glyph is left (mirrors `selectWall`).
    if (selectableWallHieroglyphs(state).length > 0) out.push('wall:select');
    return out;
  }
  switch (play.stage) {
    case 'ready':
      out.push('wall:start', 'wall:abort');
      break;
    case 'live':
      out.push('wall:timeUp', 'wall:abort');
      break;
    case 'frozen':
      out.push('wall:resolve', 'wall:abort');
      break;
    case 'resolving':
      if (play.resolvingGroup === null) out.push('wall:finish');
      else out.push('wall:connectionCorrect', 'wall:connectionIncorrect');
      out.push('wall:abort');
      break;
    case 'done':
      out.push('wall:clear');
      break;
    default:
      break;
  }
  return out;
}

/** True while a wall is being played or resolved (the round must not be abandoned at that point). */
export function isMidWall(state: GameState): boolean {
  const play = state.phase === 'wall' ? state.wall?.current : null;
  if (!play) return false;
  return play.stage === 'live' || play.stage === 'frozen' || play.stage === 'resolving';
}
