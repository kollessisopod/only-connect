/**
 * V3.2: 2 to 4 teams and host-chosen round orders. Turns cycle through the order, steals and "other team"
 * answers name a team once more than two play, the wall round plays the same number of walls per team, the
 * default order is the ascending-score rule, legacy (V3) states are normalised, and the public projection
 * always carries `order` / `activeTeams`.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_TEAM_IDS, GameError, HIEROGLYPHS, TEAM_IDS, type GameState, type TeamId } from '../../types.js';
import { allowedActions, applyAction, createGame, describeState, winningTeam } from '../game.js';
import { projectPublic } from '../project.js';
import { activeTeams, normalizeGameState, previousRoundOrder, suggestedRoundOrder, teamStandings, validateRoundOrder } from '../teams.js';
import { wallsTotalFor } from '../wall.js';
import { customPack, demoPack, expectError, makeCtx, newGame, newGameWith, run, selectGroup, teamList, withPlayers, NOW } from './fixtures.js';

const ctx = makeCtx();
const THREE: TeamId[] = ['pink', 'blue', 'green'];
const FOUR: TeamId[] = ['pink', 'blue', 'green', 'orange'];

function q(state: GameState) {
  if (!state.question) throw new Error('no question round');
  return state.question;
}

function code(fn: () => unknown): string | null {
  try {
    fn();
  } catch (e) {
    return e instanceof GameError ? e.code : 'not-a-GameError';
  }
  return null;
}

/** Plays a perfect wall for the current chooser: first glyph left, three groups, every connection right. */
function perfectWall(state: GameState): GameState {
  const round = state.wall;
  if (!round) throw new Error('no wall round');
  const glyph = round.available.find((h) => !round.used.includes(h));
  if (!glyph) throw new Error('no wall left');
  let s = run(state, [{ type: 'wall:select', hieroglyph: glyph }, { type: 'wall:start' }]);
  s = selectGroup(s, 0);
  s = selectGroup(s, 1);
  s = selectGroup(s, 2);
  return run(s, [{ type: 'wall:resolve' }, { type: 'wall:connectionCorrect' }, { type: 'wall:connectionCorrect' }, { type: 'wall:connectionCorrect' }, { type: 'wall:connectionCorrect' }, { type: 'wall:finish' }, { type: 'wall:clear' }]);
}

describe('createGame with 2 to 4 teams', () => {
  it('records the playing teams in creation order and gives every team a record', () => {
    const s = newGameWith(['green', 'pink', 'orange']);
    expect(s.activeTeams).toEqual(['green', 'pink', 'orange']);
    expect(activeTeams(s)).toEqual(['green', 'pink', 'orange']);
    expect(Object.keys(s.teams).sort()).toEqual([...TEAM_IDS].sort());
    expect(s.teams.green.name).toBe('Green Geckos');
    expect(s.teams.blue).toEqual({ id: 'blue', name: 'Blue team', score: 0 }); // idle: default name
    expect(s.firstTeam).toBeUndefined();
    expect(newGameWith(FOUR).activeTeams).toEqual(FOUR);
    expect(activeTeams(newGame())).toEqual([...DEFAULT_TEAM_IDS]);
  });

  it('needs at least one wall per team (not_enough_walls), while the pack itself stays playable', () => {
    const two = demoPack();
    expect(code(() => createGame(two, teamList(THREE), ctx))).toBe('not_enough_walls');
    expect(code(() => createGame(two, teamList(FOUR), ctx))).toBe('not_enough_walls');
    expect(code(() => createGame(two, teamList(['green', 'orange']), ctx))).toBeNull();
    const four = customPack({ walls: 4 });
    expect(code(() => createGame(four, teamList(THREE), ctx))).toBeNull();
    expect(code(() => createGame(four, teamList(FOUR), ctx))).toBeNull();
  });

  it('only playing teams can be joined, renamed or scored', () => {
    let s = newGameWith(THREE);
    expectError(s, { type: 'player:join', playerId: 'p-o', name: 'Olga', team: 'orange' }, 'team_inactive');
    expectError(s, { type: 'game:setTeamName', team: 'orange', name: 'Oranges' }, 'team_inactive');
    expectError(s, { type: 'game:adjustScore', team: 'orange', delta: 5 }, 'team_inactive');
    s = run(s, [
      { type: 'player:join', playerId: 'p-g', name: 'Greta', team: 'green' },
      { type: 'game:setTeamName', team: 'green', name: 'Greens' },
      { type: 'game:adjustScore', team: 'green', delta: 2 },
    ]);
    expect(s.players[0].team).toBe('green');
    expect(s.teams.green).toMatchObject({ name: 'Greens', score: 2 });
    expect(s.teams.orange.score).toBe(0);
    expect(allowedActions(s)).toEqual(expect.arrayContaining(['game:setTeamName', 'game:adjustScore', 'round:start']));
  });
});

