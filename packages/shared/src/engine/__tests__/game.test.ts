import { describe, expect, it } from 'vitest';
import { GameError, type AdminAction, type GameState, type Pack } from '../../types.js';
import { allowedActions, applyAction, createGame, describeState, winningTeam } from '../game.js';
import { validatePack } from '../validate.js';
import { demoPack, expectError, liveWall, makeCtx, newGame, run, selectGroup, selectNextWall, withPlayers, NOW, TEAM_NAMES, buildDemoPack } from './fixtures.js';

const ctx = makeCtx();

const ALL_TYPES: AdminAction['type'][] = [
  'game:new', 'game:setTeamName', 'game:adjustScore', 'game:removePlayer', 'game:lobby', 'game:undo', 'round:start',
  'q:select', 'q:reveal', 'q:correct', 'q:incorrect', 'q:stealCorrect', 'q:stealIncorrect', 'q:void', 'q:next',
  'wall:select', 'wall:start', 'wall:timeUp', 'wall:abort', 'wall:resolve', 'wall:connectionCorrect',
  'wall:connectionIncorrect', 'wall:finish', 'wall:clear', 'vowels:showClue', 'vowels:correct', 'vowels:incorrect',
  'vowels:otherCorrect', 'vowels:nobody', 'vowels:reopen', 'vowels:next', 'vowels:skipCategory', 'round:final',
  'media:play', 'media:stop', 'q:timeUp', 'cue:play', 'cue:stop',
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
      cue: null,
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
    expect(allowed.sort()).toEqual(['game:new', 'game:setTeamName', 'game:adjustScore', 'round:start', 'cue:play'].sort());
    expect(allowedActions(withPlayers(newGame()))).toContain('game:removePlayer');
  });

  it('matches what applyAction accepts for payload-free actions in every stage of a game', () => {
    // wall:timeUp / q:timeUp are excluded: they are server-timer actions that are deliberately a no-op (not
    // an error) once the wall / clock has ended, so they apply in more states than they are offered as a
    // button. game:undo is handled by the host (the engine always rejects it and never offers it).
    const payloadFree = ALL_TYPES.filter(
      (t) => !['game:new', 'game:undo', 'game:setTeamName', 'game:adjustScore', 'game:removePlayer', 'round:start', 'q:select', 'wall:select', 'wall:timeUp', 'q:timeUp', 'cue:play'].includes(t),
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
    expect(allowedActions(s)).toContain('q:timeUp');
    s = run(s, [{ type: 'q:reveal' }, { type: 'q:reveal' }, { type: 'q:reveal' }]);
    check(s, 'question/all revealed');
    s = applyAction(s, { type: 'q:timeUp' }, ctx);
    check(s, 'question/time up');
    expect(allowedActions(s)).not.toContain('q:timeUp');
    expect(applyAction(s, { type: 'q:timeUp' }, ctx).question).toEqual(s.question); // no-op once up
    s = applyAction(s, { type: 'cue:play', cue: 'openingTitles' }, ctx);
    check(s, 'question/cue playing');
    s = applyAction(s, { type: 'cue:stop' }, ctx);
    s = applyAction(s, { type: 'q:incorrect' }, ctx);
    check(s, 'steal');
    s = applyAction(s, { type: 'q:stealCorrect' }, ctx);
    check(s, 'answer');
    s = applyAction(s, { type: 'media:stop' }, ctx);
    check(s, 'answer/no media');
    s = applyAction(s, { type: 'round:start', round: 'wall' }, ctx);
    check(s, 'wall/selecting');
    s = selectNextWall(s); // pink (0 v 1, behind) chooses
    expect(s.wall?.team).toBe('pink');
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
    check(s, 'wall/one done, blue to choose');
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

describe('show cues (V3)', () => {
  it('cue:play sets the cue with a fresh nonce, cue:stop clears it, and both are offered as expected', () => {
    let s = newGame();
    expect(s.cue).toBeNull();
    expect(allowedActions(s)).toContain('cue:play');
    expect(allowedActions(s)).not.toContain('cue:stop');
    expectError(s, { type: 'cue:stop' });
    s = applyAction(s, { type: 'cue:play', cue: 'openingTitles' }, ctx);
    expect(s.cue).toEqual({ name: 'openingTitles', nonce: s.version });
    expect(allowedActions(s)).toContain('cue:stop');
    const first = s.cue?.nonce ?? -1;
    // Repeating the same cue bumps the nonce so the monitor re-triggers it.
    s = applyAction(s, { type: 'cue:play', cue: 'openingTitles' }, ctx);
    expect(s.cue?.name).toBe('openingTitles');
    expect(s.cue?.nonce).toBeGreaterThan(first);
    s = applyAction(s, { type: 'cue:play', cue: 'introClip' }, ctx);
    expect(s.cue).toEqual({ name: 'introClip', nonce: s.version });
    s = applyAction(s, { type: 'cue:stop' }, ctx);
    expect(s.cue).toBeNull();
    expectError(s, { type: 'cue:stop' });
    expectError(s, { type: 'cue:play', cue: 'closingCredits' as 'introClip' });
    expectError(s, { type: 'cue:play' } as AdminAction);
  });

  it('is allowed in every phase and survives round changes; a new game starts without one', () => {
    let s = applyAction(withPlayers(newGame('pink')), { type: 'cue:play', cue: 'openingTitles' }, ctx);
    const cue = { name: 'openingTitles', nonce: s.version };
    s = applyAction(s, { type: 'round:start', round: 'connections' }, ctx);
    expect(s.cue).toEqual(cue);
    s = run(s, [{ type: 'q:select', hieroglyph: 'lion' }, { type: 'q:correct' }, { type: 'game:lobby' }]);
    expect(s.cue).toEqual(cue);
    expect(allowedActions(s)).toEqual(expect.arrayContaining(['cue:play', 'cue:stop']));
    s = run(s, [{ type: 'round:start', round: 'vowels' }, { type: 'round:final' }]);
    expect(s.phase).toBe('final');
    expect(s.cue).toEqual(cue);
    expect(allowedActions(s)).toContain('cue:play');
    // A state persisted before cues existed has no `cue` field: read as "no cue".
    const { cue: dropped, ...legacy } = s;
    void dropped;
    expect(allowedActions(legacy as GameState)).not.toContain('cue:stop');
    expectError(legacy as GameState, { type: 'cue:stop' });
    expect(applyAction(legacy as GameState, { type: 'cue:play', cue: 'introClip' }, ctx).cue).toEqual({ name: 'introClip', nonce: s.version + 1 });
    expect(newGame().cue).toBeNull();
  });
});

describe('describeState and winningTeam', () => {
  it('describes each phase for the admin console', () => {
    let s = withPlayers(newGame('blue'));
    expect(describeState(s)).toBe('Lobby — waiting to start');
    s = applyAction(s, { type: 'round:start', round: 'connections' }, ctx);
    expect(describeState(s)).toBe('Connections — Blue Whales to pick (0/6 done)');
    s = applyAction(s, { type: 'q:select', hieroglyph: 'lion' }, ctx);
    expect(describeState(s)).toBe('Connections — Q1 (lion): Blue Whales answering, 1 clue shown, 5 points on offer (40 s clock running)');
    s = applyAction(s, { type: 'q:timeUp' }, ctx);
    expect(describeState(s)).toBe("Connections — Q1 (lion): Blue Whales answering, 1 clue shown, 5 points on offer; time's up — they must answer");
    s = applyAction(s, { type: 'q:incorrect' }, ctx);
    expect(describeState(s)).toBe('Connections — Q1 (lion): Pink Panthers may steal for 1 point');
    s = applyAction(s, { type: 'q:stealCorrect' }, ctx);
    expect(describeState(s)).toBe('Connections — Q1 (lion) answer shown: Pink Panthers +1 (steal); next up Pink Panthers');
    s = applyAction(s, { type: 'round:start', round: 'sequences' }, ctx);
    expect(describeState(s)).toBe('Sequences — Pink Panthers to pick (0/6 done)');
    s = applyAction(s, { type: 'round:start', round: 'wall' }, ctx);
    // Blue (0) are behind pink (1) so they choose the first wall.
    expect(describeState(s)).toBe('Connecting Wall — wall 1 of 2: Blue Whales to choose');
    s = applyAction(s, { type: 'wall:select', hieroglyph: 'water' }, ctx);
    expect(describeState(s)).toBe('Connecting Wall — Blue Whales (wall 1 of 2, Water): wall on screen, waiting to start');
    s = run(s, [{ type: 'wall:start' }]);
    expect(describeState(s)).toContain('Blue Whales (wall 1 of 2, Water) playing: 0/4 groups');
    s = run(s, [{ type: 'wall:timeUp' }]);
    expect(describeState(s)).toBe("Connecting Wall — Blue Whales (wall 1 of 2, Water): time's up, 0/4 groups found; resolve the wall");
    s = run(s, [{ type: 'wall:resolve' }]);
    expect(describeState(s)).toBe('Connecting Wall — Blue Whales (wall 1 of 2, Water): asking connection 1/4');
    s = run(s, [{ type: 'wall:connectionCorrect' }, { type: 'wall:connectionCorrect' }, { type: 'wall:connectionCorrect' }, { type: 'wall:connectionCorrect' }]);
    expect(describeState(s)).toBe('Connecting Wall — Blue Whales (wall 1 of 2, Water): all connections judged; finish to award points');
    s = run(s, [{ type: 'wall:finish' }]);
    expect(describeState(s)).toBe('Connecting Wall — Blue Whales (wall 1 of 2, Water) scored 4; clear the wall');
    s = run(s, [{ type: 'wall:clear' }]);
    expect(describeState(s)).toBe('Connecting Wall — wall 2 of 2: Pink Panthers to choose');
    s = run(s, [{ type: 'round:start', round: 'vowels' }]);
    expect(describeState(s)).toBe('Missing Vowels — Capital cities (1/3), clue 1/4: category shown');
    s = run(s, [{ type: 'vowels:showClue' }]);
    expect(describeState(s)).toBe('Missing Vowels — Capital cities (1/3), clue 1/4: buzzers open');
    s = run(s, [{ type: 'player:buzz', playerId: 'p-bob' }]);
    expect(describeState(s)).toBe('Missing Vowels — Capital cities (1/3), clue 1/4: Bob (Blue Whales) buzzed — answer is "PARIS"');
    s = run(s, [{ type: 'vowels:incorrect' }]);
    expect(describeState(s)).toBe('Missing Vowels — Capital cities (1/3), clue 1/4: Pink Panthers may answer — "PARIS"');
    s = run(s, [{ type: 'vowels:nobody' }]);
    expect(describeState(s)).toBe('Missing Vowels — Capital cities (1/3), clue 1/4: answer shown');
    expect(s.teams.blue.score).toBe(3); // 4 from the wall, -1 for the wrong buzz
    s = run(s, [{ type: 'game:adjustScore', team: 'blue', delta: 1 }, { type: 'round:final' }]);
    expect(describeState(s)).toBe('Final — Blue Whales win 4–1');
    expect(winningTeam(s)).toBe('blue');
    s = run(s, [{ type: 'game:adjustScore', team: 'pink', delta: 3 }]);
    expect(describeState(s)).toBe('Final — tie at 4');
    expect(winningTeam(s)).toBeNull();
    // Nothing was played to completion in this run (one question, one wall, one vowel clue): those rounds
    // are paused, not played, and can be resumed.
    s = run(s, [{ type: 'game:lobby' }]);
    expect(s.finishedRounds).toEqual([]);
    expect(describeState(s)).toBe('Lobby — paused: Connections, Connecting Wall, Missing Vowels');
    expect(describeState(run(playConnections(newGame()), [{ type: 'game:lobby' }]))).toBe('Lobby — played: Connections');
  });
});
