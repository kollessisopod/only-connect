import { describe, expect, it } from 'vitest';
import { GameError, type AdminAction, type GameState, type Pack } from '../../types.js';
import { allowedActions, applyAction, createGame, describeState, winningTeam } from '../game.js';
import { validatePack } from '../validate.js';
import { demoPack, expectError, liveWall, makeCtx, newGame, run, selectGroup, withPlayers, NOW, TEAM_NAMES, buildDemoPack } from './fixtures.js';

const ctx = makeCtx();

const ALL_TYPES: AdminAction['type'][] = [
  'game:new', 'game:setTeamName', 'game:adjustScore', 'game:removePlayer', 'game:lobby', 'game:undo', 'round:start',
  'q:select', 'q:reveal', 'q:correct', 'q:incorrect', 'q:stealCorrect', 'q:stealIncorrect', 'q:void', 'q:next',
  'wall:assign', 'wall:show', 'wall:start', 'wall:timeUp', 'wall:abort', 'wall:resolve', 'wall:connectionCorrect',
  'wall:connectionIncorrect', 'wall:finish', 'wall:clear', 'vowels:showClue', 'vowels:correct', 'vowels:incorrect',
  'vowels:otherCorrect', 'vowels:nobody', 'vowels:reopen', 'vowels:next', 'vowels:skipCategory', 'round:final',
  'media:play', 'media:stop',
];

function playConnections(state: GameState): GameState {
  let s = applyAction(state, { type: 'round:start', round: 'connections' }, ctx);
  for (const g of ['twoReeds', 'lion', 'twistedFlax', 'hornedViper', 'water', 'eyeOfHorus'] as const) {
    s = run(s, [{ type: 'q:select', hieroglyph: g }, { type: 'q:correct' }, { type: 'q:next' }]);
  }
  return s;
}

describe('createGame', () => {
  it('builds a lobby state from a playable pack', () => {
    const s = newGame('blue');
    expect(s).toMatchObject({
      id: 'id-1',
      packId: s.pack.id,
      phase: 'lobby',
      createdAt: NOW,
      updatedAt: NOW,
      firstTeam: 'blue',
      players: [],
      question: null,
      wall: null,
      vowels: null,
      version: 0,
      playMedia: null,
      finishedRounds: [],
    });
    expect(s.teams).toEqual({
      pink: { id: 'pink', name: 'Pink Panthers', score: 0 },
      blue: { id: 'blue', name: 'Blue Whales', score: 0 },
    });
  });

  it('falls back to default team names and rejects unplayable packs', () => {
    const s = createGame(demoPack(), { pink: { name: '  ' }, blue: { name: '' } }, 'pink', ctx);
    expect(s.teams.pink.name).toBe('Pink');
    expect(s.teams.blue.name).toBe('Blue');

    const bad: Pack = { ...demoPack(), walls: [] };
    let caught: unknown;
    try {
      createGame(bad, TEAM_NAMES, 'pink', ctx);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(GameError);
    expect((caught as GameError).code).toBe('unplayable_pack');
  });
});

describe('buildDemoPack', () => {
  it('is playable, uses the id factory for every id and is deterministic', () => {
    const pack = demoPack();
    expect(validatePack(pack)).toEqual([]);
    const ids = [pack.id, ...pack.questions.map((q) => q.id), ...pack.walls.map((w) => w.id), ...pack.vowelGroups.map((g) => g.id)];
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.startsWith('pack-'))).toBe(true);
    expect(pack.questions.filter((q) => q.round === 'connections')).toHaveLength(6);
    expect(pack.questions.filter((q) => q.round === 'sequences')).toHaveLength(6);
    expect(pack.walls).toHaveLength(2);
    expect(pack.vowelGroups.length).toBeGreaterThanOrEqual(2);
    expect(pack.vowelGroups.every((g) => g.clues.length === 4)).toBe(true);
    expect(pack.questions.some((q) => q.clues[0].kind === 'image')).toBe(true);
    expect(pack.questions.some((q) => q.clues[0].kind === 'audio')).toBe(true);
    for (const g of pack.vowelGroups) for (const c of g.clues) expect(c.display).not.toMatch(/[AEIOU]/);
    expect(JSON.parse(JSON.stringify(pack))).toEqual(pack); // no undefined keys
    let n = 0;
    expect(buildDemoPack(() => `pack-${++n}`)).toEqual(pack);
  });

  it('can be built without media clues', () => {
    const pack = demoPack({ media: false, name: 'Text only' });
    expect(pack.name).toBe('Text only');
    expect(pack.questions.every((q) => q.clues.every((c) => c.kind === 'text' && !c.media))).toBe(true);
    expect(validatePack(pack)).toEqual([]);
  });
});