describe('round orders', () => {
  it('suggestedRoundOrder: ascending score, ties keep the previous round order, else creation order', () => {
    let s = newGameWith(['orange', 'pink', 'green']);
    expect(previousRoundOrder(s)).toBeNull();
    expect(suggestedRoundOrder(s)).toEqual(['orange', 'pink', 'green']); // level scores, no previous round
    s = run(s, [{ type: 'game:adjustScore', team: 'orange', delta: 3 }, { type: 'game:adjustScore', team: 'green', delta: 1 }]);
    expect(suggestedRoundOrder(s)).toEqual(['pink', 'green', 'orange']);
    // The host starts Connections with an explicit order; afterwards a tie keeps that order.
    s = applyAction(s, { type: 'round:start', round: 'connections', order: ['green', 'orange', 'pink'] }, ctx);
    expect(q(s)).toMatchObject({ order: ['green', 'orange', 'pink'], team: 'green' });
    expect(previousRoundOrder(s)).toEqual(['green', 'orange', 'pink']);
    s = run(s, [{ type: 'game:adjustScore', team: 'pink', delta: 3 }, { type: 'game:adjustScore', team: 'green', delta: 2 }]); // all on 3
    expect(suggestedRoundOrder(s)).toEqual(['green', 'orange', 'pink']);
    s = applyAction(s, { type: 'game:adjustScore', team: 'orange', delta: -1 }, ctx);
    expect(suggestedRoundOrder(s)).toEqual(['orange', 'green', 'pink']); // orange behind, the tie keeps green before pink
    // Starting Sequences without an order uses exactly that.
    const seq = applyAction(s, { type: 'round:start', round: 'sequences' }, ctx);
    expect(q(seq)).toMatchObject({ round: 'sequences', order: ['orange', 'green', 'pink'], team: 'orange' });
    // A round left in the lobby still counts as "previous" while it is suspended.
    const played = run(s, [{ type: 'q:select', hieroglyph: 'twoReeds' }, { type: 'q:correct' }, { type: 'q:next' }, { type: 'game:lobby' }]);
    expect(previousRoundOrder(played)).toEqual(['green', 'orange', 'pink']);
  });

  it('round:start validates a given order and ignores it when resuming', () => {
    const s = newGameWith(THREE);
    for (const bad of [['pink', 'blue'], ['pink', 'blue', 'orange'], ['pink', 'pink', 'blue'], ['pink', 'blue', 'green', 'orange'], [], 'pink']) {
      expect(code(() => applyAction(s, { type: 'round:start', round: 'connections', order: bad as TeamId[] }, ctx)), JSON.stringify(bad)).toBe('invalid_order');
      expect(code(() => validateRoundOrder(s, bad))).toBe('invalid_order');
    }
    expect(validateRoundOrder(s, ['green', 'pink', 'blue'])).toEqual(['green', 'pink', 'blue']);
    let t = applyAction(s, { type: 'round:start', round: 'wall', order: ['green', 'pink', 'blue'] }, ctx);
    expect(t.wall).toMatchObject({ order: ['green', 'pink', 'blue'], team: 'green' });
    t = perfectWall(t);
    expect(t.wall).toMatchObject({ team: 'pink', wallsDone: 1 });
    // Away to the lobby and back with another order: the suspended round keeps its own.
    t = run(t, [{ type: 'game:lobby' }, { type: 'round:start', round: 'wall', order: ['blue', 'green', 'pink'] }]);
    expect(t.wall).toMatchObject({ order: ['green', 'pink', 'blue'], team: 'pink', wallsDone: 1 });
    // A two-team game accepts only its two teams.
    expect(code(() => applyAction(newGame(), { type: 'round:start', round: 'connections', order: ['pink', 'green'] }, ctx))).toBe('invalid_order');
    expect(applyAction(newGame(), { type: 'round:start', round: 'connections', order: ['blue', 'pink'] }, ctx).question?.team).toBe('blue');
  });
});

