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
  HIEROGLYPHS,
  WALL_HIEROGLYPH_ORDER,
  WALL_SECONDS,
  type ActionContext,
  type GameAction,
  type GameState,
  type Hieroglyph,
  type NoGameState,
  type Pack,
  type PublicGameState,
  type PublicStateMessage,
  type Question,
  type TeamId,
  type Wall,
} from '@only-connect/shared';

export const FIXTURE_IDS = [
  'none',
  'lobby',
  'selecting',
  'selecting-12',
  'question-pink-2clues',
  'question-blue-audio',
  'question-sequences',
  'question-clock-low',
  'question-time-up',
  'question-picture',
  'question-sequences-picture',
  'steal',
  'steal-picture',
  'answer-connections',
  'answer-steal',
  'answer-audio',
  'answer-sequences',
  'wall-selecting-2',
  'wall-selecting-4-one-used',
  'wall-ready',
  'wall-live',
  'wall-frozen',
  'wall-resolving',
  'wall-done',
  'wall-between',
  'wall-4-playing',
  'wall-all-played',
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
  /** Server "now" to render the fixture with (drives the wall timer and the 40 s question clock). */
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

export interface PackShape {
  /** Questions per round (1..12); the demo pack has 6. */
  questions?: number;
  /** Walls in the pack (2 or 4); the demo pack has 2. */
  walls?: number;
}

/**
 * A bigger demo pack for the boards the demo pack cannot show (a 4×3 hieroglyph grid, a four-wall round):
 * extra questions are text copies of the demo ones tagged with the next hieroglyphs (grid order), extra walls
 * are copies of the demo walls tagged in `WALL_HIEROGLYPH_ORDER` (lion, water, two reeds, twisted flax, ...).
 * Still validated by the engine like any pack, so a wrong shape throws at fixture build time.
 */
export function extendPack(base: Pack, shape: PackShape): Pack {
  const questions: Question[] = [];
  for (const round of ['connections', 'sequences'] as const) {
    const demo = base.questions.filter((q) => q.round === round).sort((a, b) => a.position - b.position);
    const count = shape.questions ?? demo.length;
    for (let i = 0; i < count; i++) {
      const src = demo[i % demo.length];
      const copy = i >= demo.length;
      questions.push({
        ...src,
        id: copy ? `${src.id}-${i + 1}` : src.id,
        hieroglyph: HIEROGLYPHS[i],
        position: i,
        clues: src.clues.map((c) => ({ kind: c.kind, text: copy ? `${c.text} #${i + 1}` : c.text })),
        answer: copy ? `${src.answer} #${i + 1}` : src.answer,
      });
    }
  }
  const wallCount = shape.walls ?? base.walls.length;
  const demoWalls = [...base.walls].sort((a, b) => a.position - b.position);
  const walls: Wall[] = [];
  for (let i = 0; i < wallCount; i++) {
    const src = demoWalls[i % demoWalls.length];
    walls.push({
      id: i < demoWalls.length ? src.id : `${src.id}-${i + 1}`,
      position: i,
      hieroglyph: WALL_HIEROGLYPH_ORDER[i],
      groups: src.groups.map((g) => ({ connection: g.connection, clues: [...g.clues] })),
    });
  }
  return { ...base, questions, walls };
}

/** Replays actions against the real engine with a deterministic clock and id factory. */
class Driver {
  state: GameState;
  now = T0;
  private counter = 0;

  constructor(options: { media?: boolean; shape?: PackShape } = {}) {
    let pack = buildDemoPack(this.newId, { media: options.media ?? false, name: 'Demo pack' });
    if (options.shape) pack = extendPack(pack, options.shape);
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

  /** The team the engine says is choosing (or playing) the current wall. */
  wallTeam(): TeamId {
    const team = this.state.wall?.team;
    if (!team) throw new Error('no wall round');
    return team;
  }

  /** `wall:select` of a glyph, checking that `team` really is the one choosing (so a label can name it). */
  chooseWall(team: TeamId, hieroglyph: Hieroglyph): this {
    const chooser = this.wallTeam();
    if (chooser !== team) throw new Error(`fixture: ${chooser} chooses the wall, not ${team}`);
    return this.do({ type: 'wall:select', hieroglyph });
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

/** Scores 6–8, players joined: the usual starting point. Nightwearers (pink) are behind. */
function midGame(options: { media?: boolean; shape?: PackShape } = {}): Driver {
  return withScores(joinPlayers(new Driver(options)), 6, 8);
}

/** Connections round, Nightwearers (pink) to pick. */
function connections(options: { media?: boolean } = {}): Driver {
  return midGame(options).do({ type: 'round:start', round: 'connections' });
}

/** Sequences round: the opener is the other team (Frenemies, blue). */
function sequences(options: { media?: boolean } = {}): Driver {
  return midGame(options).do({ type: 'round:start', round: 'sequences' });
}

/** `dt` ms after `q:select` (the clock start) — for the question-clock fixtures. */
function sinceSelect(d: Driver, dt: number): Driver {
  const startedAt = d.state.question?.startedAt ?? d.now;
  return d.wait(Math.max(0, startedAt + dt - d.now));
}

/** Wall round started: Nightwearers (pink, behind 6–8) choose first. */
function wallRound(shape?: PackShape): Driver {
  return midGame({ shape }).do({ type: 'round:start', round: 'wall' });
}

/**
 * Plays the Lion wall (the one on screen must be it: group 1 = pasta shapes, 2 = moons of Jupiter) to the point
 * where two groups are found, one life is lost and two tiles are selected, 60 s (40 % of 2:30) in.
 */
function playLionWall(d: Driver): Driver {
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
  // 60 s elapsed (40 % of WALL_SECONDS = 150).
  d.wait(Math.max(0, startedAt + 60_000 - d.now));
  return d;
}

/** Pink chose the Lion wall (wall 1 of 2) and it is live: two groups found, one life lost, two tiles selected. */
function wallLive(): Driver {
  return playLionWall(wallRound().chooseWall('pink', 'lion'));
}

/** Time up, resolved, first connection judged (correct); asking the second. */
function resolveWall(d: Driver): Driver {
  d.wait(WALL_SECONDS * 1000);
  return d.do({ type: 'wall:timeUp' }).do({ type: 'wall:resolve' }).do({ type: 'wall:connectionCorrect' }, 6000);
}

/** Judges the remaining three connections (wrong, right, right) and banks the points. */
function finishWall(d: Driver): Driver {
  return d
    .do({ type: 'wall:connectionIncorrect' }, 6000)
    .do({ type: 'wall:connectionCorrect' }, 6000)
    .do({ type: 'wall:connectionCorrect' }, 6000)
    .do({ type: 'wall:finish' });
}

function wallResolving(): Driver {
  return resolveWall(wallLive());
}

function wallDone(): Driver {
  return finishWall(wallResolving());
}

/** Four-wall pack: pink played the Lion wall (5 points) and cleared it; Frenemies (blue) choose wall 2 of 4. */
function fourWallsOneDone(): Driver {
  return finishWall(resolveWall(playLionWall(wallRound({ walls: 4 }).chooseWall('pink', 'lion')))).do({ type: 'wall:clear' });
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

    case 'selecting-12': {
      // A 12-question round: every glyph on the board, five already played (the teams alternate picks).
      const d = midGame({ shape: { questions: 12 } }).do({ type: 'round:start', round: 'connections' });
      for (const glyph of ['lion', 'sun', 'water', 'ankh', 'cobra'] as const) {
        d.do({ type: 'q:select', hieroglyph: glyph }).do({ type: 'q:reveal' }).do({ type: 'q:correct' }).do({ type: 'q:next' });
      }
      return { label: 'Connections — 12 questions: 4×3 board, five used, Frenemies to choose (question 6 of 12)', driver: d };
    }

    case 'question-pink-2clues': {
      const d = connections().do({ type: 'q:select', hieroglyph: 'twoReeds' }).do({ type: 'q:reveal' }, 5000);
      return { label: 'Connections — pink team, 2 clues revealed, 3 points, clock at 0:35 (purple background)', driver: d };
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

    case 'question-clock-low': {
      const d = connections()
        .do({ type: 'q:select', hieroglyph: 'twoReeds' })
        .do({ type: 'q:reveal' }, 5000)
        .do({ type: 'q:reveal' }, 5000);
      sinceSelect(d, 33_000);
      return { label: 'Connections — 3 clues, 2 points, clock nearly out (0:07)', driver: d };
    }

    case 'question-time-up': {
      const d = connections()
        .do({ type: 'q:select', hieroglyph: 'twoReeds' })
        .do({ type: 'q:reveal' }, 5000)
        .do({ type: 'q:reveal' }, 5000);
      sinceSelect(d, 40_000).do({ type: 'q:timeUp' }, 0);
      return { label: "Connections — time's up after 3 clues: empty bar, team must answer for 2 points", driver: d };
    }

    case 'question-picture': {
      const d = connections({ media: true }).do({ type: 'q:select', hieroglyph: 'twistedFlax' }).do({ type: 'q:reveal' }, 5000);
      return { label: 'Connections — 2 picture clues (flags), the latest one shown big above the row', driver: d };
    }

    case 'question-sequences-picture': {
      const d = sequences({ media: true })
        .do({ type: 'q:select', hieroglyph: 'twistedFlax' })
        .do({ type: 'q:reveal' }, 5000)
        .do({ type: 'q:reveal' }, 5000);
      return { label: 'Sequences — 3 picture clues (moon phases) and the ? tile, the third one shown big', driver: d };
    }

    case 'steal': {
      const d = connections()
        .do({ type: 'q:select', hieroglyph: 'water' })
        .do({ type: 'q:reveal' }, 5000)
        .do({ type: 'q:reveal' }, 5000)
        .do({ type: 'q:incorrect' }, 7000);
      return { label: 'Connections — steal: all four clues, 1 point, Frenemies to steal', driver: d };
    }

    case 'steal-picture': {
      const d = connections({ media: true })
        .do({ type: 'q:select', hieroglyph: 'twistedFlax' })
        .do({ type: 'q:reveal' }, 5000)
        .do({ type: 'q:reveal' }, 5000)
        .do({ type: 'q:incorrect' }, 7000);
      return { label: 'Connections — steal on the flags question: all four shown, the fourth big, no clock', driver: d };
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

    case 'wall-selecting-2': {
      const d = wallRound();
      return { label: 'Wall — choosing: two walls (Lion, Water), Nightwearers (behind 6–8) to choose wall 1 of 2', driver: d };
    }

    case 'wall-selecting-4-one-used': {
      const d = fourWallsOneDone();
      return { label: 'Wall — choosing: four walls, Lion played (dark), Frenemies to choose wall 2 of 4', driver: d };
    }

    case 'wall-ready': {
      const d = wallRound().chooseWall('pink', 'lion');
      return { label: 'Wall — Lion wall chosen by Nightwearers, not started: tiles hidden, "get ready" (wall 1 of 2)', driver: d };
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
      return { label: 'Wall — between walls: Lion played (dark), Frenemies to choose the Water wall (wall 2 of 2)', driver: d };
    }

    case 'wall-4-playing': {
      // Frenemies chose the Water wall (chess pieces, crows, poker hands, ___fish): live, one group found.
      const d = fourWallsOneDone().chooseWall('blue', 'water').do({ type: 'wall:start' });
      const startedAt = d.state.wall?.current?.startedAt ?? d.now;
      for (const id of d.tilesOf(0)) d.do({ type: 'wall:select', tileId: id }, 900);
      d.wait(Math.max(0, startedAt + 45_000 - d.now));
      return { label: 'Wall — four-wall pack, wall 2 of 4 live for Frenemies: 1 group found, 45 s elapsed', driver: d };
    }

    case 'wall-all-played': {
      // Both walls played and cleared: the board stays up, all dark, and the round is over.
      const d = wallDone().do({ type: 'wall:clear' }).chooseWall('blue', 'water');
      d.do({ type: 'wall:start' });
      for (const g of [0, 1, 2]) for (const id of d.tilesOf(g)) d.do({ type: 'wall:select', tileId: id }, 900);
      finishWall(d.do({ type: 'wall:resolve' }).do({ type: 'wall:connectionCorrect' }, 6000)).do({ type: 'wall:clear' });
      return { label: 'Wall — every wall played (board all dark, round over)', driver: d };
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