describe('applyAction', () => {
  it('bumps version, stamps updatedAt and never mutates the input', () => {
    const s = withPlayers(newGame());
    const before = JSON.stringify(s);
    const later = makeCtx({ now: NOW + 500 });
    const next = applyAction(s, { type: 'game:adjustScore', team: 'blue', delta: 1 }, later);
    expect(JSON.stringify(s)).toBe(before);
    expect(next.version).toBe(s.version + 1);
    expect(next.updatedAt).toBe(NOW + 500);
    expect(next.teams.blue.score).toBe(1);
    expect(next).not.toBe(s);
  });

  it('rejects game:new, malformed and unknown actions', () => {
    const s = newGame();
    expectError(s, { type: 'game:new', packId: 'x', teams: TEAM_NAMES, firstTeam: 'pink' });
    expect(() => applyAction(s, { type: 'nope' } as unknown as AdminAction, ctx)).toThrow(GameError);
    expect(() => applyAction(s, null as unknown as AdminAction, ctx)).toThrow(GameError);
  });

  it('manages players: join, rejoin, connection flag, leave, remove', () => {
    let s = withPlayers(newGame());
    expect(s.players.map((p) => [p.id, p.team, p.connected, p.joinedAt])).toEqual([
      ['p-ann', 'pink', true, NOW],
      ['p-bob', 'blue', true, NOW],
      ['p-cat', 'pink', true, NOW],
    ]);
    s = applyAction(s, { type: 'player:connected', playerId: 'p-bob', connected: false }, ctx);
    expect(s.players[1].connected).toBe(false);
    s = applyAction(s, { type: 'player:join', playerId: 'p-bob', name: 'Robert', team: 'pink' }, makeCtx({ now: NOW + 9 }));
    expect(s.players[1]).toEqual({ id: 'p-bob', name: 'Robert', team: 'pink', connected: true, joinedAt: NOW });
    expect(s.players).toHaveLength(3);
    s = applyAction(s, { type: 'player:leave', playerId: 'p-cat' }, ctx);
    s = applyAction(s, { type: 'game:removePlayer', playerId: 'p-ann' }, ctx);
    expect(s.players.map((p) => p.id)).toEqual(['p-bob']);
    expectError(s, { type: 'game:removePlayer', playerId: 'p-ann' }, 'unknown_player');
    expectError(s, { type: 'player:connected', playerId: 'p-ann', connected: true }, 'unknown_player');
    expectError(s, { type: 'player:join', playerId: '', name: 'X', team: 'pink' });
    expectError(s, { type: 'player:join', playerId: 'p-x', name: '  ', team: 'pink' });
    expectError(s, { type: 'player:join', playerId: 'p-x', name: 'X', team: 'green' as 'pink' });
  });

  it('allows score adjustments and renames in any phase, including negative scores', () => {
    let s = run(newGame(), [{ type: 'game:adjustScore', team: 'pink', delta: -1 }, { type: 'game:setTeamName', team: 'blue', name: '  The Blues ' }]);
    expect(s.teams.pink.score).toBe(-1);
    expect(s.teams.blue.name).toBe('The Blues');
    expectError(s, { type: 'game:setTeamName', team: 'blue', name: '' });
    expectError(s, { type: 'game:adjustScore', team: 'blue', delta: 0.5 });
    s = liveWall('pink', ctx, s);
    s = run(s, [{ type: 'game:adjustScore', team: 'blue', delta: 3 }, { type: 'game:setTeamName', team: 'pink', name: 'Rosé' }]);
    expect(s.teams.blue.score).toBe(3);
    expect(s.teams.pink.name).toBe('Rosé');
    expect(s.wall?.current?.stage).toBe('live');
  });

  it('game:lobby keeps scores, players and finished rounds but drops the round state', () => {
    let s = playConnections(withPlayers(newGame()));
    expect(s.teams.pink.score + s.teams.blue.score).toBe(30);
    s = applyAction(s, { type: 'game:lobby' }, ctx);
    expect(s).toMatchObject({ phase: 'lobby', question: null, wall: null, vowels: null, finishedRounds: ['connections'] });
    expect(s.players).toHaveLength(3);
    expect(s.teams.pink.score + s.teams.blue.score).toBe(30);
    expectError(s, { type: 'game:lobby' });
    expectError(s, { type: 'round:start', round: 'connections' });
    expect(allowedActions(s)).toContain('round:final');
  });

  it('round:final needs at least one played round (or the vowels phase)', () => {
    const fresh = newGame();
    expectError(fresh, { type: 'round:final' });
    expect(allowedActions(fresh)).not.toContain('round:final');
    const s = applyAction(playConnections(fresh), { type: 'round:final' }, ctx);
    expect(s.phase).toBe('final');
    expect(s.question).toBeNull();
    expect(allowedActions(s)).toContain('round:start');
    expect(allowedActions(s)).toContain('game:lobby');
  });
});

