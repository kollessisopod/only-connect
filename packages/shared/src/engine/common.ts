/**
 * Small helpers shared by the reducers. Everything is pure and returns new objects.
 */
import { GameError, type GameState, type RoundName, type TeamId } from '../types.js';

export function fail(message: string, code = 'invalid_action'): never {
  throw new GameError(message, code);
}

export function finishedRounds(state: GameState): RoundName[] {
  return state.finishedRounds ?? [];
}

export function isRoundFinished(state: GameState, round: RoundName): boolean {
  return finishedRounds(state).includes(round);
}

export function markRoundFinished(state: GameState, round: RoundName): GameState {
  if (isRoundFinished(state, round)) return state;
  return { ...state, finishedRounds: [...finishedRounds(state), round] };
}

/** Adds `delta` to a team's score (scores may go negative). */
export function addScore(state: GameState, team: TeamId, delta: number): GameState {
  if (delta === 0) return state;
  return {
    ...state,
    teams: {
      ...state.teams,
      [team]: { ...state.teams[team], score: state.teams[team].score + delta },
    },
  };
}

export function teamName(state: GameState, team: TeamId): string {
  return state.teams[team].name;
}

/** `{ pink: 0, blue: 0 }` with one or two entries overridden. */
export function deltaRecord(partial: Partial<Record<TeamId, number>>): Record<TeamId, number> {
  return { pink: partial.pink ?? 0, blue: partial.blue ?? 0 };
}

/** The nonce for a new `playMedia` request: `version + 1` is the version the action being applied will get. */
export function nextMediaNonce(state: GameState): number {
  return state.version + 1;
}

export function withPlayMedia(state: GameState, key: string | null): GameState {
  if (key === null) return state.playMedia === null ? state : { ...state, playMedia: null };
  return { ...state, playMedia: { key, nonce: nextMediaNonce(state) } };
}
