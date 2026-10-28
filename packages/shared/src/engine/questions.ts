/**
 * Round 1 (Connections) and Round 2 (Sequences) reducers. SPEC §3.1, §3.2, §10.
 */
import {
  CLUE_POINTS,
  HIEROGLYPHS,
  HIEROGLYPH_LABELS,
  MAX_CLUES_CONNECTIONS,
  MAX_CLUES_SEQUENCES,
  QUESTION_INTRO_MS,
  QUESTION_INTRO_PHASES,
  QUESTION_SECONDS,
  STEAL_POINTS,
  otherTeams,
  type ActionContext,
  type Clue,
  type GameState,
  type Hieroglyph,
  type Pack,
  type PublicQuestionRoundState,
  type Question,
  type QuestionRound,
  type QuestionRoundState,
  type TeamId,
} from '../types.js';
import { addScore, fail, markRoundFinished, teamName, withPlayMedia } from './common.js';
import { questionOrder } from './teams.js';

/** The 40 s question clock in ms (V3, SPEC §3.1). */
export const QUESTION_MS = QUESTION_SECONDS * 1000;

/**
 * The clock fields of a question-round state: `startedAt` / `endsAt` while the clock runs or has run out,
 * null otherwise. States persisted before V3 lack them (optional in the contract), so every reader goes
 * through these helpers and treats a missing field as "no clock".
 */
export type QuestionClock = Pick<PublicQuestionRoundState, 'startedAt' | 'endsAt' | 'timeUp'>;
type ClockLike = { stage?: string; startedAt?: number | null; endsAt?: number | null; timeUp?: boolean };

/** No clock at all: the shape every judged / selecting state carries (fields present, not undefined). */
const NO_CLOCK: QuestionClock = { startedAt: null, endsAt: null, timeUp: false };

/**
 * Seconds left on the question clock: 0 when there is no clock or the time is up, and clamped to
 * `QUESTION_SECONDS` before `startedAt` (the clock is announced `QUESTION_INTRO_MS` ahead of its start by
 * `q:select`, so a naive ceil would show 45 during the intro).
 */
export function questionSecondsRemaining(qs: ClockLike, now: number): number {
  const endsAt = qs.endsAt ?? null;
  if (endsAt === null || qs.timeUp === true) return 0;
  return Math.min(QUESTION_SECONDS, Math.max(0, Math.ceil((endsAt - now) / 1000)));
}

/**
 * True while the 40 s clock is armed: a question is being played, the clock is set and has not run out. This
 * is true from the pick, before `startedAt` too (the server timer fires at `endsAt` regardless of the intro;
 * what the screens show during the intro is `questionIntroPhase`); `questionClockStarted` says whether the
 * clock is actually counting at a given time.
 */
export function questionClockRunning(qs: ClockLike): boolean {
  return qs.stage === 'question' && (qs.endsAt ?? null) !== null && qs.timeUp !== true;
}

/** True once the armed clock has reached `startedAt` (the question layout is up and the seconds count down). */
export function questionClockStarted(qs: ClockLike, now: number): boolean {
  const startedAt = qs.startedAt ?? null;
  return questionClockRunning(qs) && startedAt !== null && now >= startedAt;
}

/**
 * The show's pick-to-question intro (V3.1, `QUESTION_INTRO_MS` in the contract) as a pure function of the
 * server clock, so every screen agrees and a reload mid-intro lands in the right phase: `pulse` (the chosen
 * glyph pulses on the grid), `empty` (it has whooshed out, the slot is bare), `clue` (the first clue sits in
 * the slot), `none` once `now >= startedAt` (the question layout, clock counting) or when nothing is being
 * played / the state carries no clock.
 */
export type QuestionIntroPhase = 'none' | 'pulse' | 'empty' | 'clue';

export function questionIntroPhase(qs: ClockLike, now: number): QuestionIntroPhase {
  const startedAt = qs.startedAt ?? null;
  if (qs.stage !== 'question' || startedAt === null || qs.timeUp === true) return 'none';
  const sincePick = now - (startedAt - QUESTION_INTRO_MS);
  if (sincePick >= QUESTION_INTRO_MS) return 'none';
  if (sincePick < QUESTION_INTRO_PHASES.pulseUntil) return 'pulse';
  if (sincePick < QUESTION_INTRO_PHASES.emptyUntil) return 'empty';
  return 'clue';
}