describe('Connections / Sequences with 3 and 4 teams', () => {
  it('turns cycle through the order; an odd count gives the first teams one more question', () => {
    let s = applyAction(newGameWith(FOUR), { type: 'round:start', round: 'connections', order: ['blue', 'orange', 'pink', 'green'] }, ctx);
    const turns: TeamId[] = [];
    const glyphs = ['twoReeds', 'lion', 'twistedFlax', 'hornedViper', 'water', 'eyeOfHorus'] as const;
    for (const g of glyphs) {
      turns.push(q(s).team);
      expect(describeState(s)).toBe(`Connections — ${s.teams[q(s).team].name} to pick (${q(s).questionsDone}/6 done)`);
      s = run(s, [{ type: 'q:select', hieroglyph: g }, { type: 'q:correct' }, { type: 'q:next' }]);
    }
    expect(turns).toEqual(['blue', 'orange', 'pink', 'green', 'blue', 'orange']);
    expect(s.teams).toMatchObject({ blue: { score: 10 }, orange: { score: 10 }, pink: { score: 5 }, green: { score: 5 } });
    expect(s.finishedRounds).toEqual(['connections']);
    // Sequences by default: the two teams behind first, ties in the previous order.
    s = applyAction(s, { type: 'round:start', round: 'sequences' }, ctx);
    expect(q(s)).toMatchObject({ order: ['pink', 'green', 'blue', 'orange'], team: 'pink' });
    // Three teams, voids included: the turn still moves to the next team in the order.
    let t = applyAction(newGameWith(THREE), { type: 'round:start', round: 'connections', order: ['green', 'blue', 'pink'] }, ctx);
    const seen: TeamId[] = [];
    for (const g of glyphs) {
      seen.push(q(t).team);
      t = run(t, [{ type: 'q:select', hieroglyph: g }, { type: 'q:void' }]);
    }
    expect(seen).toEqual(['green', 'blue', 'pink', 'green', 'blue', 'pink']);
  });

  it('a steal must name the stealing team once more than two teams play', () => {
    let s = run(newGameWith(THREE), [{ type: 'round:start', round: 'connections', order: ['pink', 'blue', 'green'] }, { type: 'q:select', hieroglyph: 'lion' }, { type: 'q:incorrect' }]);
    expect(q(s).stage).toBe('steal');
    expect(allowedActions(s)).toEqual(expect.arrayContaining(['q:stealCorrect', 'q:stealIncorrect', 'q:void']));
    expect(describeState(s)).toBe('Connections — Q1 (lion): Blue Whales or Green Geckos may steal (name the team) for 1 point');
    expectError(s, { type: 'q:stealCorrect' }, 'team_required');
    expectError(s, { type: 'q:stealCorrect', team: 'pink' }, 'invalid_team'); // the answering team
    expectError(s, { type: 'q:stealCorrect', team: 'orange' }, 'invalid_team'); // not playing
    expectError(s, { type: 'q:stealCorrect', team: 'sphinx' as TeamId }, 'invalid_team');
    const green = applyAction(s, { type: 'q:stealCorrect', team: 'green' }, ctx);
    expect(q(green)).toMatchObject({ stage: 'answer', result: { winner: 'green', points: 1, viaSteal: true } });
    expect(green.teams).toMatchObject({ pink: { score: 0 }, blue: { score: 0 }, green: { score: 1 }, orange: { score: 0 } });
    expect(describeState(green)).toBe('Connections — Q1 (lion) answer shown: Green Geckos +1 (steal); next up Blue Whales');
    const blue = applyAction(s, { type: 'q:stealCorrect', team: 'blue' }, ctx);
    expect(blue.teams.blue.score).toBe(1);
    // Nobody stole.
    s = applyAction(s, { type: 'q:stealIncorrect' }, ctx);
    expect(q(s).result).toEqual({ winner: null, points: 0, viaSteal: true });
    // With two teams the stealer is implied, and naming it is still accepted (but it must be the other one).
    const two = run(newGame('pink'), [{ type: 'round:start', round: 'connections' }, { type: 'q:select', hieroglyph: 'lion' }, { type: 'q:incorrect' }]);
    expect(applyAction(two, { type: 'q:stealCorrect' }, ctx).teams.blue.score).toBe(1);
    expect(applyAction(two, { type: 'q:stealCorrect', team: 'blue' }, ctx).teams.blue.score).toBe(1);
    expectError(two, { type: 'q:stealCorrect', team: 'pink' }, 'invalid_team');
    expectError(two, { type: 'q:stealCorrect', team: 'green' }, 'invalid_team');
  });
});

