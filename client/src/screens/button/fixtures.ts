/**
 * Canned buzzer states for /dev/button, produced by the real engine over the demo pack.
 */
import {
  WALL_HIEROGLYPH_ORDER,
  applyAction,
  buildDemoPack,
  createGame,
  projectPublic,
  type ActionContext,
  type GameAction,
  type GameState,
  type Pack,
  type PublicStateMessage,
  type TeamId,
  type Wall,
} from '@only-connect/shared';
import type { BuzzFeedback, ButtonPlayer } from './ButtonView';

export interface ButtonFixture {
  id: string;
  title: string;
  /** `null` renders the join form instead of the buzzer. */
  state: PublicStateMessage | null;
  player: ButtonPlayer;
  feedback?: BuzzFeedback | null;
  connected?: boolean;
  joining?: boolean;
  join?: boolean;
}

export const BUTTON_FIXTURE_IDS = [
  'join',
  'lobby',
  'waiting',
  'open',
  'locked',
  'buzzed-me',
  'buzzed-other',
  'too-late',
  'closed',
  'correct',
  'wrong',
  'offline',
  'join-4',
  'open-green',
  'buzzed-orange',
  'closed-3',
  'steal-3',
  'final-4',
] as const;

export const ME: ButtonPlayer = { playerId: 'p-mia', name: 'Mia', team: 'pink' };

const TEAM_NAMES: Record<TeamId, string> = {
  pink: 'Nightwearers',
  blue: 'Frenemies',
  green: 'Geckos',
  orange: 'Marmalades',
};

function makeCtx(now: number): ActionContext {
  let n = 0;
  return { now, seed: 7, newId: () => `fx-${++n}` };
}

function run(state: GameState, actions: GameAction[], ctx: ActionContext): GameState {
  return actions.reduce((s, a) => applyAction(s, a, ctx), state);
}

/** The teams of a game, in creation order, with the fixture names. */
function teamList(ids: readonly TeamId[]): Array<{ id: TeamId; name: string }> {
  return ids.map((id) => ({ id, name: TEAM_NAMES[id] }));
}

/**
 * The demo pack holds the show's two walls, which is one wall per team at most for two teams; a three- or
 * four-team game needs four (`not_enough_walls` otherwise), so the two walls are repeated under fresh glyphs.
 */
function fourWallPack(pack: Pack): Pack {
  const walls: Wall[] = [];
  for (let i = 0; i < 4; i++) {
    const src = pack.walls[i % pack.walls.length];
    walls.push({
      id: `${src.id}-${i + 1}`,
      position: i,
      hieroglyph: WALL_HIEROGLYPH_ORDER[i],
      groups: src.groups.map((g) => ({ connection: g.connection, clues: [...g.clues] })),
    });
  }
  return { ...pack, walls };
}

