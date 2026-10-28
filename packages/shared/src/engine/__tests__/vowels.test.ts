import { describe, expect, it } from 'vitest';
import type { GameState } from '../../types.js';
import { allowedActions, applyAction } from '../game.js';
import { expectError, makeCtx, newGame, run, withPlayers, NOW } from './fixtures.js';

const ctx = makeCtx();

function v(state: GameState) {
  if (!state.vowels) throw new Error('no vowels round');
  return state.vowels;
}

function startVowels(): GameState {
  return run(withPlayers(newGame()), [{ type: 'round:start', round: 'vowels' }]);
}

describe('Missing Vowels', () => {
  it('opens on the category bar with buzzers closed', () => {
    const s = startVowels();
    expect(s.phase).toBe('vowels');
    expect(v(s)).toEqual({ order: ['pink', 'blue'], stage: 'category', groupIndex: 0, clueIndex: 0, buzz: null, result: null, lockedPlayers: [] });
    expectError(s, { type: 'player:buzz', playerId: 'p-ann' }, 'buzz_closed');
    expect(allowedActions(s)).toContain('vowels:showClue');
    expect(allowedActions(s)).toContain('vowels:skipCategory');
    expectError(s, { type: 'vowels:correct' });
    expectError(s, { type: 'vowels:next' });
  });

  it('first buzz wins and locks the buzzer; a correct answer scores +1', () => {
    let s = run(startVowels(), [{ type: 'vowels:showClue' }]);
    expect(v(s).stage).toBe('clue');
    s = applyAction(s, { type: 'player:buzz', playerId: 'p-ann' }, makeCtx({ now: NOW + 1234 }));
    expect(v(s)).toMatchObject({ stage: 'buzzed', buzz: { playerId: 'p-ann', playerName: 'Ann', team: 'pink', at: NOW + 1234 } });
    expectError(s, { type: 'player:buzz', playerId: 'p-bob' }, 'buzz_lost');
    expectError(s, { type: 'player:buzz', playerId: 'p-ann' }, 'buzz_lost');
    expect(allowedActions(s)).toEqual(expect.arrayContaining(['vowels:correct', 'vowels:incorrect', 'vowels:reopen']));
    expect(allowedActions(s)).not.toContain('vowels:skipCategory');

    s = applyAction(s, { type: 'vowels:correct' }, ctx);
    expect(v(s)).toMatchObject({ stage: 'answer', result: { team: 'pink', delta: { pink: 1, blue: 0 } } });
    expect(s.teams.pink.score).toBe(1);
    expectError(s, { type: 'player:buzz', playerId: 'p-bob' }, 'buzz_lost');
    expect(allowedActions(s)).toContain('vowels:next');
  });

  it('incorrect costs 1, then the other team may answer for +1', () => {
    let s = run(startVowels(), [{ type: 'vowels:showClue' }, { type: 'player:buzz', playerId: 'p-bob' }, { type: 'vowels:incorrect' }]);
    expect(v(s)).toMatchObject({ stage: 'other', result: { team: null, delta: { pink: 0, blue: -1 } } });
    expect(s.teams.blue.score).toBe(-1);
    expectError(s, { type: 'player:buzz', playerId: 'p-ann' }, 'buzz_lost');
    expect(allowedActions(s)).toEqual(expect.arrayContaining(['vowels:otherCorrect', 'vowels:nobody']));
    expectError(s, { type: 'vowels:correct' });

    const other = applyAction(s, { type: 'vowels:otherCorrect' }, ctx);
    expect(v(other)).toMatchObject({ stage: 'answer', result: { team: 'pink', delta: { pink: 1, blue: -1 } } });
    expect(other.teams.pink.score).toBe(1);
    expect(other.teams.blue.score).toBe(-1);

    const nobody = applyAction(s, { type: 'vowels:nobody' }, ctx);
    expect(v(nobody)).toMatchObject({ stage: 'answer', result: { team: null, delta: { pink: 0, blue: -1 } } });
    expect(nobody.teams.pink.score).toBe(0);
  });

  it('nobody can be used when no one buzzes at all', () => {
    const s = run(startVowels(), [{ type: 'vowels:showClue' }, { type: 'vowels:nobody' }]);
    expect(v(s)).toMatchObject({ stage: 'answer', result: { team: null, delta: { pink: 0, blue: 0 } } });
  });

  it('reopen locks out the player who buzzed and reopens buzzers for everyone else', () => {
    let s = run(startVowels(), [{ type: 'vowels:showClue' }, { type: 'player:buzz', playerId: 'p-ann' }, { type: 'vowels:reopen' }]);
    expect(v(s)).toMatchObject({ stage: 'clue', buzz: null, lockedPlayers: ['p-ann'] });
    expectError(s, { type: 'player:buzz', playerId: 'p-ann' }, 'buzz_locked');
    s = applyAction(s, { type: 'player:buzz', playerId: 'p-cat' }, ctx);
    expect(v(s).buzz?.playerName).toBe('Cat');
    s = run(s, [{ type: 'vowels:reopen' }]);
    expect(v(s).lockedPlayers).toEqual(['p-ann', 'p-cat']);
    s = applyAction(s, { type: 'player:buzz', playerId: 'p-bob' }, ctx);
    s = run(s, [{ type: 'vowels:correct' }, { type: 'vowels:next' }]);
    expect(v(s).lockedPlayers).toEqual([]); // locks are per clue
  });

  it('rejects buzzes from unknown players and outside the round', () => {
    expectError(newGame(), { type: 'player:buzz', playerId: 'p-ann' }, 'buzz_closed');
    const s = run(startVowels(), [{ type: 'vowels:showClue' }]);
    expectError(s, { type: 'player:buzz', playerId: 'ghost' }, 'unknown_player');
  });

  it('progresses clue by clue, then category by category, and ends with round:final', () => {
    let s = startVowels();
    const groups = s.pack.vowelGroups;
    expect(groups.length).toBeGreaterThanOrEqual(2);
    const answerAll = (state: GameState) => run(state, [{ type: 'player:buzz', playerId: 'p-ann' }, { type: 'vowels:correct' }]);

    s = run(s, [{ type: 'vowels:showClue' }]);
    for (let i = 0; i < groups[0].clues.length; i++) {
      expect(v(s)).toMatchObject({ stage: 'clue', groupIndex: 0, clueIndex: i });
      s = answerAll(s);
      s = applyAction(s, { type: 'vowels:next' }, ctx);
    }
    // Next category: category bar first, clue only after showClue.
    expect(v(s)).toMatchObject({ stage: 'category', groupIndex: 1, clueIndex: 0 });
    expectError(s, { type: 'player:buzz', playerId: 'p-ann' }, 'buzz_closed');

    // Skip straight to the last category.
    while (v(s).groupIndex < groups.length - 1) s = applyAction(s, { type: 'vowels:skipCategory' }, ctx);
    expectError(s, { type: 'vowels:skipCategory' });
    expect(allowedActions(s)).not.toContain('vowels:skipCategory');
    const last = groups[groups.length - 1];
    s = applyAction(s, { type: 'vowels:showClue' }, ctx);
    for (let i = 0; i < last.clues.length - 1; i++) {
      s = answerAll(s);
      s = applyAction(s, { type: 'vowels:next' }, ctx);
    }
    expect(v(s)).toMatchObject({ stage: 'clue', groupIndex: groups.length - 1, clueIndex: last.clues.length - 1 });
    expect(s.finishedRounds).toEqual([]);
    s = answerAll(s);
    expect(v(s).stage).toBe('answer');
    expect(s.finishedRounds).toEqual(['vowels']);
    expectError(s, { type: 'vowels:next' });
    const allowed = allowedActions(s);
    expect(allowed).not.toContain('vowels:next');
    expect(allowed).toContain('round:final');
    expect(s.teams.pink.score).toBe(groups[0].clues.length + last.clues.length);

    s = applyAction(s, { type: 'round:final' }, ctx);
    expect(s.phase).toBe('final');
    expect(s.vowels).toBeNull();
    expectError(s, { type: 'round:final' });
    expectError(s, { type: 'round:start', round: 'vowels' });
  });

  it('round:final is available from vowels at any time, but not while a buzz is being judged', () => {
    let s = run(startVowels(), [{ type: 'vowels:showClue' }]);
    expect(allowedActions(s)).toContain('round:final');
    s = applyAction(s, { type: 'player:buzz', playerId: 'p-ann' }, ctx);
    expect(allowedActions(s)).not.toContain('round:final');
    expectError(s, { type: 'round:final' });
  });
});