describe('Connecting Wall with 3 and 4 teams', () => {
  it('plays floor(walls / teams) * teams walls, chosen in the order, and ends when they are done', () => {
    expect(wallsTotalFor(4, 4)).toBe(4);
    expect(wallsTotalFor(4, 3)).toBe(3);
    expect(wallsTotalFor(4, 2)).toBe(4);
    expect(wallsTotalFor(2, 2)).toBe(2);
    expect(wallsTotalFor(2, 3)).toBe(0); // refused by game:new (not_enough_walls)

    let s = applyAction(newGameWith(THREE), { type: 'round:start', round: 'wall', order: ['green', 'pink', 'blue'] }, ctx);
    expect(s.wall).toMatchObject({ order: ['green', 'pink', 'blue'], team: 'green', wallsTotal: 3, wallsDone: 0, available: ['twoReeds', 'lion', 'twistedFlax', 'water'] });
    expect(describeState(s)).toBe('Connecting Wall — wall 1 of 3: Green Geckos to choose');
    const choosers: TeamId[] = [];
    for (let i = 0; i < 3; i++) {
      choosers.push(s.wall?.team as TeamId);
      s = perfectWall(s);
    }
    expect(choosers).toEqual(['green', 'pink', 'blue']);
    expect(s.teams).toMatchObject({ green: { score: 10 }, pink: { score: 10 }, blue: { score: 10 }, orange: { score: 0 } });
    expect(s.finishedRounds).toEqual(['wall']);
    expect(s.wall).toMatchObject({ wallsDone: 3, wallsTotal: 3, current: null });
    expect(s.wall?.used).toHaveLength(3);
    // The fourth glyph is still on the grid but nothing can be chosen any more.
    expect(allowedActions(s).filter((a) => a.startsWith('wall:'))).toEqual([]);
    const left = s.wall?.available.find((h) => !s.wall?.used.includes(h)) as (typeof HIEROGLYPHS)[number];
    expectError(s, { type: 'wall:select', hieroglyph: left });
    expect(describeState(s)).toBe('Connecting Wall — all walls played; start the next round');

    let f = applyAction(newGameWith(FOUR), { type: 'round:start', round: 'wall', order: ['orange', 'green', 'blue', 'pink'] }, ctx);
    expect(f.wall).toMatchObject({ wallsTotal: 4, team: 'orange' });
    const four: TeamId[] = [];
    for (let i = 0; i < 4; i++) {
      four.push(f.wall?.team as TeamId);
      f = perfectWall(f);
    }
    expect(four).toEqual(['orange', 'green', 'blue', 'pink']);
    expect(f.finishedRounds).toEqual(['wall']);
    expect(f.wall).toMatchObject({ wallsDone: 4, wallsTotal: 4 });
  });

  it('a two-team game on a 4-wall pack still alternates A, B, A, B over all four walls', () => {
    let s = applyAction(newGameWith(['blue', 'pink']), { type: 'round:start', round: 'wall' }, ctx);
    expect(s.wall).toMatchObject({ order: ['blue', 'pink'], wallsTotal: 4 });
    const choosers: TeamId[] = [];
    for (let i = 0; i < 4; i++) {
      choosers.push(s.wall?.team as TeamId);
      s = perfectWall(s);
    }
    expect(choosers).toEqual(['blue', 'pink', 'blue', 'pink']);
    expect(s.finishedRounds).toEqual(['wall']);
  });

  it('abort keeps the chooser in a 3-team round', () => {
    let s = applyAction(newGameWith(THREE), { type: 'round:start', round: 'wall', order: ['pink', 'green', 'blue'] }, ctx);
    s = perfectWall(s);
    expect(s.wall?.team).toBe('green');
    s = run(s, [{ type: 'wall:select', hieroglyph: s.wall?.available.find((h) => !s.wall?.used.includes(h)) as 'lion' }, { type: 'wall:start' }, { type: 'wall:abort' }]);
    expect(s.wall).toMatchObject({ team: 'green', wallsDone: 1, stage: 'selecting' });
  });
});

