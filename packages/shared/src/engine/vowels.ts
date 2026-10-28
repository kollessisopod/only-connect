/**
 * Round 4 (Missing Vowels) reducers. SPEC §3.4, §10.
 */
import {
  VOWELS_CORRECT,
  VOWELS_INCORRECT,
  otherTeams,
  type ActionContext,
  type GameState,
  type TeamId,
  type VowelClue,
  type VowelGroup,
  type VowelsRoundState,
} from '../types.js';
import { addScore, deltaRecord, fail, markRoundFinished, teamName, withPlayMedia } from './common.js';
import { vowelsOrder } from './teams.js';

function requireVowels(state: GameState): VowelsRoundState {
  if (state.phase !== 'vowels' || !state.vowels) return fail('the Missing Vowels round is not in progress');
  return state.vowels;
}

function setVowels(state: GameState, vs: VowelsRoundState): GameState {
  return { ...state, vowels: vs };
}

export function currentVowelGroup(state: GameState): VowelGroup | null {
  const vs = state.vowels;
  if (!vs) return null;
  return state.pack.vowelGroups[vs.groupIndex] ?? null;
}

export function currentVowelClue(state: GameState): VowelClue | null {
  const vs = state.vowels;
  const group = currentVowelGroup(state);
  if (!vs || !group) return null;
  return group.clues[vs.clueIndex] ?? null;
}

/** True when the current clue is the last clue of the last category. */
export function isLastVowelClue(state: GameState): boolean {
  const vs = state.vowels;
  if (!vs) return false;
  const groups = state.pack.vowelGroups;
  const group = groups[vs.groupIndex];
  if (!group) return true;
  return vs.groupIndex >= groups.length - 1 && vs.clueIndex >= group.clues.length - 1;
}

/**
 * The teams that may answer after a wrong buzz: everyone in the round's order but the buzzing team (V3.2).
 * With two teams that is the other team; with more the host names it (`vowels:otherCorrect {team}`).
 */
export function otherAnswerCandidates(state: GameState, vs: VowelsRoundState): TeamId[] {
  if (!vs.buzz) return [];
  return otherTeams(vowelsOrder(state, vs), vs.buzz.team);
}

/** Missing Vowels is a buzzer round: `order` (chosen at `round:start`) only sets the display order on screen. */
export function startVowelsRound(state: GameState, order: TeamId[]): GameState {
  if (state.pack.vowelGroups.length === 0) return fail('the pack has no Missing Vowels categories');
  const vs: VowelsRoundState = {
    order: [...order],
    stage: 'category',
    groupIndex: 0,
    clueIndex: 0,
    buzz: null,
    result: null,
    lockedPlayers: [],
  };
  return withPlayMedia({ ...state, phase: 'vowels', question: null, wall: null, vowels: vs }, null);
}

export function showClue(state: GameState): GameState {
  const vs = requireVowels(state);
  if (vs.stage !== 'category') return fail('the clue is already on screen');
  return setVowels(state, { ...vs, stage: 'clue', buzz: null, result: null, lockedPlayers: [] });
}

export function buzz(state: GameState, playerId: string, ctx: ActionContext): GameState {
  if (state.phase !== 'vowels' || !state.vowels) return fail('buzzers are closed', 'buzz_closed');
  const vs = state.vowels;
  if (vs.stage === 'category') return fail('buzzers are closed', 'buzz_closed');
  if (vs.stage !== 'clue') return fail('too late', 'buzz_lost');
  const player = state.players.find((p) => p.id === playerId);
  if (!player) return fail('unknown player', 'unknown_player');
  if (vs.lockedPlayers.includes(playerId)) return fail('you already buzzed on this clue', 'buzz_locked');
  return setVowels(state, {
    ...vs,
    stage: 'buzzed',
    buzz: { playerId, playerName: player.name, team: player.team, at: ctx.now },
  });
}

function finishClue(state: GameState, vs: VowelsRoundState): GameState {
  const next = setVowels(state, { ...vs, stage: 'answer' });
  return isLastVowelClue(next) ? markRoundFinished(next, 'vowels') : next;
}

export function judgeCorrect(state: GameState): GameState {
  const vs = requireVowels(state);
  if (vs.stage !== 'buzzed' || !vs.buzz) return fail('nobody has buzzed');
  const team = vs.buzz.team;
  const scored = addScore(state, team, VOWELS_CORRECT);
  return finishClue(scored, { ...vs, result: { team, delta: deltaRecord({ [team]: VOWELS_CORRECT }) } });
}

export function judgeIncorrect(state: GameState): GameState {
  const vs = requireVowels(state);
  if (vs.stage !== 'buzzed' || !vs.buzz) return fail('nobody has buzzed');
  const team = vs.buzz.team;
  const scored = addScore(state, team, VOWELS_INCORRECT);
  return setVowels(scored, {
    ...vs,
    stage: 'other',
    result: { team: null, delta: deltaRecord({ [team]: VOWELS_INCORRECT }) },
  });
}