describe('allowedActions', () => {
  it('lobby: only setup, scores and round:start', () => {
    const allowed = allowedActions(newGame());
    expect(allowed.sort()).toEqual(['game:new', 'game:setTeamName', 'game:adjustScore', 'round:start'].sort());
    expect(allowedActions(withPlayers(newGame()))).toContain('game:removePlayer');
  });

  it('matches what applyAction accepts for payload-free actions in every stage of a game', () => {
    // wall:timeUp is excluded: it is a server-timer action that is deliberately a no-op (not an error) once the
    // wall has ended, so it applies in more states than it is offered as a button. game:undo is handled by
    // the host (the engine always rejects it and never offers it).
    const payloadFree = ALL_TYPES.filter(
      (t) => !['game:new', 'game:undo', 'game:setTeamName', 'game:adjustScore', 'game:removePlayer', 'round:start', 'q:select', 'wall:assign', 'wall:show', 'wall:timeUp'].includes(t),
    );
    const check = (s: GameState, label: string) => {
      const allowed = new Set(allowedActions(s));
      for (const t of payloadFree) {
        let ok = true;
        try {
          applyAction(s, { type: t } as AdminAction, ctx);
        } catch (e) {
          if (!(e instanceof GameError)) throw e;
          ok = false;
        }
        expect(ok, `${label}: ${t} allowed=${allowed.has(t)} applies=${ok}`).toBe(allowed.has(t));
      }
    };

    let s = withPlayers(newGame());
    check(s, 'lobby');
    s = applyAction(s, { type: 'round:start', round: 'connections' }, ctx);
    check(s, 'selecting');
    s = applyAction(s, { type: 'q:select', hieroglyph: 'hornedViper' }, ctx);
    check(s, 'question');
    s = run(s, [{ type: 'q:reveal' }, { type: 'q:reveal' }, { type: 'q:reveal' }]);
    check(s, 'question/all revealed');
    s = applyAction(s, { type: 'q:incorrect' }, ctx);
    check(s, 'steal');
    s = applyAction(s, { type: 'q:stealCorrect' }, ctx);
    check(s, 'answer');
    s = applyAction(s, { type: 'media:stop' }, ctx);
    check(s, 'answer/no media');
    s = applyAction(s, { type: 'round:start', round: 'wall' }, ctx);
    check(s, 'wall/none');
    s = applyAction(s, { type: 'wall:show', team: 'blue' }, ctx);
    check(s, 'wall/ready');
    s = applyAction(s, { type: 'wall:start' }, ctx);
    check(s, 'wall/live');
    s = selectGroup(s, 0);
    s = selectGroup(s, 1);
    check(s, 'wall/live 2 groups');
    s = applyAction(s, { type: 'wall:timeUp' }, ctx);
    check(s, 'wall/frozen');
    expect(allowedActions(s)).not.toContain('wall:timeUp');
    expect(applyAction(s, { type: 'wall:timeUp' }, ctx).wall).toEqual(s.wall); // no-op once frozen
    s = applyAction(s, { type: 'wall:resolve' }, ctx);
    check(s, 'wall/resolving');
    s = run(s, [{ type: 'wall:connectionCorrect' }, { type: 'wall:connectionCorrect' }, { type: 'wall:connectionIncorrect' }, { type: 'wall:connectionCorrect' }]);
    check(s, 'wall/resolved');
    s = applyAction(s, { type: 'wall:finish' }, ctx);
    check(s, 'wall/done');
    s = applyAction(s, { type: 'wall:clear' }, ctx);
    check(s, 'wall/one done');
    s = applyAction(s, { type: 'round:start', round: 'vowels' }, ctx);
    check(s, 'vowels/category');
    s = applyAction(s, { type: 'vowels:showClue' }, ctx);
    check(s, 'vowels/clue');
    s = applyAction(s, { type: 'player:buzz', playerId: 'p-ann' }, ctx);
    check(s, 'vowels/buzzed');
    s = applyAction(s, { type: 'vowels:incorrect' }, ctx);
    check(s, 'vowels/other');
    s = applyAction(s, { type: 'vowels:nobody' }, ctx);
    check(s, 'vowels/answer');
    s = applyAction(s, { type: 'round:final' }, ctx);
    check(s, 'final');
  });
});