export function maxCluesFor(round: QuestionRound): number {
  return round === 'connections' ? MAX_CLUES_CONNECTIONS : MAX_CLUES_SEQUENCES;
}

/** The team that picks question `questionsDone` of a round: the turn order wraps (`order[k % n]`, SPEC §3.1). */
export function teamForQuestion(order: readonly TeamId[], questionsDone: number): TeamId {
  return order[questionsDone % order.length];
}

/**
 * The teams that may steal the current question: everyone in the order but the answering team (V3.2). With
 * two teams that is the other team; with more the host names the stealer (`q:stealCorrect {team}`).
 */
export function stealCandidates(state: GameState, qs: QuestionRoundState): TeamId[] {
  return otherTeams(questionOrder(state, qs), qs.team);
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
 * each); the grid shows only those hieroglyphs. `order` is the turn order the host chose (already validated
 * by `round:start`): its first team picks first and the turns wrap around it.
 */
export function startQuestionRound(state: GameState, round: QuestionRound, order: TeamId[]): GameState {
  const available = roundHieroglyphs(state.pack, round);
  const qs: QuestionRoundState = {
    round,
    stage: 'selecting',
    order: [...order],
    team: teamForQuestion(order, 0),
    available,
    used: [],
    questionId: null,
    revealed: 0,
    pointsOnOffer: 0,
    result: null,
    questionsDone: 0,
    questionsTotal: available.length,
    ...NO_CLOCK,
  };
  return withPlayMedia({ ...state, phase: round, question: qs, wall: null, vowels: null }, null);
}

/**
 * Picking a question arms its 40 s clock (SPEC §3.1): the team buys clues until it runs out. The clock is
 * announced `QUESTION_INTRO_MS` ahead (V3.1): the screens play the glyph-pulse / whoosh / clue-in-slot intro
 * until `startedAt`, then the question layout appears and the seconds count down; `endsAt` is the deadline
 * the server timer fires at.
 */
export function selectHieroglyph(state: GameState, hieroglyph: Hieroglyph, ctx: ActionContext): GameState {
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
    startedAt: ctx.now + QUESTION_INTRO_MS,
    endsAt: ctx.now + QUESTION_INTRO_MS + QUESTION_MS,
    timeUp: false,
  });
  const first = q.clues[0];
  return withPlayMedia(next, first && first.kind === 'audio' && first.media ? first.media.key : null);
}

export function revealClue(state: GameState): GameState {
  const qs = requireQuestionState(state);
  if (qs.stage !== 'question') return fail('no question is being played');
  // Once the clock has run out the team must answer on what it has (SPEC §3.1).
  if (qs.timeUp === true) return fail('time is up — no more clues can be revealed', 'question_time_up');
  if (qs.revealed >= maxCluesFor(qs.round)) return fail('all clues are already revealed');
  const revealed = qs.revealed + 1;
  const next = setQuestion(state, { ...qs, revealed, pointsOnOffer: CLUE_POINTS[revealed] });
  const q = findQuestion(state, qs.questionId);
  const clue = q?.clues[revealed - 1];
  return clue && clue.kind === 'audio' && clue.media ? withPlayMedia(next, clue.media.key) : next;
}

/**
 * The 40 s clock ran out (server timer) or the host called time early: no more clues, the team must answer
 * for the points on offer. `startedAt` / `endsAt` are kept so the timer bars stay where they stopped. A
 * no-op (not an error) when the time is already up, so a late timer action after the host's press is harmless.
 */
export function questionTimeUp(state: GameState, ctx: ActionContext): GameState {
  const qs = requireQuestionState(state);
  if (qs.stage !== 'question') return fail('no question is being played');
  if (qs.timeUp === true) return state;
  // `q:select` always sets the clock; a state persisted before V3 has none, which is read as null (the bars
  // then simply show nothing). `ctx` is taken for symmetry with `wallTimeUp` and future "ended at" needs.
  void ctx;
  return setQuestion(state, { ...qs, startedAt: qs.startedAt ?? null, endsAt: qs.endsAt ?? null, timeUp: true });
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
    ...NO_CLOCK,
  });
  return playNewlyRevealedAudio(state, next);
}

