/**
 * Round 1 (Connections) and Round 2 (Sequences) reducers. SPEC §3.1, §3.2, §10.
 */
import {
  CLUE_POINTS,
  HIEROGLYPHS,
  HIEROGLYPH_LABELS,
  MAX_CLUES_CONNECTIONS,
  MAX_CLUES_SEQUENCES,
  STEAL_POINTS,
  otherTeam,
  type Clue,
  type GameState,
  type Hieroglyph,
  type Pack,
  type Question,
  type QuestionRound,
  type QuestionRoundState,
  type TeamId,
} from '../types.js';
import { addScore, fail, markRoundFinished, withPlayMedia } from './common.js';

export function maxCluesFor(round: QuestionRound): number {
  return round === 'connections' ? MAX_CLUES_CONNECTIONS : MAX_CLUES_SEQUENCES;
}

/** Team that picks the first question of a round: `firstTeam` for Connections, the other for Sequences. */
export function roundOpener(state: GameState, round: QuestionRound): TeamId {
  return round === 'connections' ? state.firstTeam : otherTeam(state.firstTeam);
}

/** The pack's questions for a round. */
export function roundQuestions(pack: Pack, round: QuestionRound): Question[] {
  return pack.questions.filter((q) => q.round === round);
}

/** The hieroglyphs of a round's questions (the grid), in HIEROGLYPHS order. */
export function roundHieroglyphs(pack: Pack, round: QuestionRound): Hieroglyph[] {
  const tagged = new Set(roundQuestions(pack, round).map((q) => q.hieroglyph));
  return HIEROGLYPHS.filter((h) => tagged.has(h));
}

export function findQuestion(state: GameState, id: string | null): Question | null {
  if (id === null) return null;
  return state.pack.questions.find((q) => q.id === id) ?? null;
}

export function questionByHieroglyph(state: GameState, round: QuestionRound, hieroglyph: Hieroglyph): Question | null {
  return state.pack.questions.find((q) => q.round === round && q.hieroglyph === hieroglyph) ?? null;
}

/** Whether clue `index` (0..3) of the current question is visible to the audience. */
export function isClueVisible(qs: QuestionRoundState, index: number): boolean {
  if (qs.questionId === null) return false;
  if (index >= qs.revealed) return false;
  // The hidden 4th sequences clue stays a "?" until the answer is revealed.
  if (qs.round === 'sequences' && index === 3 && qs.stage !== 'answer') return false;
  return true;
}

/** The most recently revealed audio clue of the current question (for media:play), or null. */
export function currentAudioClue(state: GameState): Clue | null {
  const visible = visibleAudioClues(state);
  return visible.length > 0 ? visible[visible.length - 1].clue : null;
}

/** Every audio clue of the current question that the audience can see, with its index (for per-clue replay). */
export function visibleAudioClues(state: GameState): Array<{ index: number; clue: Clue }> {
  const qs = state.question;
  if (!qs || (state.phase !== 'connections' && state.phase !== 'sequences')) return [];
  const q = findQuestion(state, qs.questionId);
  if (!q) return [];
  const out: Array<{ index: number; clue: Clue }> = [];
  q.clues.forEach((clue, i) => {
    if (clue.kind === 'audio' && clue.media && isClueVisible(qs, i)) out.push({ index: i, clue });
  });
  return out;
}

/**
 * A judgement reveals every remaining clue at once; the first audio clue among the newly revealed ones is
 * queued on the monitor (SPEC §4: audio plays when it is revealed), the others can be replayed per clue.
 */
function playNewlyRevealedAudio(before: GameState, after: GameState): GameState {
  const was = before.question;
  const now = after.question;
  if (!was || !now) return after;
  const q = findQuestion(after, now.questionId);
  if (!q) return after;
  for (let i = 0; i < q.clues.length; i++) {
    const clue = q.clues[i];
    if (clue.kind === 'audio' && clue.media && !isClueVisible(was, i) && isClueVisible(now, i)) {
      return withPlayMedia(after, clue.media.key);
    }
  }
  return after;
}