describe('Missing Vowels with 3 teams', () => {
  it('after a wrong buzz the host names the team that answered', () => {
    let s = run(newGameWith(THREE), [
      { type: 'player:join', playerId: 'p-ann', name: 'Ann', team: 'pink' },
      { type: 'player:join', playerId: 'p-gus', name: 'Gus', team: 'green' },
      { type: 'round:start', round: 'vowels', order: ['green', 'pink', 'blue'] },
    ]);
    expect(s.vowels).toMatchObject({ order: ['green', 'pink', 'blue'], stage: 'category' });
    expect(projectPublic(s, NOW).vowels?.order).toEqual(['green', 'pink', 'blue']);
    s = run(s, [{ type: 'vowels:showClue' }, { type: 'player:buzz', playerId: 'p-gus' }, { type: 'vowels:incorrect' }]);
    expect(s.vowels).toMatchObject({ stage: 'other', result: { team: null, delta: { pink: 0, blue: 0, green: -1, orange: 0 } } });
    expect(describeState(s)).toContain('Pink Panthers or Blue Whales (name the team) may answer');
    expect(allowedActions(s)).toEqual(expect.arrayContaining(['vowels:otherCorrect', 'vowels:nobody']));
    expectError(s, { type: 'vowels:otherCorrect' }, 'team_required');
    expectError(s, { type: 'vowels:otherCorrect', team: 'green' }, 'invalid_team'); // the buzzing team
    expectError(s, { type: 'vowels:otherCorrect', team: 'orange' }, 'invalid_team'); // not playing
    const blue = applyAction(s, { type: 'vowels:otherCorrect', team: 'blue' }, ctx);
    expect(blue.vowels).toMatchObject({ stage: 'answer', result: { team: 'blue', delta: { pink: 0, blue: 1, green: -1, orange: 0 } } });
    expect(blue.teams).toMatchObject({ pink: { score: 0 }, blue: { score: 1 }, green: { score: -1 }, orange: { score: 0 } });
    const nobody = applyAction(s, { type: 'vowels:nobody' }, ctx);
    expect(nobody.vowels?.result).toEqual({ team: null, delta: { pink: 0, blue: 0, green: -1, orange: 0 } });
    // Two teams: the other team is implied; naming it is accepted, naming the buzzer is not.
    const two = run(withPlayers(newGame()), [{ type: 'round:start', round: 'vowels' }, { type: 'vowels:showClue' }, { type: 'player:buzz', playerId: 'p-bob' }, { type: 'vowels:incorrect' }]);
    expect(applyAction(two, { type: 'vowels:otherCorrect' }, ctx).teams.pink.score).toBe(1);
    expect(applyAction(two, { type: 'vowels:otherCorrect', team: 'pink' }, ctx).teams.pink.score).toBe(1);
    expectError(two, { type: 'vowels:otherCorrect', team: 'blue' }, 'invalid_team');
  });
});

