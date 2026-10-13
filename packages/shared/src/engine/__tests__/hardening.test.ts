/**
 * Behaviour added by the review fixes: player ownership (secrets), the player cap, removed players,
 * team lock during Missing Vowels, suspend/resume of rounds, q:void, wall:abort, audio on judgement and
 * per-clue media:play.
 */
import { describe, expect, it } from 'vitest';
import { MAX_PLAYERS, type GameState } from '../../types.js';
import { allowedActions, applyAction, canStartRound, describeState, isRoundSuspended, roundProgress } from '../game.js';
import { projectPublic } from '../project.js';
import { validatePack } from '../validate.js';
import { demoPack, expectError, liveWall, makeCtx, newGame, run, selectGroup, withPlayers, NOW } from './fixtures.js';

const ctx = makeCtx();

describe('player identity', () => {
  it('rejoining an existing id requires the secret it was created with', () => {
    let s = applyAction(newGame(), { type: 'player:join', playerId: 'p1', name: 'Ann', team: 'pink', secret: 's-ann' }, ctx);
    expect(s.players[0]).toMatchObject({ id: 'p1', secret: 's-ann' });
    expectError(s, { type: 'player:join', playerId: 'p1', name: 'Hacked', team: 'blue', secret: 'wrong' }, 'not_owner');
    expectError(s, { type: 'player:join', playerId: 'p1', name: 'Hacked', team: 'blue' }, 'not_owner');
    s = applyAction(s, { type: 'player:join', playerId: 'p1', name: 'Annie', team: 'blue', secret: 's-ann' }, ctx);
    expect(s.players[0]).toMatchObject({ id: 'p1', name: 'Annie', team: 'blue', secret: 's-ann' });
    expect(s.players).toHaveLength(1);
  });

  it('a player persisted without a secret adopts the first one it is rejoined with', () => {
    let s = withPlayers(newGame()); // fixtures join without secrets
    s = applyAction(s, { type: 'player:join', playerId: 'p-ann', name: 'Ann', team: 'pink', secret: 'first' }, ctx);
    expect(s.players[0].secret).toBe('first');
    expectError(s, { type: 'player:join', playerId: 'p-ann', name: 'Ann', team: 'pink', secret: 'second' }, 'not_owner');
  });

  it('never leaks secrets in the public projection', () => {
    const s = applyAction(newGame(), { type: 'player:join', playerId: 'p1', name: 'Ann', team: 'pink', secret: 'top-secret' }, ctx);
    const pub = projectPublic(s, NOW);
    expect(pub.players[0]).toEqual({ id: 'p1', name: 'Ann', team: 'pink', connected: true, joinedAt: NOW });
    expect(JSON.stringify(pub)).not.toContain('top-secret');
  });

  it('caps the number of players', () => {
    let s = newGame();
    for (let i = 0; i < MAX_PLAYERS; i++) s = applyAction(s, { type: 'player:join', playerId: `p${i}`, name: `P${i}`, team: 'pink' }, ctx);
    expectError(s, { type: 'player:join', playerId: 'one-too-many', name: 'X', team: 'blue' }, 'game_full');
    // Rejoining is still fine when full.
    expect(applyAction(s, { type: 'player:join', playerId: 'p3', name: 'P3', team: 'pink' }, ctx).players).toHaveLength(MAX_PLAYERS);
  });

  it('a player removed by the host cannot silently come back; a voluntary leave can', () => {
    let s = withPlayers(newGame());
    s = applyAction(s, { type: 'game:removePlayer', playerId: 'p-ann' }, ctx);
    expect(s.removedPlayers).toEqual(['p-ann']);
    expectError(s, { type: 'player:join', playerId: 'p-ann', name: 'Ann', team: 'pink' }, 'player_removed');
    s = applyAction(s, { type: 'player:leave', playerId: 'p-bob' }, ctx);
    s = applyAction(s, { type: 'player:join', playerId: 'p-bob', name: 'Bob', team: 'blue' }, ctx);
    expect(s.players.map((p) => p.id)).toEqual(['p-cat', 'p-bob']);
  });

  it('refuses team changes during Missing Vowels', () => {
    let s = run(withPlayers(newGame()), [{ type: 'round:start', round: 'vowels' }]);
    expectError(s, { type: 'player:join', playerId: 'p-ann', name: 'Ann', team: 'blue' }, 'team_locked');
    s = applyAction(s, { type: 'player:join', playerId: 'p-ann', name: 'Ann', team: 'pink' }, ctx);
    expect(s.players[0].team).toBe('pink');
  });
});

