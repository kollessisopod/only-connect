import { describe, expect, it } from 'vitest';
import { QUESTION_SECONDS, type GameState } from '../../types.js';
import { allowedActions, applyAction } from '../game.js';
import { projectPublic } from '../project.js';
import { QUESTION_MS, questionClockRunning, questionSecondsRemaining } from '../questions.js';
import { expectError, makeCtx, newGame, run, NOW } from './fixtures.js';

const ctx = makeCtx();

function q(state: GameState) {
  if (!state.question) throw new Error('no question round');
  return state.question;
}

describe('Connections round', () => {
  it('plays a full round: alternation, 5/3/2/1 scoring, steals, round end', () => {
    let s = run(newGame('pink'), [{ type: 'round:start', round: 'connections' }]);
    expect(s.phase).toBe('connections');
    expect(q(s)).toMatchObject({ stage: 'selecting', team: 'pink', used: [], questionsDone: 0, questionId: null });

    // Q1 — pink, correct after 2 clues: 3 points.
    s = applyAction(s, { type: 'q:select', hieroglyph: 'twoReeds' }, ctx);
    expect(q(s)).toMatchObject({ stage: 'question', team: 'pink', revealed: 1, pointsOnOffer: 5, used: ['twoReeds'] });
    expect(q(s).questionId).not.toBeNull();
    s = applyAction(s, { type: 'q:reveal' }, ctx);
    expect(q(s)).toMatchObject({ revealed: 2, pointsOnOffer: 3 });
    s = applyAction(s, { type: 'q:correct' }, ctx);
    expect(q(s)).toMatchObject({ stage: 'answer', revealed: 4, result: { winner: 'pink', points: 3, viaSteal: false } });
    expect(s.teams.pink.score).toBe(3);
    s = applyAction(s, { type: 'q:next' }, ctx);
    expect(q(s)).toMatchObject({ stage: 'selecting', team: 'blue', questionsDone: 1, questionId: null, revealed: 0, result: null });

    // Q2 — blue, correct after all 4 clues: 1 point.
    s = run(s, [{ type: 'q:select', hieroglyph: 'lion' }, { type: 'q:reveal' }, { type: 'q:reveal' }, { type: 'q:reveal' }]);
    expect(q(s)).toMatchObject({ revealed: 4, pointsOnOffer: 1 });
    expectError(s, { type: 'q:reveal' });
    s = run(s, [{ type: 'q:correct' }, { type: 'q:next' }]);
    expect(s.teams.blue.score).toBe(1);
    expect(q(s).team).toBe('pink');

    // Q3 — pink wrong after 1 clue, blue steals for 1.
    s = run(s, [{ type: 'q:select', hieroglyph: 'twistedFlax' }, { type: 'q:incorrect' }]);
    expect(q(s)).toMatchObject({ stage: 'steal', revealed: 4, pointsOnOffer: 1 });
    s = applyAction(s, { type: 'q:stealCorrect' }, ctx);
    expect(q(s)).toMatchObject({ stage: 'answer', result: { winner: 'blue', points: 1, viaSteal: true } });
    expect(s.teams.blue.score).toBe(2);
    expect(s.teams.pink.score).toBe(3);
    s = applyAction(s, { type: 'q:next' }, ctx);

    // Q4 — blue wrong, pink fails the steal.
    s = run(s, [{ type: 'q:select', hieroglyph: 'hornedViper' }, { type: 'q:reveal' }, { type: 'q:incorrect' }, { type: 'q:stealIncorrect' }]);
    expect(q(s)).toMatchObject({ stage: 'answer', result: { winner: null, points: 0, viaSteal: true } });
    expect(s.teams.pink.score).toBe(3);
    expect(s.teams.blue.score).toBe(2);
    s = applyAction(s, { type: 'q:next' }, ctx);

    // Q5 — pink correct after 3 clues: 2 points.
    s = run(s, [{ type: 'q:select', hieroglyph: 'water' }, { type: 'q:reveal' }, { type: 'q:reveal' }]);
    expect(q(s).pointsOnOffer).toBe(2);
    s = run(s, [{ type: 'q:correct' }, { type: 'q:next' }]);
    expect(s.teams.pink.score).toBe(5);

    // Q6 — blue correct on the first clue: 5 points.
    s = run(s, [{ type: 'q:select', hieroglyph: 'eyeOfHorus' }, { type: 'q:correct' }]);
    expect(s.teams.blue.score).toBe(7);
    expect(q(s).used).toEqual(['twoReeds', 'lion', 'twistedFlax', 'hornedViper', 'water', 'eyeOfHorus']);

    // Round end: stays on the answer with questionsDone = 6, only round:start / game:lobby for flow.
    s = applyAction(s, { type: 'q:next' }, ctx);
    expect(q(s)).toMatchObject({ stage: 'answer', questionsDone: 6 });
    expect(s.finishedRounds).toEqual(['connections']);
    const allowed = allowedActions(s);
    expect(allowed).toContain('round:start');
    expect(allowed).toContain('game:lobby');
    expect(allowed).toContain('round:final');
    expect(allowed.filter((a) => a.startsWith('q:'))).toEqual([]);
    expectError(s, { type: 'q:next' });
    expectError(s, { type: 'round:start', round: 'connections' });
    expect(s.version).toBe(28); // one bump per applied action
  });

  it('starts with the chosen first team and strictly alternates', () => {
    let s = run(newGame('blue'), [{ type: 'round:start', round: 'connections' }]);
    expect(q(s).team).toBe('blue');
    const order: string[] = [];
    const glyphs = ['twoReeds', 'lion', 'twistedFlax', 'hornedViper', 'water', 'eyeOfHorus'] as const;
    for (const g of glyphs) {
      order.push(q(s).team);
      s = run(s, [{ type: 'q:select', hieroglyph: g }, { type: 'q:correct' }, { type: 'q:next' }]);
    }
    expect(order).toEqual(['blue', 'pink', 'blue', 'pink', 'blue', 'pink']);
  });

  it('rejects an already used hieroglyph and out-of-stage actions', () => {
    let s = run(newGame(), [{ type: 'round:start', round: 'connections' }]);
    expectError(s, { type: 'q:reveal' });
    expectError(s, { type: 'q:correct' });
    expectError(s, { type: 'q:next' });
    s = run(s, [{ type: 'q:select', hieroglyph: 'lion' }, { type: 'q:correct' }, { type: 'q:next' }]);
    expectError(s, { type: 'q:select', hieroglyph: 'lion' });
    expectError(s, { type: 'q:stealCorrect' });
    s = applyAction(s, { type: 'q:select', hieroglyph: 'water' }, ctx);
    expectError(s, { type: 'q:select', hieroglyph: 'twoReeds' });
    expectError(s, { type: 'q:stealIncorrect' });
    expectError(s, { type: 'q:next' });
  });

  it('cannot be abandoned mid-question but can be left between questions', () => {
    let s = run(newGame(), [{ type: 'round:start', round: 'connections' }, { type: 'q:select', hieroglyph: 'lion' }]);
    expectError(s, { type: 'round:start', round: 'sequences' });
    expectError(s, { type: 'round:start', round: 'wall' });
    expectError(s, { type: 'game:lobby' }); // SPEC §3.6: the lobby is a between-questions move, the clock is running
    expectError(s, { type: 'round:final' });
    expect(allowedActions(s)).not.toContain('round:start');
    expect(allowedActions(s)).not.toContain('game:lobby');
    s = run(s, [{ type: 'q:incorrect' }]);
    expectError(s, { type: 'round:start', round: 'sequences' });
    expectError(s, { type: 'game:lobby' }); // the steal is unclocked but still mid-question
    expect(allowedActions(s)).not.toContain('game:lobby');
    s = run(s, [{ type: 'q:stealIncorrect' }]);
    expect(allowedActions(s)).toContain('round:start');
    expect(allowedActions(s)).toContain('game:lobby');
    s = applyAction(s, { type: 'round:start', round: 'sequences' }, ctx);
    expect(s.phase).toBe('sequences');
    expect(s.finishedRounds).toEqual([]);
  });

  it('triggers playMedia for audio clues on select/reveal and supports media:play/stop', () => {
    let s = run(newGame(), [{ type: 'round:start', round: 'connections' }]);
    expect(allowedActions(s)).not.toContain('media:play');
    s = applyAction(s, { type: 'q:select', hieroglyph: 'hornedViper' }, ctx);
    expect(s.playMedia).toEqual({ key: 'demo/william-tell.wav', nonce: s.version });
    expect(allowedActions(s)).toContain('media:play');
    expect(allowedActions(s)).toContain('media:stop');
    const firstNonce = s.playMedia?.nonce ?? -1;
    s = applyAction(s, { type: 'media:play' }, ctx);
    expect(s.playMedia?.key).toBe('demo/william-tell.wav');
    expect(s.playMedia?.nonce).toBeGreaterThan(firstNonce);
    s = applyAction(s, { type: 'q:reveal' }, ctx);
    expect(s.playMedia?.key).toBe('demo/bumblebee.wav');
    s = applyAction(s, { type: 'media:stop' }, ctx);
    expect(s.playMedia).toBeNull();
    expectError(s, { type: 'media:stop' });
    // media:play replays the most recently revealed audio clue.
    s = applyAction(s, { type: 'media:play' }, ctx);
    expect(s.playMedia?.key).toBe('demo/bumblebee.wav');
    s = run(s, [{ type: 'q:correct' }, { type: 'q:next' }]);
    expect(s.playMedia).toBeNull();
    // Text questions never offer media:play.
    s = applyAction(s, { type: 'q:select', hieroglyph: 'lion' }, ctx);
    expect(s.playMedia).toBeNull();
    expectError(s, { type: 'media:play' });
  });
});