describe('final standings', () => {
  it('ranks the playing teams and describes wins and ties among several teams', () => {
    let s = run(newGameWith(THREE), [{ type: 'round:start', round: 'vowels' }, { type: 'round:final' }]);
    expect(teamStandings(s)).toEqual(['pink', 'blue', 'green']);
    expect(winningTeam(s)).toBeNull();
    expect(describeState(s)).toBe('Final — tie at 0');
    s = run(s, [{ type: 'game:adjustScore', team: 'green', delta: 7 }, { type: 'game:adjustScore', team: 'blue', delta: 7 }]);
    expect(teamStandings(s)).toEqual(['blue', 'green', 'pink']);
    expect(winningTeam(s)).toBeNull();
    expect(describeState(s)).toBe('Final — tie at 7 between Blue Whales and Green Geckos');
    s = applyAction(s, { type: 'game:adjustScore', team: 'green', delta: 1 }, ctx);
    expect(winningTeam(s)).toBe('green');
    expect(describeState(s)).toBe('Final — Green Geckos win with 8 (Blue Whales 7, Pink Panthers 0)');
    // Two teams keep the show's wording.
    const two = run(newGame(), [{ type: 'game:adjustScore', team: 'blue', delta: 3 }, { type: 'round:start', round: 'vowels' }, { type: 'round:final' }]);
    expect(describeState(two)).toBe('Final — Blue Whales win 3–0');
    expect(winningTeam(two)).toBe('blue');
  });
});