/**
 * After a wrong buzz another team answered correctly (V3.2): `team` names it. With two teams it may be
 * omitted (the other team); with more it is required (`team_required`) and must be a playing team other than
 * the one that buzzed (`invalid_team`).
 */
export function judgeOtherCorrect(state: GameState, team?: TeamId): GameState {
  const vs = requireVowels(state);
  if (vs.stage !== 'other' || !vs.buzz) return fail('the other team is not answering');
  const candidates = otherAnswerCandidates(state, vs);
  let answerer: TeamId;
  if (team === undefined) {
    if (candidates.length !== 1) return fail('name the team that answered (more than one team could have)', 'team_required');
    answerer = candidates[0];
  } else {
    if (!candidates.includes(team)) {
      return fail(
        team === vs.buzz.team ? `${teamName(state, team)} buzzed and was wrong; only another team can answer now` : `${teamName(state, team)} is not playing this round`,
        'invalid_team',
      );
    }
    answerer = team;
  }
  const scored = addScore(state, answerer, VOWELS_CORRECT);
  // Completed over all four teams even when the stored delta predates V3.2 (two keys).
  const delta = deltaRecord(vs.result?.delta ?? {});
  delta[answerer] += VOWELS_CORRECT;
  return finishClue(scored, { ...vs, result: { team: answerer, delta } });
}

/** Nobody got it: reveal the answer. Allowed after a wrong buzz (`other`) or when nobody buzzed at all. */
export function judgeNobody(state: GameState): GameState {
  const vs = requireVowels(state);
  if (vs.stage !== 'other' && vs.stage !== 'clue') return fail('cannot reveal the answer now');
  const result = vs.result ? { team: vs.result.team, delta: deltaRecord(vs.result.delta ?? {}) } : { team: null, delta: deltaRecord({}) };
  return finishClue(state, { ...vs, result });
}

/** False buzz: reopen the buzzers on the same clue; the player who buzzed is locked out. */
export function reopen(state: GameState): GameState {
  const vs = requireVowels(state);
  if (vs.stage !== 'buzzed' || !vs.buzz) return fail('nobody has buzzed');
  const locked = vs.lockedPlayers.includes(vs.buzz.playerId)
    ? vs.lockedPlayers
    : [...vs.lockedPlayers, vs.buzz.playerId];
  return setVowels(state, { ...vs, stage: 'clue', buzz: null, lockedPlayers: locked });
}

export function nextClue(state: GameState): GameState {
  const vs = requireVowels(state);
  if (vs.stage !== 'answer') return fail('the current clue has not been resolved');
  if (isLastVowelClue(state)) return fail('that was the last clue');
  const group = state.pack.vowelGroups[vs.groupIndex];
  const fresh = { buzz: null, result: null, lockedPlayers: [] };
  if (group && vs.clueIndex + 1 < group.clues.length) {
    return setVowels(state, { ...vs, ...fresh, stage: 'clue', clueIndex: vs.clueIndex + 1 });
  }
  return setVowels(state, { ...vs, ...fresh, stage: 'category', groupIndex: vs.groupIndex + 1, clueIndex: 0 });
}

export function skipCategory(state: GameState): GameState {
  const vs = requireVowels(state);
  if (vs.stage === 'buzzed' || vs.stage === 'other') return fail('judge the current buzz first');
  if (vs.groupIndex + 1 >= state.pack.vowelGroups.length) return fail('this is the last category');
  return setVowels(state, {
    ...vs,
    stage: 'category',
    groupIndex: vs.groupIndex + 1,
    clueIndex: 0,
    buzz: null,
    result: null,
    lockedPlayers: [],
  });
}

export type VowelsAdminActionType =
  | 'vowels:showClue'
  | 'vowels:correct'
  | 'vowels:incorrect'
  | 'vowels:otherCorrect'
  | 'vowels:nobody'
  | 'vowels:reopen'
  | 'vowels:next'
  | 'vowels:skipCategory';

export function allowedVowelsActions(state: GameState): VowelsAdminActionType[] {
  if (state.phase !== 'vowels' || !state.vowels) return [];
  const vs = state.vowels;
  const out: VowelsAdminActionType[] = [];
  switch (vs.stage) {
    case 'category':
      out.push('vowels:showClue');
      break;
    case 'clue':
      out.push('vowels:nobody');
      break;
    case 'buzzed':
      out.push('vowels:correct', 'vowels:incorrect', 'vowels:reopen');
      break;
    case 'other':
      out.push('vowels:otherCorrect', 'vowels:nobody');
      break;
    case 'answer':
      if (!isLastVowelClue(state)) out.push('vowels:next');
      break;
    default:
      break;
  }
  if (vs.stage !== 'buzzed' && vs.stage !== 'other' && vs.groupIndex + 1 < state.pack.vowelGroups.length) {
    out.push('vowels:skipCategory');
  }
  return out;
}

/** True while a buzz is being judged. */
export function isMidVowels(state: GameState): boolean {
  const vs = state.phase === 'vowels' ? state.vowels : null;
  return !!vs && (vs.stage === 'buzzed' || vs.stage === 'other');
}