describe('describeState and winningTeam', () => {
  it('describes each phase for the admin console', () => {
    let s = withPlayers(newGame('blue'));
    expect(describeState(s)).toBe('Lobby — waiting to start');
    s = applyAction(s, { type: 'round:start', round: 'connections' }, ctx);
    expect(describeState(s)).toBe('Connections — Blue Whales to pick (0/6 done)');
    s = applyAction(s, { type: 'q:select', hieroglyph: 'lion' }, ctx);
    expect(describeState(s)).toBe('Connections — Q1 (lion): Blue Whales answering, 1 clue shown, 5 points on offer');
    s = applyAction(s, { type: 'q:incorrect' }, ctx);
    expect(describeState(s)).toBe('Connections — Q1 (lion): Pink Panthers may steal for 1 point');
    s = applyAction(s, { type: 'q:stealCorrect' }, ctx);
    expect(describeState(s)).toBe('Connections — Q1 (lion) answer shown: Pink Panthers +1 (steal); next up Pink Panthers');
    s = applyAction(s, { type: 'round:start', round: 'sequences' }, ctx);
    expect(describeState(s)).toBe('Sequences — Pink Panthers to pick (0/6 done)');
    s = applyAction(s, { type: 'round:start', round: 'wall' }, ctx);
    expect(describeState(s)).toBe('Connecting Wall — choose a wall for Pink Panthers / Blue Whales');
    s = run(s, [{ type: 'wall:show', team: 'pink' }]);
    expect(describeState(s)).toBe('Connecting Wall — Pink Panthers: wall on screen, waiting to start');
    s = run(s, [{ type: 'wall:start' }]);
    expect(describeState(s)).toContain('Pink Panthers playing: 0/4 groups');
    s = run(s, [{ type: 'wall:timeUp' }]);
    expect(describeState(s)).toBe("Connecting Wall — Pink Panthers: time's up, 0/4 groups found; resolve the wall");
    s = run(s, [{ type: 'wall:resolve' }]);
    expect(describeState(s)).toBe('Connecting Wall — Pink Panthers: asking connection 1/4');
    s = run(s, [{ type: 'wall:connectionCorrect' }, { type: 'wall:connectionCorrect' }, { type: 'wall:connectionCorrect' }, { type: 'wall:connectionCorrect' }]);
    expect(describeState(s)).toBe('Connecting Wall — Pink Panthers: all connections judged; finish to award points');
    s = run(s, [{ type: 'wall:finish' }]);
    expect(describeState(s)).toBe('Connecting Wall — Pink Panthers scored 4; clear the wall');
    s = run(s, [{ type: 'wall:clear' }, { type: 'round:start', round: 'vowels' }]);
    expect(describeState(s)).toBe('Missing Vowels — Capital cities (1/3), clue 1/4: category shown');
    s = run(s, [{ type: 'vowels:showClue' }]);
    expect(describeState(s)).toBe('Missing Vowels — Capital cities (1/3), clue 1/4: buzzers open');
    s = run(s, [{ type: 'player:buzz', playerId: 'p-bob' }]);
    expect(describeState(s)).toBe('Missing Vowels — Capital cities (1/3), clue 1/4: Bob (Blue Whales) buzzed — answer is "PARIS"');
    s = run(s, [{ type: 'vowels:incorrect' }]);
    expect(describeState(s)).toBe('Missing Vowels — Capital cities (1/3), clue 1/4: Pink Panthers may answer — "PARIS"');
    s = run(s, [{ type: 'vowels:nobody' }]);
    expect(describeState(s)).toBe('Missing Vowels — Capital cities (1/3), clue 1/4: answer shown');
    expect(s.teams.blue.score).toBe(-1); // the wrong buzz
    s = run(s, [{ type: 'game:adjustScore', team: 'blue', delta: 1 }, { type: 'round:final' }]);
    expect(describeState(s)).toBe('Final — Pink Panthers win 5–0');
    expect(winningTeam(s)).toBe('pink');
    s = run(s, [{ type: 'game:adjustScore', team: 'blue', delta: 5 }]);
    expect(describeState(s)).toBe('Final — tie at 5');
    expect(winningTeam(s)).toBeNull();
    // Nothing was played to completion in this run (one question, one wall, one vowel clue): those rounds
    // are paused, not played, and can be resumed.
    s = run(s, [{ type: 'game:lobby' }]);
    expect(s.finishedRounds).toEqual([]);
    expect(describeState(s)).toBe('Lobby — paused: Connections, Connecting Wall, Missing Vowels');
    expect(describeState(run(playConnections(newGame()), [{ type: 'game:lobby' }]))).toBe('Lobby — played: Connections');
  });
});
