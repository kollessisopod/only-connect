/**
 * Canned monitor states for /dev/monitor?fixture=<id>.
 *
 * Nothing here is hand-written state: every fixture starts from `createGame(buildDemoPack(...))` and replays real
 * actions through `applyAction`, then `projectPublic` strips it exactly like the API does. A fixture that the
 * engine would reject throws while building, so an invalid screenshot can never be produced.
 */
import {
  applyAction,
  buildDemoPack,
  createGame,
  projectPublic,
  WALL_SECONDS,
  type ActionContext,
  type GameAction,
  type GameState,
  type NoGameState,
  type PublicGameState,
  type PublicStateMessage,
  type TeamId,
} from '@only-connect/shared';

export const FIXTURE_IDS = [
  'none',
  'lobby',
  'selecting',
  'question-pink-2clues',
  'question-blue-audio',
  'question-sequences',
  'steal',
  'answer-connections',
  'answer-steal',
  'answer-audio',
  'answer-sequences',
  'wall-ready',
  'wall-live',
  'wall-frozen',
  'wall-resolving',
  'wall-done',
  'wall-between',
  'vowels-category',
  'vowels-clue',
  'vowels-buzzed-pink',
  'vowels-buzzed-blue',
  'vowels-other',
  'vowels-answer',
  'vowels-nobody',
  'final',
  'final-tie',
] as const;

export type FixtureId = (typeof FIXTURE_IDS)[number];

export interface MonitorFixture {
  id: FixtureId;
  label: string;
  state: PublicStateMessage;
  /** Server "now" to render the fixture with (drives the wall timer). */
  now: number;
}

export function isFixtureId(id: string): id is FixtureId {
  return (FIXTURE_IDS as readonly string[]).includes(id);
}

const T0 = Date.UTC(2026, 9, 13, 19, 30, 0);
const SEED = 20261013;
const TEAM_NAMES: Record<TeamId, { name: string }> = {
  pink: { name: 'Nightwearers' },
  blue: { name: 'Frenemies' },
};

const PLAYERS: Array<{ id: string; name: string; team: TeamId }> = [
  { id: 'p-mia', name: 'Mia', team: 'pink' },
  { id: 'p-millar', name: 'Millar', team: 'pink' },
  { id: 'p-jason', name: 'Jason', team: 'blue' },
  { id: 'p-nia', name: 'Nia', team: 'blue' },
];

/** Replays actions against the real engine with a deterministic clock and id factory. */
class Driver {
  state: GameState;
  now = T0;
  private counter = 0;

  constructor(options: { media?: boolean } = {}) {
    const pack = buildDemoPack(this.newId, { media: options.media ?? false, name: 'Demo pack' });
    this.state = createGame(pack, TEAM_NAMES, 'pink', this.ctx());
  }

  private newId = (): string => {
    this.counter += 1;
    return `fx-${this.counter}`;
  };

  private ctx(): ActionContext {
    return { now: this.now, seed: SEED, newId: this.newId };
  }

  /** Applies one action `dtMs` later than the previous one. */
  do(action: GameAction, dtMs = 1500): this {
    this.now += dtMs;
    this.state = applyAction(this.state, action, this.ctx());
    return this;
  }

  wait(ms: number): this {
    this.now += ms;
    return this;
  }

  /** Tile ids (display order) of a wall group — uses the full state, which the fixture builder may see. */
  tilesOf(group: number): number[] {
    const play = this.state.wall?.current;
    if (!play) throw new Error('no wall on screen');
    return play.tiles.filter((t) => t.group === group).map((t) => t.id);
  }

  public(): PublicGameState {
    return projectPublic(this.state, this.now);
  }
}

// ---------------------------------------------------------------------------
// Shared openings
// ---------------------------------------------------------------------------

function withScores(d: Driver, pink: number, blue: number): Driver {
  if (pink !== 0) d.do({ type: 'game:adjustScore', team: 'pink', delta: pink });
  if (blue !== 0) d.do({ type: 'game:adjustScore', team: 'blue', delta: blue });
  return d;
}

function joinPlayers(d: Driver, count = PLAYERS.length): Driver {
  for (const p of PLAYERS.slice(0, count)) d.do({ type: 'player:join', playerId: p.id, name: p.name, team: p.team }, 400);
  return d;
}

/** Scores 6–8, players joined: the usual starting point. */
function midGame(options: { media?: boolean } = {}): Driver {
  return withScores(joinPlayers(new Driver(options)), 6, 8);
}

/** Connections round, Nightwearers (pink) to pick. */
function connections(options: { media?: boolean } = {}): Driver {
  return midGame(options).do({ type: 'round:start', round: 'connections' });
}

/** Sequences round: the opener is the other team (Frenemies, blue). */
function sequences(): Driver {
  return midGame().do({ type: 'round:start', round: 'sequences' });
}