describe('leaving and resuming rounds', () => {
  it('a half-played question round is resumed, not restarted', () => {
    let s = run(newGame('pink'), [{ type: 'round:start', round: 'connections' }, { type: 'q:select', hieroglyph: 'lion' }, { type: 'q:correct' }, { type: 'q:next' }]);
    expect(roundProgress(s)).toBe('1 of 6 questions played');
    expect(canStartRound(s, 'connections')).toBe(false); // already in progress
    expectError(s, { type: 'round:start', round: 'connections' });
    s = applyAction(s, { type: 'round:start', round: 'sequences' }, ctx);
    expect(isRoundSuspended(s, 'connections')).toBe(true);
    expect(s.phase).toBe('sequences');
    s = applyAction(s, { type: 'game:lobby' }, ctx);
    expect(describeState(s)).toBe('Lobby — paused: Connections');
    s = applyAction(s, { type: 'round:start', round: 'connections' }, ctx);
    expect(s.phase).toBe('connections');
    expect(s.question).toMatchObject({ stage: 'selecting', team: 'blue', used: ['lion'], questionsDone: 1 });
    expect(isRoundSuspended(s, 'connections')).toBe(false);
    expect(s.teams.pink.score).toBe(5);
    expectError(s, { type: 'q:select', hieroglyph: 'lion' });
  });

  it('a wall round keeps completed walls across a detour to the lobby; vowels come back at the category bar', () => {
    let s = liveWall('pink');
    s = selectGroup(s, 0);
    s = selectGroup(s, 1);
    s = run(s, [{ type: 'wall:timeUp' }, { type: 'wall:resolve' }, { type: 'wall:connectionCorrect' }, { type: 'wall:connectionCorrect' }, { type: 'wall:connectionCorrect' }, { type: 'wall:connectionCorrect' }, { type: 'wall:finish' }, { type: 'wall:clear' }]);
    expect(s.wall?.completed).toEqual(['pink']);
    s = applyAction(s, { type: 'game:lobby' }, ctx);
    s = applyAction(s, { type: 'round:start', round: 'wall' }, ctx);
    expect(s.wall?.completed).toEqual(['pink']);
    expectError(s, { type: 'wall:show', team: 'pink' });

    s = run(s, [{ type: 'round:start', round: 'vowels' }, { type: 'vowels:showClue' }]);
    expect(roundProgress(s)).toBe('category 1, clue 1');
    s = run(s, [{ type: 'round:final' }]);
    expect(isRoundSuspended(s, 'vowels')).toBe(true);
    expect(isRoundSuspended(s, 'wall')).toBe(true);
    s = applyAction(s, { type: 'round:start', round: 'vowels' }, ctx);
    expect(s.vowels).toMatchObject({ stage: 'category', groupIndex: 0, clueIndex: 0 });
  });

  it('nothing is suspended when nothing was played', () => {
    let s = run(newGame(), [{ type: 'round:start', round: 'connections' }]);
    expect(roundProgress(s)).toBeNull();
    s = applyAction(s, { type: 'game:lobby' }, ctx);
    expect(s.suspended ?? {}).toEqual({});
    expect(describeState(s)).toBe('Lobby — waiting to start');
  });
});

describe('q:void', () => {
  it('skips a broken question without revealing anything or offering a steal', () => {
    let s = run(newGame('pink'), [{ type: 'round:start', round: 'connections' }, { type: 'q:select', hieroglyph: 'lion' }]);
    expect(allowedActions(s)).toContain('q:void');
    const pack = s.pack;
    const answer = pack.questions.find((q) => q.round === 'connections' && q.hieroglyph === 'lion')?.answer ?? '';
    s = applyAction(s, { type: 'q:void' }, ctx);
    expect(s.question).toMatchObject({ stage: 'selecting', team: 'blue', used: ['lion'], questionsDone: 1, questionId: null, result: null });
    expect(s.teams.pink.score + s.teams.blue.score).toBe(0);
    expect(JSON.stringify(projectPublic(s, NOW))).not.toContain(answer);
    // Also allowed from the steal stage; never from selecting / answer.
    s = run(s, [{ type: 'q:select', hieroglyph: 'water' }, { type: 'q:incorrect' }]);
    s = applyAction(s, { type: 'q:void' }, ctx);
    expect(s.question?.questionsDone).toBe(2);
    expectError(s, { type: 'q:void' });
  });

  it('voiding the sixth question ends the round', () => {
    let s = run(newGame('pink'), [{ type: 'round:start', round: 'connections' }]);
    for (const g of ['twoReeds', 'lion', 'twistedFlax', 'hornedViper', 'water'] as const) s = run(s, [{ type: 'q:select', hieroglyph: g }, { type: 'q:correct' }, { type: 'q:next' }]);
    s = run(s, [{ type: 'q:select', hieroglyph: 'eyeOfHorus' }, { type: 'q:void' }]);
    expect(s.question?.questionsDone).toBe(6);
    expect(s.finishedRounds).toContain('connections');
  });
});

