/**
 * Round 3 (Connecting Wall) reducers. SPEC §3.3, §10.
 */
import {
  TEAM_IDS,
  WALL_CONNECTION_POINT,
  WALL_GROUP_POINT,
  WALL_LIVES,
  WALL_PERFECT_BONUS,
  WALL_SECONDS,
  otherTeam,
  type ActionContext,
  type GameState,
  type PublicWallPlay,
  type TeamId,
  type Wall,
  type WallGroupState,
  type WallPlay,
  type WallRoundState,
  type WallTile,
} from '../types.js';
import { addScore, fail, markRoundFinished, withPlayMedia } from './common.js';
import { shuffleWithSeed } from './random.js';

export const WALL_MS = WALL_SECONDS * 1000;

function requireWallRound(state: GameState): WallRoundState {
  if (state.phase !== 'wall' || !state.wall) return fail('the wall round is not in progress');
  return state.wall;
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

function findWall(state: GameState, wallId: string | null): Wall | null {
  if (wallId === null) return null;
  return state.pack.walls.find((w) => w.id === wallId) ?? null;
}

/**
 * Starts the round with no wall on screen. Walls are pre-assigned the way the show does it (the team that is
 * behind gets wall 1; ties go to the team that started the game) but the admin can re-assign freely.
 */
export function startWallRound(state: GameState): GameState {
  const walls = [...state.pack.walls].sort((a, b) => a.position - b.position);
  const pink = state.teams.pink.score;
  const blue = state.teams.blue.score;
  const behind: TeamId = pink < blue ? 'pink' : blue < pink ? 'blue' : state.firstTeam;
  const ahead = otherTeam(behind);
  const assignment: Record<TeamId, string | null> = { pink: null, blue: null };
  assignment[behind] = walls[0]?.id ?? null;
  assignment[ahead] = walls[1]?.id ?? walls[0]?.id ?? null;
  const round: WallRoundState = { assignment, current: null, completed: [] };
  return withPlayMedia({ ...state, phase: 'wall', question: null, vowels: null, wall: round }, null);
}

export function assignWall(state: GameState, team: TeamId, wallId: string): GameState {
  const round = requireWallRound(state);
  if (!findWall(state, wallId)) return fail('unknown wall');
  if (round.completed.includes(team)) return fail(`${state.teams[team].name} have already played their wall`);
  if (round.current && round.current.team === team) return fail('that team’s wall is already on screen');
  return setWall(state, { ...round, assignment: { ...round.assignment, [team]: wallId } });
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

export function showWall(state: GameState, team: TeamId, ctx: ActionContext): GameState {
  const round = requireWallRound(state);
  if (round.current) return fail('a wall is already on screen (clear it first)');
  if (round.completed.includes(team)) return fail(`${state.teams[team].name} have already played their wall`);
  const wall = findWall(state, round.assignment[team]);
  if (!wall) return fail(`no wall assigned to ${state.teams[team].name}`);
  return setWall(state, { ...round, current: buildWallPlay(wall, team, ctx.seed) });
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

export function finishWall(state: GameState): GameState {
  const { round, play } = requireCurrent(state);
  if (play.stage !== 'resolving') return fail('the wall is not being resolved');
  if (play.resolvingGroup !== null) return fail('not every connection has been judged yet');
  const awarded = computeAwarded(play);
  const scored = addScore(state, play.team, awarded.total);
  const completed = round.completed.includes(play.team) ? round.completed : [...round.completed, play.team];
  const next = setWall(scored, { ...round, current: { ...play, stage: 'done', awarded }, completed });
  return completed.length >= TEAM_IDS.length ? markRoundFinished(next, 'wall') : next;
}

export function clearWall(state: GameState): GameState {
  const { round, play } = requireCurrent(state);
  if (play.stage !== 'done') return fail('the wall has not been finished yet');
  return setWall(state, { ...round, current: null });
}

/**
 * Take an unfinished wall off screen without awarding anything (shown for the wrong team, started by
 * mistake, a stray "time up"). The team is not marked completed, so its wall can be shown again (freshly
 * shuffled). A `done` wall cannot be aborted (its points are banked; use `wall:clear`).
 */
export function abortWall(state: GameState): GameState {
  const { round, play } = requireCurrent(state);
  if (play.stage === 'done') return fail('the wall has already been scored (clear it instead)');
  return setWall(state, { ...round, current: null });
}

/** Seconds left on a live wall (0 when ended or not started). */
export function wallSecondsRemaining(play: PublicWallPlay | WallPlay, now: number): number {
  if (play.stage !== 'live' || play.endsAt === null) return 0;
  return Math.max(0, Math.ceil((play.endsAt - now) / 1000));
}

export type WallAdminActionType =
  | 'wall:assign'
  | 'wall:show'
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
  const round = state.wall;
  const play = round.current;
  const out: WallAdminActionType[] = [];
  // A team can be (re)assigned a wall until it has played, and not while its own wall is on screen
  // (mirrors `assignWall`).
  const assignable = TEAM_IDS.filter((t) => !round.completed.includes(t) && play?.team !== t);
  if (assignable.length > 0) out.push('wall:assign');
  if (!play) {
    if (assignable.some((t) => round.assignment[t] !== null)) out.push('wall:show');
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