describe('Sequences round', () => {
  it('starts with the other team and allows at most 3 reveals', () => {
    let s = run(newGame('pink'), [{ type: 'round:start', round: 'sequences' }]);
    expect(q(s)).toMatchObject({ round: 'sequences', team: 'blue', stage: 'selecting' });
    s = run(s, [{ type: 'q:select', hieroglyph: 'twoReeds' }, { type: 'q:reveal' }, { type: 'q:reveal' }]);
    expect(q(s)).toMatchObject({ revealed: 3, pointsOnOffer: 2 });
    expectError(s, { type: 'q:reveal' });
    expect(allowedActions(s)).not.toContain('q:reveal');
    expect(allowedActions(s)).toEqual(expect.arrayContaining(['q:correct', 'q:incorrect']));
    s = applyAction(s, { type: 'q:correct' }, ctx);
    expect(s.teams.blue.score).toBe(2);
    expect(q(s).revealed).toBe(4);
  });

  it('keeps the 4th clue hidden as "?" until the answer stage in the public projection', () => {
    let s = run(newGame('pink'), [
      { type: 'round:start', round: 'sequences' },
      { type: 'q:select', hieroglyph: 'hornedViper' },
      { type: 'q:reveal' },
      { type: 'q:reveal' },
    ]);
    let pub = projectPublic(s, NOW).question;
    expect(pub?.clues.map((c) => c.revealed)).toEqual([true, true, true, false]);
    expect(pub?.clues[3].text).toBeNull();
    expect(JSON.stringify(pub)).not.toContain('Theresa May');

    // Even in the steal stage (state.revealed = 4) the 4th clue is still hidden.
    s = applyAction(s, { type: 'q:incorrect' }, ctx);
    expect(q(s).revealed).toBe(4);
    pub = projectPublic(s, NOW).question;
    expect(pub?.clues[3]).toEqual({ kind: 'text', text: null, mediaUrl: null, revealed: false });
    expect(pub?.answer).toBeNull();
    expect(JSON.stringify(pub)).not.toContain('Theresa May');

    s = applyAction(s, { type: 'q:stealCorrect' }, ctx);
    pub = projectPublic(s, NOW).question;
    expect(pub?.clues[3]).toEqual({ kind: 'text', text: 'Theresa May', mediaUrl: null, revealed: true });
    expect(pub?.answer).toBe('Theresa May (UK prime ministers in order)');
    expect(s.teams.pink.score).toBe(1);
  });

  it('cannot be restarted once finished, and connections cannot be restarted after sequences began', () => {
    let s = run(newGame('pink'), [{ type: 'round:start', round: 'connections' }]);
    const glyphs = ['twoReeds', 'lion', 'twistedFlax', 'hornedViper', 'water', 'eyeOfHorus'] as const;
    for (const g of glyphs) s = run(s, [{ type: 'q:select', hieroglyph: g }, { type: 'q:correct' }, { type: 'q:next' }]);
    s = applyAction(s, { type: 'round:start', round: 'sequences' }, ctx);
    expectError(s, { type: 'round:start', round: 'connections' });
    for (const g of glyphs) s = run(s, [{ type: 'q:select', hieroglyph: g }, { type: 'q:correct' }, { type: 'q:next' }]);
    expect(s.finishedRounds).toEqual(['connections', 'sequences']);
    expectError(s, { type: 'round:start', round: 'sequences' });
    expect(allowedActions(s)).toContain('round:start'); // wall / vowels are still available
    s = applyAction(s, { type: 'round:start', round: 'wall' }, ctx);
    expect(s.phase).toBe('wall');
    expect(s.question).toBeNull();
  });
});