describe('wall:abort', () => {
  it('takes an unfinished wall off screen with nothing awarded; the team can play again', () => {
    let s = liveWall('pink');
    s = selectGroup(s, 0);
    expect(allowedActions(s)).toContain('wall:abort');
    s = applyAction(s, { type: 'wall:abort' }, ctx);
    expect(s.wall?.current).toBeNull();
    expect(s.wall?.completed).toEqual([]);
    expect(s.teams.pink.score).toBe(0);
    s = applyAction(s, { type: 'wall:show', team: 'pink' }, makeCtx({ seed: 7 }));
    expect(s.wall?.current?.stage).toBe('ready');
    // ready / frozen / resolving can be aborted too, done cannot.
    s = applyAction(s, { type: 'wall:abort' }, ctx);
    s = run(s, [{ type: 'wall:show', team: 'blue' }, { type: 'wall:start' }, { type: 'wall:timeUp' }]);
    expect(allowedActions(s)).toContain('wall:abort');
    s = run(s, [{ type: 'wall:resolve' }]);
    expect(allowedActions(s)).toContain('wall:abort');
    s = run(s, [{ type: 'wall:connectionCorrect' }, { type: 'wall:connectionCorrect' }, { type: 'wall:connectionCorrect' }, { type: 'wall:connectionCorrect' }, { type: 'wall:finish' }]);
    expectError(s, { type: 'wall:abort' });
    expect(allowedActions(s)).not.toContain('wall:abort');
  });
});

describe('audio clues on judgement', () => {
  function hornedViper(): GameState {
    // Demo pack: the Horned Viper connections question has four audio clues.
    return run(newGame('pink'), [{ type: 'round:start', round: 'connections' }, { type: 'q:select', hieroglyph: 'hornedViper' }, { type: 'q:reveal' }]);
  }

  it('incorrect reveals the remaining clues and queues the first newly revealed audio clue', () => {
    let s = hornedViper();
    expect(s.playMedia?.key).toBe('demo/bumblebee.wav');
    s = applyAction(s, { type: 'q:incorrect' }, ctx);
    expect(s.playMedia?.key).toBe('demo/valkyries.wav');
    expect(s.playMedia?.nonce).toBe(s.version);
  });

  it('correct does the same', () => {
    const s = applyAction(hornedViper(), { type: 'q:correct' }, ctx);
    expect(s.playMedia?.key).toBe('demo/valkyries.wav');
  });

  it('media:play can target any visible audio clue, not just the last one', () => {
    let s = applyAction(hornedViper(), { type: 'q:incorrect' }, ctx);
    s = applyAction(s, { type: 'media:play', clueIndex: 0 }, ctx);
    expect(s.playMedia?.key).toBe('demo/william-tell.wav');
    s = applyAction(s, { type: 'media:play' }, ctx);
    expect(s.playMedia?.key).toBe('demo/habanera.wav');
    expectError(s, { type: 'media:play', clueIndex: 9 });
    // A sequences question's hidden 4th audio clue is not playable before the answer.
    let t = run(newGame('pink'), [{ type: 'round:start', round: 'sequences' }, { type: 'q:select', hieroglyph: 'eyeOfHorus' }, { type: 'q:reveal' }, { type: 'q:reveal' }]);
    expectError(t, { type: 'media:play', clueIndex: 3 });
    t = applyAction(t, { type: 'q:incorrect' }, ctx);
    expectError(t, { type: 'media:play', clueIndex: 3 });
    expect(t.playMedia?.key).toBe('demo/solfege-mi.wav'); // nothing newly revealed: last reveal's audio stays
  });
});

describe('validatePack', () => {
  it('explains a display that cannot be generated', () => {
    const pack = demoPack();
    pack.vowelGroups[0].clues[0] = { answer: 'A', display: '' };
    expect(validatePack(pack).join('\n')).toContain('no consonants');
  });
});