function requireQuestionState(state: GameState): QuestionRoundState {
  if ((state.phase !== 'connections' && state.phase !== 'sequences') || !state.question) {
    return fail('no question round is in progress');
  }
  return state.question;
}

function setQuestion(state: GameState, qs: QuestionRoundState): GameState {
  return { ...state, question: qs };
}

/**
 * A round has exactly as many questions as the pack holds for it (1..MAX_QUESTIONS_PER_ROUND, one hieroglyph
 * each); the grid shows only those hieroglyphs.
 */
export function startQuestionRound(state: GameState, round: QuestionRound): GameState {
  const available = roundHieroglyphs(state.pack, round);
  const qs: QuestionRoundState = {
    round,
    stage: 'selecting',
    team: roundOpener(state, round),
    available,
    used: [],
    questionId: null,
    revealed: 0,
    pointsOnOffer: 0,
    result: null,
    questionsDone: 0,
    questionsTotal: available.length,
  };
  return withPlayMedia({ ...state, phase: round, question: qs, wall: null, vowels: null }, null);
}

export function selectHieroglyph(state: GameState, hieroglyph: Hieroglyph): GameState {
  const qs = requireQuestionState(state);
  if (qs.stage !== 'selecting') return fail('not selecting a question');
  if (!HIEROGLYPHS.includes(hieroglyph)) return fail(`unknown hieroglyph "${String(hieroglyph)}"`);
  if (qs.used.includes(hieroglyph)) return fail(`${HIEROGLYPH_LABELS[hieroglyph]} has already been played`);
  if (!qs.available.includes(hieroglyph)) return fail(`${HIEROGLYPH_LABELS[hieroglyph]} is not in this round`);
  const q = questionByHieroglyph(state, qs.round, hieroglyph);
  if (!q) return fail(`no ${qs.round} question for ${HIEROGLYPH_LABELS[hieroglyph]}`);
  const next = setQuestion(state, {
    ...qs,
    stage: 'question',
    used: [...qs.used, hieroglyph],
    questionId: q.id,
    revealed: 1,
    pointsOnOffer: CLUE_POINTS[1],
    result: null,
  });
  const first = q.clues[0];
  return withPlayMedia(next, first && first.kind === 'audio' && first.media ? first.media.key : null);
}

export function revealClue(state: GameState): GameState {
  const qs = requireQuestionState(state);
  if (qs.stage !== 'question') return fail('no question is being played');
  if (qs.revealed >= maxCluesFor(qs.round)) return fail('all clues are already revealed');
  const revealed = qs.revealed + 1;
  const next = setQuestion(state, { ...qs, revealed, pointsOnOffer: CLUE_POINTS[revealed] });
  const q = findQuestion(state, qs.questionId);
  const clue = q?.clues[revealed - 1];
  return clue && clue.kind === 'audio' && clue.media ? withPlayMedia(next, clue.media.key) : next;
}

export function judgeCorrect(state: GameState): GameState {
  const qs = requireQuestionState(state);
  if (qs.stage !== 'question') return fail('no question is being played');
  const points = qs.pointsOnOffer;
  const scored = addScore(state, qs.team, points);
  const next = setQuestion(scored, {
    ...qs,
    stage: 'answer',
    revealed: 4,
    result: { winner: qs.team, points, viaSteal: false },
  });
  return playNewlyRevealedAudio(state, next);
}

export function judgeIncorrect(state: GameState): GameState {
  const qs = requireQuestionState(state);
  if (qs.stage !== 'question') return fail('no question is being played');
  const next = setQuestion(state, { ...qs, stage: 'steal', revealed: 4, pointsOnOffer: STEAL_POINTS });
  return playNewlyRevealedAudio(state, next);
}