describe('the 40 second question clock (V3)', () => {
  const picked = () => run(newGame('pink'), [{ type: 'round:start', round: 'connections' }, { type: 'q:select', hieroglyph: 'lion' }]);

  it('starts on q:select and is cleared by every judgement', () => {
    let s = run(newGame('pink'), [{ type: 'round:start', round: 'connections' }]);
    expect(q(s)).toMatchObject({ startedAt: null, endsAt: null, timeUp: false });
    expect(questionClockRunning(q(s))).toBe(false);
    s = applyAction(s, { type: 'q:select', hieroglyph: 'lion' }, makeCtx({ now: NOW + 1234 }));
    expect(QUESTION_SECONDS).toBe(40);
    expect(QUESTION_MS).toBe(40_000);
    expect(q(s)).toMatchObject({ stage: 'question', startedAt: NOW + 1234, endsAt: NOW + 1234 + 40_000, timeUp: false });
    expect(questionClockRunning(q(s))).toBe(true);
    expect(questionSecondsRemaining(q(s), NOW + 1234)).toBe(40);
    expect(questionSecondsRemaining(q(s), NOW + 1234 + 500)).toBe(40);
    expect(questionSecondsRemaining(q(s), NOW + 1234 + 1000)).toBe(39);
    expect(questionSecondsRemaining(q(s), NOW + 1234 + 39_500)).toBe(1);
    expect(questionSecondsRemaining(q(s), NOW + 1234 + 40_000)).toBe(0);
    expect(questionSecondsRemaining(q(s), NOW + 999_999)).toBe(0);
    // Revealing clues does not touch the clock.
    s = run(s, [{ type: 'q:reveal' }]);
    expect(q(s)).toMatchObject({ startedAt: NOW + 1234, endsAt: NOW + 1234 + 40_000, timeUp: false });

    const correct = applyAction(s, { type: 'q:correct' }, ctx);
    expect(q(correct)).toMatchObject({ stage: 'answer', startedAt: null, endsAt: null, timeUp: false });
    expect(questionClockRunning(q(correct))).toBe(false);
    expect(questionSecondsRemaining(q(correct), NOW)).toBe(0);
    const incorrect = applyAction(s, { type: 'q:incorrect' }, ctx);
    expect(q(incorrect)).toMatchObject({ stage: 'steal', startedAt: null, endsAt: null, timeUp: false }); // the steal has no clock
    expect(q(applyAction(incorrect, { type: 'q:stealCorrect' }, ctx))).toMatchObject({ stage: 'answer', startedAt: null, endsAt: null, timeUp: false });
    expect(q(applyAction(incorrect, { type: 'q:stealIncorrect' }, ctx))).toMatchObject({ stage: 'answer', startedAt: null, endsAt: null, timeUp: false });
    const voided = applyAction(s, { type: 'q:void' }, ctx);
    expect(q(voided)).toMatchObject({ stage: 'selecting', startedAt: null, endsAt: null, timeUp: false });
    const next = applyAction(correct, { type: 'q:next' }, ctx);
    expect(q(next)).toMatchObject({ stage: 'selecting', startedAt: null, endsAt: null, timeUp: false });
    // The fields are present (JSON keeps them) so clients never see `undefined`.
    for (const state of [s, correct, incorrect, voided, next]) {
      expect(Object.keys(state.question ?? {})).toEqual(expect.arrayContaining(['startedAt', 'endsAt', 'timeUp']));
    }
  });

  it('q:timeUp blocks further reveals but still lets the host judge', () => {
    let s = picked();
    expect(allowedActions(s)).toEqual(expect.arrayContaining(['q:reveal', 'q:timeUp', 'q:correct', 'q:incorrect', 'q:void']));
    s = applyAction(s, { type: 'q:timeUp' }, makeCtx({ now: NOW + 40_000 }));
    expect(q(s)).toMatchObject({ stage: 'question', revealed: 1, pointsOnOffer: 5, startedAt: NOW, endsAt: NOW + 40_000, timeUp: true });
    expect(questionClockRunning(q(s))).toBe(false);
    expect(questionSecondsRemaining(q(s), NOW)).toBe(0);
    expectError(s, { type: 'q:reveal' }, 'question_time_up');
    const allowed = allowedActions(s);
    expect(allowed).not.toContain('q:reveal');
    expect(allowed).not.toContain('q:timeUp');
    expect(allowed).toEqual(expect.arrayContaining(['q:correct', 'q:incorrect', 'q:void']));
    // Pressed again (a late server timer after the host's early press): a no-op, not an error.
    expect(applyAction(s, { type: 'q:timeUp' }, ctx).question).toEqual(q(s));
    // The team answers on what it has: the points on offer stay as they were.
    const correct = applyAction(s, { type: 'q:correct' }, ctx);
    expect(correct.teams.pink.score).toBe(5);
    expect(q(correct)).toMatchObject({ stage: 'answer', timeUp: false, startedAt: null, endsAt: null });
    const incorrect = applyAction(s, { type: 'q:incorrect' }, ctx);
    expect(q(incorrect)).toMatchObject({ stage: 'steal', pointsOnOffer: 1, timeUp: false });
    expect(q(applyAction(s, { type: 'q:void' }, ctx))).toMatchObject({ stage: 'selecting', timeUp: false });
  });

  it('the host may call time early, and time cannot be called outside the question stage', () => {
    let s = applyAction(picked(), { type: 'q:timeUp' }, makeCtx({ now: NOW + 5_000 }));
    expect(q(s)).toMatchObject({ timeUp: true, endsAt: NOW + 40_000 }); // the deadline is kept for the bars
    expectError(run(newGame(), [{ type: 'round:start', round: 'connections' }]), { type: 'q:timeUp' });
    s = applyAction(picked(), { type: 'q:incorrect' }, ctx);
    expectError(s, { type: 'q:timeUp' });
    s = applyAction(s, { type: 'q:stealIncorrect' }, ctx);
    expectError(s, { type: 'q:timeUp' });
    expectError(newGame(), { type: 'q:timeUp' });
    expect(allowedActions(s)).not.toContain('q:timeUp');
  });

  it('reads a pre-V3 question state (no clock fields) as having no clock', () => {
    const s = picked();
    const { startedAt, endsAt, timeUp, ...bare } = q(s);
    void startedAt;
    void endsAt;
    void timeUp;
    const legacy: GameState = { ...s, question: bare as GameState['question'] };
    expect(questionClockRunning(bare)).toBe(false);
    expect(questionSecondsRemaining(bare, NOW)).toBe(0);
    expect(allowedActions(legacy)).toEqual(expect.arrayContaining(['q:reveal', 'q:timeUp']));
    expect(q(applyAction(legacy, { type: 'q:reveal' }, ctx)).revealed).toBe(2);
    expect(q(applyAction(legacy, { type: 'q:timeUp' }, ctx))).toMatchObject({ startedAt: null, endsAt: null, timeUp: true });
    expect(projectPublic(legacy, NOW).question).toMatchObject({ startedAt: null, endsAt: null, timeUp: false });
  });

  it('a question with a running clock cannot be parked in the lobby, so a resumed question is never already timed out', () => {
    let s = picked();
    expect(questionClockRunning(q(s))).toBe(true);
    expectError(s, { type: 'game:lobby' });
    // Voiding is the escape: then the lobby and a later resume come back at the selecting stage, no clock.
    s = run(s, [{ type: 'q:void' }, { type: 'game:lobby' }]);
    expect(s.suspended?.connections).toMatchObject({ stage: 'selecting', startedAt: null, endsAt: null, timeUp: false });
    s = applyAction(s, { type: 'round:start', round: 'connections' }, makeCtx({ now: NOW + 60_000 }));
    expect(q(s)).toMatchObject({ stage: 'selecting', timeUp: false });
    expect(questionClockRunning(q(s))).toBe(false);
  });

  it('suspending and resuming a round between questions never carries a clock', () => {
    let s = run(picked(), [{ type: 'q:correct' }, { type: 'q:next' }, { type: 'game:lobby' }, { type: 'round:start', round: 'connections' }]);
    expect(q(s)).toMatchObject({ stage: 'selecting', startedAt: null, endsAt: null, timeUp: false });
    s = applyAction(s, { type: 'q:select', hieroglyph: 'water' }, makeCtx({ now: NOW + 99 }));
    expect(q(s)).toMatchObject({ startedAt: NOW + 99, endsAt: NOW + 99 + QUESTION_MS });
  });
});
