/**
 * Small helpers shared by the reducers. Everything is pure and returns new objects.
 */
import { DEFAULT_TEAM_NAMES, GameError, TEAM_IDS, type GameState, type RoundName, type TeamId } from '../types.js';

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

/**
 * Adds `delta` to a team's score (scores may go negative). A state persisted before V3.2 holds only two team
 * records: the missing one is created on the spot so nothing ever indexes `undefined`.
 */
export function addScore(state: GameState, team: TeamId, delta: number): GameState {
  if (delta === 0) return state;
  const current = state.teams[team] ?? { id: team, name: DEFAULT_TEAM_NAMES[team], score: 0 };
  return {
    ...state,
    teams: {
      ...state.teams,
      [team]: { ...current, score: current.score + delta },
    },
  };
}

/** A team's display name; the default name when the record is missing (a state persisted before V3.2). */
export function teamName(state: GameState, team: TeamId): string {
  return state.teams[team]?.name ?? DEFAULT_TEAM_NAMES[team];
}

/**
 * A score delta over every one of the four teams (`{ pink: 0, blue: 0, green: 0, orange: 0 }`) with some
 * entries overridden. Always complete, so the screens never index a missing team — a delta persisted before
 * V3.2 (two keys) is completed the same way when it is read back.
 */
export function deltaRecord(partial: Partial<Record<TeamId, number>>): Record<TeamId, number> {
  const out = {} as Record<TeamId, number>;
  for (const id of TEAM_IDS) out[id] = partial[id] ?? 0;
  return out;
}

/** The nonce for a new `playMedia` request: `version + 1` is the version the action being applied will get. */
export function nextMediaNonce(state: GameState): number {
  return state.version + 1;
}

export function withPlayMedia(state: GameState, key: string | null): GameState {
  if (key === null) return state.playMedia === null ? state : { ...state, playMedia: null };
  return { ...state, playMedia: { key, nonce: nextMediaNonce(state) } };
}