export function buildButtonFixtures(base: number): Record<string, ButtonFixture> {
  let n = 0;
  const pack = buildDemoPack(() => `pack-${++n}`, { media: false });
  const ctx = makeCtx(base);
  const lobby = run(
    createGame(pack, teamList(['pink', 'blue']), ctx),
    [
      { type: 'game:adjustScore', team: 'pink', delta: 17 },
      { type: 'game:adjustScore', team: 'blue', delta: 20 },
      { type: 'player:join', playerId: ME.playerId, name: ME.name, team: ME.team },
      { type: 'player:join', playerId: 'p-bob', name: 'Bob', team: 'blue' },
      { type: 'player:join', playerId: 'p-cat', name: 'Cat', team: 'pink' },
    ],
    ctx,
  );
  const waiting = run(lobby, [{ type: 'round:start', round: 'vowels' }], ctx);
  const open = run(waiting, [{ type: 'vowels:showClue' }], ctx);
  const buzzedMe = run(open, [{ type: 'player:buzz', playerId: ME.playerId }], ctx);
  const buzzedOther = run(open, [{ type: 'player:buzz', playerId: 'p-bob' }], ctx);
  const locked = run(buzzedMe, [{ type: 'vowels:reopen' }], ctx);
  const closed = run(buzzedOther, [{ type: 'vowels:incorrect' }], ctx);
  const correct = run(buzzedMe, [{ type: 'vowels:correct' }], ctx);
  const wrong = run(buzzedMe, [{ type: 'vowels:incorrect' }, { type: 'vowels:nobody' }], ctx);

  // V3.2: three- and four-team games. Mia plays green in the four-team one.
  const bigPack = fourWallPack(pack);
  const meGreen: ButtonPlayer = { ...ME, team: 'green' };
  const lobby4 = run(
    createGame(bigPack, teamList(['pink', 'blue', 'green', 'orange']), ctx),
    [
      { type: 'game:adjustScore', team: 'pink', delta: 12 },
      { type: 'game:adjustScore', team: 'blue', delta: 20 },
      { type: 'game:adjustScore', team: 'green', delta: 20 },
      { type: 'game:adjustScore', team: 'orange', delta: 9 },
      { type: 'player:join', playerId: ME.playerId, name: ME.name, team: 'green' },
      { type: 'player:join', playerId: 'p-bob', name: 'Bob', team: 'blue' },
      { type: 'player:join', playerId: 'p-cat', name: 'Cat', team: 'pink' },
      { type: 'player:join', playerId: 'p-dan', name: 'Dan', team: 'orange' },
    ],
    ctx,
  );
  const open4 = run(lobby4, [{ type: 'round:start', round: 'vowels' }, { type: 'vowels:showClue' }], ctx);
  const buzzedOrange = run(open4, [{ type: 'player:buzz', playerId: 'p-dan' }], ctx);
  // The final can only follow a round: go there from Missing Vowels (not busy while the category is up).
  const final4 = run(lobby4, [{ type: 'round:start', round: 'vowels' }, { type: 'round:final' }], ctx);
  const lobby3 = run(
    createGame(bigPack, teamList(['pink', 'blue', 'green']), ctx),
    [
      { type: 'player:join', playerId: ME.playerId, name: ME.name, team: ME.team },
      { type: 'player:join', playerId: 'p-bob', name: 'Bob', team: 'blue' },
      { type: 'player:join', playerId: 'p-eve', name: 'Eve', team: 'green' },
    ],
    ctx,
  );
  // Bob (blue) buzzed and was wrong: both other teams may answer.
  const closed3 = run(
    lobby3,
    [{ type: 'round:start', round: 'vowels' }, { type: 'vowels:showClue' }, { type: 'player:buzz', playerId: 'p-bob' }, { type: 'vowels:incorrect' }],
    ctx,
  );
  // Connections, pink answered wrong after all four clues: blue or green may steal.
  const connections3 = run(lobby3, [{ type: 'round:start', round: 'connections', order: ['pink', 'blue', 'green'] }], ctx);
  const steal3 = run(
    connections3,
    [
      { type: 'q:select', hieroglyph: connections3.question?.available[0] ?? 'twoReeds' },
      { type: 'q:reveal' },
      { type: 'q:reveal' },
      { type: 'q:reveal' },
      { type: 'q:incorrect' },
    ],
    ctx,
  );

  const fx = (id: string, title: string, full: GameState | null, extra: Partial<ButtonFixture> = {}): ButtonFixture => ({
    id,
    title,
    state: full ? projectPublic(full, base) : null,
    player: ME,
    ...extra,
  });

  return {
    join: fx('join', 'Join form', lobby, { join: true }),
    lobby: fx('lobby', 'Joined, game in the lobby (Missing Vowels not started)', lobby),
    waiting: fx('waiting', 'Category shown, waiting for the clue', waiting),
    open: fx('open', 'Clue live — buzzers open', open),
    locked: fx('locked', 'Clue reopened after my false buzz — I am locked out', locked),
    'buzzed-me': fx('buzzed-me', 'I buzzed first', buzzedMe, { feedback: { kind: 'won', text: 'You buzzed first!' } }),
    'buzzed-other': fx('buzzed-other', 'Bob (blue) buzzed first', buzzedOther),
    'too-late': fx('too-late', 'I pressed but Bob was first', buzzedOther, { feedback: { kind: 'late', text: 'Too late' } }),
    closed: fx('closed', 'Bob was wrong — my team may answer, buzzers closed', closed),
    correct: fx('correct', 'I was judged correct (answer revealed)', correct),
    wrong: fx('wrong', 'I was judged wrong, nobody got it (answer revealed)', wrong),
    offline: fx('offline', 'Socket disconnected', open, { connected: false }),
    'join-4': fx('join-4', 'Join form of a four-team game', lobby4, { join: true }),
    'open-green': fx('open-green', 'Four teams, I am on green — buzzers open', open4, { player: meGreen }),
    'buzzed-orange': fx('buzzed-orange', 'Four teams: Dan (orange) buzzed first', buzzedOrange, { player: meGreen }),
    'closed-3': fx('closed-3', 'Three teams: Bob (blue) was wrong — pink or green may answer', closed3),
    'steal-3': fx('steal-3', 'Three teams, Connections: blue or green may steal from pink', steal3),
    'final-4': fx('final-4', 'Four teams, final scores: blue and green tie at the top', final4, { player: meGreen }),
  };
}