/** Pink's wall (wall 1 — they are behind) live with two groups found, one life lost and two tiles selected. */
function wallLive(): Driver {
  const d = midGame().do({ type: 'round:start', round: 'wall' }).do({ type: 'wall:show', team: 'pink' });
  d.do({ type: 'wall:start' });
  const startedAt = d.state.wall?.current?.startedAt ?? d.now;
  // Group 1 (pasta shapes) and group 2 (moons of Jupiter) found.
  for (const id of d.tilesOf(1)) d.do({ type: 'wall:select', tileId: id }, 900);
  for (const id of d.tilesOf(2)) d.do({ type: 'wall:select', tileId: id }, 900);
  // One wrong guess: three Shakespeare plays and a Tempest character.
  const [a, b, c] = d.tilesOf(0);
  const [x] = d.tilesOf(3);
  for (const id of [a, b, c, x]) d.do({ type: 'wall:select', tileId: id }, 900);
  // Two tiles selected, thinking about the third group.
  for (const id of d.tilesOf(0).slice(0, 2)) d.do({ type: 'wall:select', tileId: id }, 900);
  // 72 s elapsed (40 %).
  d.wait(Math.max(0, startedAt + 72_000 - d.now));
  return d;
}

function wallResolving(): Driver {
  const d = wallLive();
  d.wait(WALL_SECONDS * 1000);
  d.do({ type: 'wall:timeUp' }).do({ type: 'wall:resolve' }).do({ type: 'wall:connectionCorrect' }, 6000);
  return d;
}

function wallDone(): Driver {
  return wallResolving()
    .do({ type: 'wall:connectionIncorrect' }, 6000)
    .do({ type: 'wall:connectionCorrect' }, 6000)
    .do({ type: 'wall:connectionCorrect' }, 6000)
    .do({ type: 'wall:finish' });
}

function vowels(): Driver {
  return midGame().do({ type: 'round:start', round: 'vowels' });
}

/** Second clue of "Capital cities" on screen, buzzers open. */
function vowelsClue(): Driver {
  return vowels()
    .do({ type: 'vowels:showClue' })
    .do({ type: 'vowels:nobody' }, 8000)
    .do({ type: 'vowels:next' }, 3000);
}

function vowelsBuzzed(playerId: string): Driver {
  return vowelsClue().do({ type: 'player:buzz', playerId }, 2300);
}

