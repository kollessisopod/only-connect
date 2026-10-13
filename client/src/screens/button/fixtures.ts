/**
 * Canned buzzer states for /dev/button, produced by the real engine over the demo pack.
 */
import {
  applyAction,
  buildDemoPack,
  createGame,
  projectPublic,
  type ActionContext,
  type GameAction,
  type GameState,
  type PublicStateMessage,
  type TeamId,
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
] as const;

export const ME: ButtonPlayer = { playerId: 'p-mia', name: 'Mia', team: 'pink' };

const TEAM_NAMES: Record<TeamId, { name: string }> = {
  pink: { name: 'Nightwearers' },
  blue: { name: 'Frenemies' },
};

function makeCtx(now: number): ActionContext {
  let n = 0;
  return { now, seed: 7, newId: () => `fx-${++n}` };
}

function run(state: GameState, actions: GameAction[], ctx: ActionContext): GameState {
  return actions.reduce((s, a) => applyAction(s, a, ctx), state);
}

export function buildButtonFixtures(base: number): Record<string, ButtonFixture> {
  let n = 0;
  const pack = buildDemoPack(() => `pack-${++n}`, { media: false });
  const ctx = makeCtx(base);
  const lobby = run(
    createGame(pack, TEAM_NAMES, 'pink', ctx),
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
  };
}