describe('legacy (V3) states', () => {
  /** A state shaped like one persisted before V3.2: two teams, `firstTeam`, round states without `order`. */
  function legacy(): GameState {
    const fresh = newGame('blue');
    const { activeTeams: dropped, ...rest } = fresh;
    void dropped;
    const teams = { pink: fresh.teams.pink, blue: fresh.teams.blue } as GameState['teams'];
    const base = { ...rest, teams, firstTeam: 'blue' as const };
    // Hand-written round states (no `order` anywhere): a suspended Connections round after one question,
    // the wall round on screen with one wall done (pink chose first, so blue is choosing now), and a
    // suspended vowels round.
    const question: NonNullable<GameState['question']> = {
      round: 'connections',
      stage: 'selecting',
      team: 'pink',
      available: ['twoReeds', 'lion', 'twistedFlax', 'hornedViper', 'water', 'eyeOfHorus'],
      used: ['lion'],
      questionId: null,
      revealed: 0,
      pointsOnOffer: 0,
      result: null,
      questionsDone: 1,
      questionsTotal: 6,
      startedAt: null,
      endsAt: null,
      timeUp: false,
    };
    const wall: NonNullable<GameState['wall']> = {
      stage: 'selecting',
      team: 'blue',
      available: ['lion', 'water'],
      used: ['lion'],
      current: null,
      wallsDone: 1,
      wallsTotal: 2,
    };
    const vowels: NonNullable<GameState['vowels']> = {
      stage: 'answer',
      groupIndex: 0,
      clueIndex: 0,
      buzz: { playerId: 'p-ann', playerName: 'Ann', team: 'pink', at: NOW },
      result: { team: null, delta: { pink: -1, blue: 0 } as Record<TeamId, number> },
      lockedPlayers: [],
    };
    return { ...base, phase: 'wall', wall, suspended: { connections: question, vowels } };
  }

  it('normalizeGameState fills activeTeams, the idle team records and every round order', () => {
    const old = legacy();
    expect(old.activeTeams).toBeUndefined();
    expect(Object.keys(old.teams)).toEqual(['pink', 'blue']);
    const s = normalizeGameState(old);
    expect(s).not.toBe(old);
    expect(s.activeTeams).toEqual(['pink', 'blue']);
    expect(s.teams.green).toEqual({ id: 'green', name: 'Green team', score: 0 });
    expect(s.teams.orange).toEqual({ id: 'orange', name: 'Orange team', score: 0 });
    expect(s.teams.pink).toBe(old.teams.pink);
    expect(s.wall?.order).toEqual(['pink', 'blue']); // blue chooses with one wall done: pink went first
    expect(s.suspended?.connections?.order).toEqual(['blue', 'pink']); // firstTeam opened Connections
    expect(s.suspended?.vowels?.order).toEqual(['blue', 'pink']);
    expect(s.firstTeam).toBe('blue');
    // Idempotent, and a V3.2 state comes back as the same object.
    expect(normalizeGameState(s)).toBe(s);
    const fresh = newGame();
    expect(normalizeGameState(fresh)).toBe(fresh);
    // A legacy Sequences round reads as "the other team first".
    const seq: GameState = { ...old, phase: 'sequences', wall: null, question: { ...(old.suspended?.connections as NonNullable<GameState['question']>), round: 'sequences', team: 'blue' } };
    expect(normalizeGameState(seq).question?.order).toEqual(['pink', 'blue']);
    // A suspended wall with an odd number of walls done: the chooser is the second team.
    const paused: GameState = { ...old, phase: 'lobby', wall: null, suspended: { wall: old.wall as NonNullable<GameState['wall']> } };
    expect(normalizeGameState(paused).suspended?.wall?.order).toEqual(['pink', 'blue']);
  });

  it('the engine and the projection work on a legacy state without normalising it first', () => {
    const old = legacy();
    const pub = projectPublic(old, NOW);
    expect(pub.activeTeams).toEqual(['pink', 'blue']);
    expect(Object.keys(pub.teams).sort()).toEqual([...TEAM_IDS].sort());
    expect(pub.wall?.order).toEqual(['pink', 'blue']);
    expect(suggestedRoundOrder(old)).toEqual(['pink', 'blue']); // level scores: the previous (wall) order
    expect(describeState(old)).toBe('Connecting Wall — wall 2 of 2: Blue Whales to choose');
    // Playing on writes the resolved order into the state and the round ends normally.
    let s = perfectWall(old);
    expect(s.wall).toMatchObject({ order: ['pink', 'blue'], wallsDone: 2, wallsTotal: 2 });
    expect(s.finishedRounds).toEqual(['wall']);
    expect(s.teams.blue.score).toBe(10);
    // Resuming the suspended Connections round: the next picker follows the legacy order.
    s = applyAction(s, { type: 'round:start', round: 'connections', order: ['pink', 'blue'] }, ctx); // ignored: resumed
    expect(s.question).toMatchObject({ team: 'pink', questionsDone: 1 });
    expect(projectPublic(s, NOW).question?.order).toEqual(['blue', 'pink']);
    s = run(s, [{ type: 'q:select', hieroglyph: 'water' }, { type: 'q:incorrect' }]);
    expect(applyAction(s, { type: 'q:stealCorrect' }, ctx).teams.blue.score).toBe(11); // two teams: implied
    s = run(s, [{ type: 'q:stealIncorrect' }, { type: 'q:next' }]);
    expect(s.question).toMatchObject({ order: ['blue', 'pink'], team: 'blue', questionsDone: 2 });
    // A legacy vowels result (two-key delta) is completed on the way out.
    const v = run(s, [{ type: 'round:start', round: 'vowels' }]);
    expect(projectPublic(v, NOW).vowels?.result).toEqual({ team: null, delta: { pink: -1, blue: 0, green: 0, orange: 0 } });
    expect(v.vowels?.order).toBeUndefined(); // a resumed round keeps its stored shape...
    expect(projectPublic(v, NOW).vowels?.order).toEqual(['blue', 'pink']); // ...but the projection resolves it
  });
});