/**
 * Void a broken question (missing media, pack error): nothing is revealed, no points, no steal. The
 * hieroglyph stays used and the question counts towards the round's total, so the round still ends normally.
 */
export function voidQuestion(state: GameState): GameState {
  const qs = requireQuestionState(state);
  if (qs.stage !== 'question' && qs.stage !== 'steal') return fail('no question is being played');
  return advance(state, qs);
}

export function judgeStealCorrect(state: GameState): GameState {
  const qs = requireQuestionState(state);
  if (qs.stage !== 'steal') return fail('no steal in progress');
  const stealer = otherTeam(qs.team);
  const scored = addScore(state, stealer, STEAL_POINTS);
  return setQuestion(scored, {
    ...qs,
    stage: 'answer',
    result: { winner: stealer, points: STEAL_POINTS, viaSteal: true },
  });
}

export function judgeStealIncorrect(state: GameState): GameState {
  const qs = requireQuestionState(state);
  if (qs.stage !== 'steal') return fail('no steal in progress');
  return setQuestion(state, { ...qs, stage: 'answer', result: { winner: null, points: 0, viaSteal: true } });
}

export function nextQuestion(state: GameState): GameState {
  const qs = requireQuestionState(state);
  if (qs.stage !== 'answer') return fail('the current question has not been judged yet');
  if (isQuestionRoundComplete(qs)) return fail('the round is over');
  return advance(state, qs);
}

/** Counts the current question as played and moves on (selection for the other team, or round end). */
function advance(state: GameState, qs: QuestionRoundState): GameState {
  const questionsDone = qs.questionsDone + 1;
  if (questionsDone >= qs.questionsTotal) {
    // A judged question stays on screen (stage `answer`); a voided one must not be revealed, so the round
    // ends on an empty `selecting` state instead (nothing is mid-question, the grid is fully used).
    const ended: QuestionRoundState =
      qs.stage === 'answer'
        ? { ...qs, questionsDone }
        : { ...qs, stage: 'selecting', questionId: null, revealed: 0, pointsOnOffer: 0, result: null, questionsDone };
    return markRoundFinished(withPlayMedia(setQuestion(state, ended), null), qs.round);
  }
  const next = setQuestion(state, {
    ...qs,
    stage: 'selecting',
    team: otherTeam(qs.team),
    questionId: null,
    revealed: 0,
    pointsOnOffer: 0,
    result: null,
    questionsDone,
  });
  return withPlayMedia(next, null);
}

/** Admin action types valid for the current question-round state (none when no question round is live). */
export function allowedQuestionActions(state: GameState): Array<
  'q:select' | 'q:reveal' | 'q:correct' | 'q:incorrect' | 'q:stealCorrect' | 'q:stealIncorrect' | 'q:void' | 'q:next'
> {
  const qs = state.question;
  if (!qs || (state.phase !== 'connections' && state.phase !== 'sequences')) return [];
  switch (qs.stage) {
    case 'selecting':
      return qs.used.length < qs.questionsTotal ? ['q:select'] : [];
    case 'question':
      return qs.revealed < maxCluesFor(qs.round)
        ? ['q:reveal', 'q:correct', 'q:incorrect', 'q:void']
        : ['q:correct', 'q:incorrect', 'q:void'];
    case 'steal':
      return ['q:stealCorrect', 'q:stealIncorrect', 'q:void'];
    case 'answer':
      return isQuestionRoundComplete(qs) ? [] : ['q:next'];
    default:
      return [];
  }
}

/** True while a question is actually being played (the round must not be abandoned mid-question). */
export function isMidQuestion(state: GameState): boolean {
  const qs = state.question;
  if (!qs || (state.phase !== 'connections' && state.phase !== 'sequences')) return false;
  return qs.stage === 'question' || qs.stage === 'steal';
}

export function isQuestionRoundComplete(qs: QuestionRoundState): boolean {
  return qs.questionsDone >= qs.questionsTotal;
}