/** A judged question has no clock (the steal is untimed, SPEC §3.1). */
export function judgeIncorrect(state: GameState): GameState {
  const qs = requireQuestionState(state);
  if (qs.stage !== 'question') return fail('no question is being played');
  const next = setQuestion(state, { ...qs, stage: 'steal', revealed: 4, pointsOnOffer: STEAL_POINTS, ...NO_CLOCK });
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

/**
 * The steal was answered correctly by `team` (V3.2). With two teams `team` may be omitted (it is the other
 * team); with more the host must name it (`team_required`). It must be a playing team other than the one
 * that answered (`invalid_team`).
 */
export function judgeStealCorrect(state: GameState, team?: TeamId): GameState {
  const qs = requireQuestionState(state);
  if (qs.stage !== 'steal') return fail('no steal in progress');
  const candidates = stealCandidates(state, qs);
  let stealer: TeamId;
  if (team === undefined) {
    if (candidates.length !== 1) return fail('name the team that stole (more than one team could have)', 'team_required');
    stealer = candidates[0];
  } else {
    if (!candidates.includes(team)) {
      return fail(
        team === qs.team ? `${teamName(state, team)} answered the question; only another team can steal it` : `${teamName(state, team)} is not playing this round`,
        'invalid_team',
      );
    }
    stealer = team;
  }
  const scored = addScore(state, stealer, STEAL_POINTS);
  return setQuestion(scored, {
    ...qs,
    stage: 'answer',
    result: { winner: stealer, points: STEAL_POINTS, viaSteal: true },
    ...NO_CLOCK,
  });
}

export function judgeStealIncorrect(state: GameState): GameState {
  const qs = requireQuestionState(state);
  if (qs.stage !== 'steal') return fail('no steal in progress');
  return setQuestion(state, { ...qs, stage: 'answer', result: { winner: null, points: 0, viaSteal: true }, ...NO_CLOCK });
}

export function nextQuestion(state: GameState): GameState {
  const qs = requireQuestionState(state);
  if (qs.stage !== 'answer') return fail('the current question has not been judged yet');
  if (isQuestionRoundComplete(qs)) return fail('the round is over');
  return advance(state, qs);
}

/**
 * Counts the current question as played and moves on: selection for the next team in the round's order, or
 * round end. The resolved `order` is written back so a state persisted before V3.2 carries it from here on.
 */
function advance(state: GameState, qs: QuestionRoundState): GameState {
  const order = questionOrder(state, qs);
  const questionsDone = qs.questionsDone + 1;
  if (questionsDone >= qs.questionsTotal) {
    // A judged question stays on screen (stage `answer`); a voided one must not be revealed, so the round
    // ends on an empty `selecting` state instead (nothing is mid-question, the grid is fully used).
    const ended: QuestionRoundState =
      qs.stage === 'answer'
        ? { ...qs, order, questionsDone, ...NO_CLOCK }
        : { ...qs, order, stage: 'selecting', questionId: null, revealed: 0, pointsOnOffer: 0, result: null, questionsDone, ...NO_CLOCK };
    return markRoundFinished(withPlayMedia(setQuestion(state, ended), null), qs.round);
  }
  const next = setQuestion(state, {
    ...qs,
    order,
    stage: 'selecting',
    team: teamForQuestion(order, questionsDone),
    questionId: null,
    revealed: 0,
    pointsOnOffer: 0,
    result: null,
    questionsDone,
    ...NO_CLOCK,
  });
  return withPlayMedia(next, null);
}

export type QuestionAdminActionType =
  | 'q:select'
  | 'q:reveal'
  | 'q:correct'
  | 'q:incorrect'
  | 'q:stealCorrect'
  | 'q:stealIncorrect'
  | 'q:void'
  | 'q:timeUp'
  | 'q:next';

/** Admin action types valid for the current question-round state (none when no question round is live). */
export function allowedQuestionActions(state: GameState): QuestionAdminActionType[] {
  const qs = state.question;
  if (!qs || (state.phase !== 'connections' && state.phase !== 'sequences')) return [];
  switch (qs.stage) {
    case 'selecting':
      return qs.used.length < qs.questionsTotal ? ['q:select'] : [];
    case 'question': {
      // Reveal while clues are left and the clock has not run out; "time up" only while it has not.
      const timeUp = qs.timeUp === true;
      const out: QuestionAdminActionType[] = [];
      if (!timeUp && qs.revealed < maxCluesFor(qs.round)) out.push('q:reveal');
      out.push('q:correct', 'q:incorrect', 'q:void');
      if (!timeUp) out.push('q:timeUp');
      return out;
    }
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
