/**
 * Canned wall states for /dev/wall, built by running the real engine over the demo pack so every fixture is a
 * state the server could actually broadcast.
 */
import {
  WALL_SECONDS,
  applyAction,
  buildDemoPack,
  createGame,
  projectPublic,
  type ActionContext,
  type GameAction,
  type GameState,
  type PublicGameState,
  type PublicStateMessage,
  type TeamId,
} from '@only-connect/shared';

export interface WallFixture {
  id: string;
  title: string;
  /** Full state (the dev page applies wall:select to it locally so the panel is interactive). */
  full: GameState | null;
  state: PublicStateMessage | null;
  /** Optional transient notice to render. */
  notice?: string;
}

export const WALL_FIXTURE_IDS = [
  'waiting',
  'ready',
  'live-0',
  'live-2groups-lives',
  'live-wrong',
  'live-expired',
  'frozen-time',
  'frozen-lives',
  'complete',
  'resolving',
  'done',
] as const;

export const TEAM_NAMES: Record<TeamId, { name: string }> = {
  pink: { name: 'Nightwearers' },
  blue: { name: 'Frenemies' },
};

/** The team whose wall the fixtures show. */
export const WALL_TEAM: TeamId = 'blue';

export function makeCtx(now: number): ActionContext {
  let n = 0;
  return { now, seed: 42, newId: () => `fx-${++n}` };
}

function run(state: GameState, actions: GameAction[], ctx: ActionContext): GameState {
  return actions.reduce((s, a) => applyAction(s, a, ctx), state);
}

function groupTileIds(state: GameState, groupIndex: number): number[] {
  const play = state.wall?.current;
  if (!play) throw new Error('no wall on screen');
  return play.tiles.filter((t) => t.group === groupIndex).map((t) => t.id);
}

function select(state: GameState, ids: number[], ctx: ActionContext): GameState {
  return run(state, ids.map((tileId) => ({ type: 'wall:select', tileId })), ctx);
}

function selectGroup(state: GameState, groupIndex: number, ctx: ActionContext): GameState {
  return select(state, groupTileIds(state, groupIndex), ctx);
}

/** Two tiles from each of two groups: always a wrong guess. */
function wrongGuess(state: GameState, a: number, b: number, ctx: ActionContext): GameState {
  const ids = [...groupTileIds(state, a).slice(0, 2), ...groupTileIds(state, b).slice(0, 2)];
  return select(state, ids, ctx);
}

export function buildWallFixtures(base: number): Record<string, WallFixture> {
  let n = 0;
  const pack = buildDemoPack(() => `pack-${++n}`, { media: false });
  const ctx = makeCtx(base);
  const lobby = run(
    createGame(pack, TEAM_NAMES, 'pink', ctx),
    [
      // WALL_TEAM (blue) is behind on score, so the engine lets it choose the first wall.
      { type: 'game:adjustScore', team: 'pink', delta: 14 },
      { type: 'game:adjustScore', team: 'blue', delta: 11 },
      { type: 'player:join', playerId: 'p-mia', name: 'Mia', team: 'pink' },
      { type: 'player:join', playerId: 'p-bob', name: 'Bob', team: 'blue' },
    ],
    ctx,
  );
  const roundStarted = run(lobby, [{ type: 'round:start', round: 'wall' }], ctx);
  // round:start shows the wall glyph grid; the team behind on score (WALL_TEAM) chooses the Lion wall.
  if (roundStarted.wall?.team !== WALL_TEAM) throw new Error(`expected ${WALL_TEAM} to choose the first wall`);
  const ready = run(roundStarted, [{ type: 'wall:select', hieroglyph: 'lion' }], ctx);

  // Start the wall some seconds in the past so the timer bar has visibly moved.
  const startedAgo = (seconds: number) => run(ready, [{ type: 'wall:start' }], makeCtx(base - seconds * 1000));

  const live0 = startedAgo(25);
  const twoGroups = (() => {
    const t = makeCtx(base - 1000);
    let s = startedAgo(100);
    s = selectGroup(s, 2, t); // first group found → colour 1
    s = selectGroup(s, 0, t); // second → lives appear
    s = wrongGuess(s, 1, 3, t); // lives 2
    s = select(s, groupTileIds(s, 1).slice(0, 2), t); // two tiles selected, flash cleared
    return s;
  })();
  const liveWrong = (() => {
    const t = makeCtx(base - 500);
    let s = startedAgo(60);
    s = selectGroup(s, 1, t);
    s = wrongGuess(s, 0, 3, t);
    return s;
  })();
  // Still `live` in the state but the 2:30 clock (WALL_SECONDS) has run out: what a panel sees in the moment
  // before the server's wall:timeUp broadcast lands. Taps must be ignored client-side.
  const liveExpired = startedAgo(WALL_SECONDS + 1);
  const frozenTime = run(liveExpired, [{ type: 'wall:timeUp' }], makeCtx(base));
  const frozenLives = (() => {
    const t = makeCtx(base - 2000);
    let s = startedAgo(130);
    s = selectGroup(s, 3, t);
    s = selectGroup(s, 1, t);
    s = wrongGuess(s, 0, 2, t);
    s = wrongGuess(s, 0, 2, t);
    s = wrongGuess(s, 0, 2, t);
    return s;
  })();
  const complete = (() => {
    const t = makeCtx(base - 3000);
    let s = startedAgo(95);
    s = selectGroup(s, 1, t);
    s = selectGroup(s, 3, t);
    s = selectGroup(s, 0, t);
    return s;
  })();
  const resolving = run(
    frozenLives,
    [{ type: 'wall:resolve' }, { type: 'wall:connectionCorrect' }, { type: 'wall:connectionIncorrect' }],
    makeCtx(base),
  );
  const done = run(
    complete,
    [
      { type: 'wall:resolve' },
      { type: 'wall:connectionCorrect' },
      { type: 'wall:connectionCorrect' },
      { type: 'wall:connectionCorrect' },
      { type: 'wall:connectionCorrect' },
      { type: 'wall:finish' },
    ],
    makeCtx(base),
  );

  const fx = (id: string, title: string, full: GameState | null, extra: Partial<WallFixture> = {}): WallFixture => ({
    id,
    title,
    full,
    state: full ? projectPublic(full, base) : { id: null, phase: 'none', serverNow: base },
    ...extra,
  });

  return {
    waiting: fx('waiting', 'No wall on screen (waiting for the game master)', roundStarted),
    ready: fx('ready', 'Wall chosen, not started (get ready; public tiles are [])', ready),
    'live-0': fx('live-0', 'Live, nothing found yet, 25 s elapsed', live0),
    'live-2groups-lives': fx('live-2groups-lives', 'Live, 2 groups found, 2 lives, 2 tiles selected', twoGroups),
    'live-wrong': fx('live-wrong', 'Live, 1 group found, wrong guess flashing', liveWrong),
    'live-expired': fx('live-expired', 'Live but the clock has run out (time-up broadcast pending): taps ignored', liveExpired),
    'frozen-time': fx('frozen-time', "Frozen: time's up", frozenTime, { notice: "Time's up" }),
    'frozen-lives': fx('frozen-lives', 'Frozen: no lives left', frozenLives),
    complete: fx('complete', 'Frozen: wall complete', complete),
    resolving: fx('resolving', 'Resolving: asking connection 3 of 4', resolving),
    done: fx('done', 'Done: 10 points awarded', done),
  };
}

export function projectFixture(full: GameState, now: number): PublicGameState {
  return projectPublic(full, now);
}