const NONE: NoGameState = { id: null, phase: 'none', serverNow: T0 };

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function build(id: FixtureId): { label: string; driver: Driver | null } {
  switch (id) {
    case 'none':
      return { label: 'No game yet — waiting for the game master', driver: null };

    case 'lobby': {
      const d = joinPlayers(new Driver());
      d.do({ type: 'player:connected', playerId: 'p-nia', connected: false });
      return { label: 'Lobby — title, team names, 3 of 4 players connected', driver: d };
    }

    case 'selecting': {
      const d = connections()
        .do({ type: 'q:select', hieroglyph: 'lion' })
        .do({ type: 'q:reveal' })
        .do({ type: 'q:correct' })
        .do({ type: 'q:next' })
        .do({ type: 'q:select', hieroglyph: 'water' })
        .do({ type: 'q:incorrect' })
        .do({ type: 'q:stealCorrect' })
        .do({ type: 'q:next' });
      return { label: 'Connections — Nightwearers to choose (Lion and Water used)', driver: d };
    }

    case 'question-pink-2clues': {
      const d = connections().do({ type: 'q:select', hieroglyph: 'twoReeds' }).do({ type: 'q:reveal' }, 5000);
      return { label: 'Connections — pink team, 2 clues revealed, 3 points (purple background)', driver: d };
    }

    case 'question-blue-audio': {
      const d = connections({ media: true })
        .do({ type: 'q:select', hieroglyph: 'lion' })
        .do({ type: 'q:correct' })
        .do({ type: 'q:next' })
        .do({ type: 'q:select', hieroglyph: 'hornedViper' })
        .do({ type: 'q:reveal' }, 9000);
      return { label: 'Connections — blue team, 2 audio clues (gramophones), 3 points', driver: d };
    }

    case 'question-sequences': {
      const d = sequences()
        .do({ type: 'q:select', hieroglyph: 'hornedViper' })
        .do({ type: 'q:reveal' }, 5000)
        .do({ type: 'q:reveal' }, 5000);
      return { label: 'Sequences — blue team, 3 clues and the ? tile, 2 points', driver: d };
    }

    case 'steal': {
      const d = connections()
        .do({ type: 'q:select', hieroglyph: 'water' })
        .do({ type: 'q:reveal' }, 5000)
        .do({ type: 'q:reveal' }, 5000)
        .do({ type: 'q:incorrect' }, 7000);
      return { label: 'Connections — steal: all four clues, 1 point, Frenemies to steal', driver: d };
    }

    case 'answer-connections': {
      const d = connections()
        .do({ type: 'q:select', hieroglyph: 'twoReeds' })
        .do({ type: 'q:reveal' }, 5000)
        .do({ type: 'q:reveal' }, 5000)
        .do({ type: 'q:correct' }, 7000);
      return { label: 'Connections — answer revealed after 3 clues (2 points to Nightwearers)', driver: d };
    }

    case 'answer-steal': {
      const d = connections()
        .do({ type: 'q:select', hieroglyph: 'eyeOfHorus' })
        .do({ type: 'q:reveal' }, 5000)
        .do({ type: 'q:incorrect' }, 7000)
        .do({ type: 'q:stealCorrect' }, 7000);
      return { label: 'Connections — answer revealed after a successful steal (1 point to Frenemies)', driver: d };
    }

    case 'answer-audio': {
      // The audio question's captions are the longest strings in the demo pack: a tile text-wrapping check.
      const d = connections({ media: true })
        .do({ type: 'q:select', hieroglyph: 'hornedViper' })
        .do({ type: 'q:reveal' }, 5000)
        .do({ type: 'q:reveal' }, 5000)
        .do({ type: 'q:reveal' }, 5000)
        .do({ type: 'q:correct' }, 7000);
      return { label: 'Connections — answer revealed for the audio question (long captions in the tiles)', driver: d };
    }

    case 'answer-sequences': {
      const d = sequences()
        .do({ type: 'q:select', hieroglyph: 'twoReeds' })
        .do({ type: 'q:reveal' }, 5000)
        .do({ type: 'q:reveal' }, 5000)
        .do({ type: 'q:correct' }, 7000);
      return { label: 'Sequences — answer revealed, 4th tile shows the real item', driver: d };
    }

    case 'wall-ready': {
      const d = midGame().do({ type: 'round:start', round: 'wall' }).do({ type: 'wall:show', team: 'pink' });
      return { label: 'Wall — on screen, not started', driver: d };
    }

    case 'wall-live':
      return { label: 'Wall — live: 2 groups found, 2 lives left, 2 tiles selected, 40 % elapsed', driver: wallLive() };

    case 'wall-frozen': {
      const d = wallLive();
      d.wait(WALL_SECONDS * 1000);
      d.do({ type: 'wall:timeUp' });
      return { label: "Wall — frozen: time's up with 2 groups found", driver: d };
    }

    case 'wall-resolving':
      return { label: 'Wall — resolving: first connection revealed (correct), asking the second', driver: wallResolving() };

    case 'wall-done':
      return { label: 'Wall — done: Groups 2 · Connections 3 · Bonus 0 = 5', driver: wallDone() };

    case 'wall-between': {
      const d = wallDone().do({ type: 'wall:clear' });
      return { label: 'Wall — between walls (Nightwearers done, Frenemies next)', driver: d };
    }

    case 'vowels-category':
      return { label: 'Missing Vowels — category bar only', driver: vowels() };

    case 'vowels-clue':
      return { label: 'Missing Vowels — clue on screen, buzzers open', driver: vowelsClue() };

    case 'vowels-buzzed-pink':
      return { label: 'Missing Vowels — Mia (Nightwearers) buzzed', driver: vowelsBuzzed('p-mia') };

    case 'vowels-buzzed-blue':
      return { label: 'Missing Vowels — Jason (Frenemies) buzzed', driver: vowelsBuzzed('p-jason') };

    case 'vowels-other': {
      const d = vowelsBuzzed('p-mia').do({ type: 'vowels:incorrect' }, 4000);
      return { label: 'Missing Vowels — wrong buzz (−1), Frenemies to answer', driver: d };
    }

    case 'vowels-answer': {
      const d = vowelsBuzzed('p-mia').do({ type: 'vowels:correct' }, 4000);
      return { label: 'Missing Vowels — answer revealed, Mia correct (+1)', driver: d };
    }

    case 'vowels-nobody': {
      const d = vowelsClue().do({ type: 'vowels:nobody' }, 9000);
      return { label: 'Missing Vowels — nobody buzzed, answer revealed', driver: d };
    }

    case 'final': {
      const d = withScores(vowels(), 8, 11).do({ type: 'round:final' });
      return { label: 'Final — Frenemies win 19–14', driver: d };
    }

    case 'final-tie': {
      const d = withScores(vowels(), 10, 8).do({ type: 'round:final' });
      return { label: 'Final — a 16–16 draw', driver: d };
    }

    default: {
      const never: never = id;
      throw new Error(`unknown fixture ${String(never)}`);
    }
  }
}

export function buildFixture(id: FixtureId): MonitorFixture {
  const { label, driver } = build(id);
  if (!driver) return { id, label, state: NONE, now: T0 };
  return { id, label, state: driver.public(), now: driver.now };
}

export function buildAllFixtures(): MonitorFixture[] {
  return FIXTURE_IDS.map(buildFixture);
}