describe('hardening', () => {
  it('the public state never lacks order / activeTeams and idle teams never score, through a whole 3-team game', () => {
    let s = run(newGameWith(THREE, customPack({ walls: 4, connections: 3, sequences: 3 })), [
      { type: 'player:join', playerId: 'p-ann', name: 'Ann', team: 'pink' },
      { type: 'player:join', playerId: 'p-bob', name: 'Bob', team: 'blue' },
      { type: 'player:join', playerId: 'p-gus', name: 'Gus', team: 'green' },
    ]);
    const states: GameState[] = [s];
    const step = (action: Parameters<typeof applyAction>[1]) => {
      s = applyAction(s, action, ctx);
      states.push(s);
    };
    step({ type: 'round:start', round: 'connections', order: ['green', 'blue', 'pink'] });
    for (const [g, outcome] of [['twoReeds', 'correct'], ['lion', 'steal'], ['twistedFlax', 'void']] as const) {
      step({ type: 'q:select', hieroglyph: g });
      if (outcome === 'correct') step({ type: 'q:correct' });
      if (outcome === 'steal') {
        step({ type: 'q:incorrect' });
        step({ type: 'q:stealCorrect', team: 'pink' });
      }
      if (outcome === 'void') step({ type: 'q:void' });
      else step({ type: 'q:next' });
    }
    step({ type: 'round:start', round: 'sequences' });
    expect(q(s).order).toEqual(['blue', 'pink', 'green']); // blue 0, pink 1, green 5
    for (const g of ['twoReeds', 'lion', 'twistedFlax'] as const) {
      step({ type: 'q:select', hieroglyph: g });
      step({ type: 'q:reveal' });
      step({ type: 'q:correct' });
      step({ type: 'q:next' });
    }
    step({ type: 'round:start', round: 'wall' });
    expect(s.wall?.order).toEqual(['blue', 'pink', 'green']);
    for (let i = 0; i < 3; i++) {
      const before = s;
      s = perfectWall(s);
      states.push(s);
      expect(s.version).toBeGreaterThan(before.version);
    }
    step({ type: 'round:start', round: 'vowels' });
    step({ type: 'vowels:showClue' });
    step({ type: 'player:buzz', playerId: 'p-bob' });
    step({ type: 'vowels:incorrect' });
    step({ type: 'vowels:otherCorrect', team: 'green' });
    step({ type: 'round:final' });
    step({ type: 'game:lobby' });
    expect(s.finishedRounds).toEqual(['connections', 'sequences', 'wall']);
    for (const state of states) {
      expect(state.teams.orange.score, `v${state.version}: idle orange scored`).toBe(0);
      expect(Object.keys(state.teams).sort()).toEqual([...TEAM_IDS].sort());
      const pub = projectPublic(state, state.updatedAt);
      expect(pub.activeTeams).toEqual(THREE);
      expect(Object.keys(pub.teams).sort()).toEqual([...TEAM_IDS].sort());
      if (pub.question) expect(pub.question.order.slice().sort()).toEqual([...THREE].sort());
      if (pub.wall) expect(pub.wall.order.slice().sort()).toEqual([...THREE].sort());
      if (pub.vowels) {
        expect(pub.vowels.order.slice().sort()).toEqual([...THREE].sort());
        if (pub.vowels.result) expect(Object.keys(pub.vowels.result.delta).sort()).toEqual([...TEAM_IDS].sort());
      }
      // The team on screen is always a playing team, and always the one the order says.
      if (state.question && state.question.questionsDone < state.question.questionsTotal) {
        const o = state.question.order as TeamId[];
        expect(state.question.team).toBe(o[state.question.questionsDone % o.length]);
      }
      if (state.wall && state.wall.wallsDone < state.wall.wallsTotal) {
        const o = state.wall.order as TeamId[];
        expect(state.wall.team).toBe(o[state.wall.wallsDone % o.length]);
      }
    }
    expect(s.teams).toMatchObject({ pink: { score: 1 + 3 + 10 }, blue: { score: 3 + 10 - 1 }, green: { score: 5 + 3 + 10 + 1 }, orange: { score: 0 } });
    expect(winningTeam(s)).toBe('green');
  });
});
