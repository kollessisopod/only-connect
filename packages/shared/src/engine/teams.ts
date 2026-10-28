/**
 * Teams and turn orders (V3.2). SPEC §3, §10.
 *
 * A game plays 2 to 4 of the four teams (`GameState.activeTeams`, in creation order) and every round carries
 * the order the host chose at `round:start` (`order`, a permutation of the active teams): question k goes to
 * `order[k % n]`, wall k is chosen by `order[k % n]`, Missing Vowels only displays the teams in that order.
 *
 * States persisted before V3.2 have none of this (no `activeTeams`, round states without `order`, a two-key
 * `teams` record, `firstTeam` set). Every reader goes through the resolvers below, which derive the V3 rules
 * for such a state — Connections opened by `firstTeam`, Sequences by the other team, walls alternating from
 * the current chooser — and `normalizeGameState` writes the derived values into the state once, so the API
 * never hands a client a state with a missing field.
 */
import {
  DEFAULT_TEAM_IDS,
  DEFAULT_TEAM_NAMES,
  MIN_TEAMS,
  TEAM_IDS,
  otherTeam,
  type GameState,
  type QuestionRoundState,
  type RoundName,
  type Team,
  type TeamId,
  type VowelsRoundState,
  type WallRoundState,
} from '../types.js';
import { fail, teamName } from './common.js';

const ROUNDS: readonly RoundName[] = ['connections', 'sequences', 'wall', 'vowels'];

/** True for a usable stored order: at least two distinct known team ids. */
function isOrder(value: unknown): value is TeamId[] {
  return (
    Array.isArray(value) &&
    value.length >= MIN_TEAMS &&
    value.every((t) => TEAM_IDS.includes(t)) &&
    new Set(value).size === value.length
  );
}

/** The two-team order a V3 state implies: `first`, then the other of pink / blue. */
function legacyPair(first: TeamId): TeamId[] {
  return [first, otherTeam(first)];
}

/** The team that opened Connections in a V3 state (`firstTeam`; pink when even that is missing). */
function legacyFirstTeam(state: GameState): TeamId {
  return state.firstTeam !== undefined && TEAM_IDS.includes(state.firstTeam) ? state.firstTeam : DEFAULT_TEAM_IDS[0];
}

/** The teams playing this game, in creation order (a copy; `DEFAULT_TEAM_IDS` for a state persisted before V3.2). */
export function activeTeams(state: GameState): TeamId[] {
  return isOrder(state.activeTeams) ? [...state.activeTeams] : [...DEFAULT_TEAM_IDS];
}

export function isActiveTeam(state: GameState, team: TeamId): boolean {
  return activeTeams(state).includes(team);
}

/** Throws unless `team` is a known id of a team playing this game (`team_inactive` otherwise). */
export function requireActiveTeam(state: GameState, team: TeamId, what = 'team'): TeamId {
  if (!TEAM_IDS.includes(team)) fail(`${what} must be one of ${TEAM_IDS.join(', ')}`);
  if (!isActiveTeam(state, team)) fail(`${teamName(state, team)} is not playing this game`, 'team_inactive');
  return team;
}

/**
 * The turn order of a question round. A V3 state (no `order`) is read as `[firstTeam, other]` for
 * Connections and `[other, firstTeam]` for Sequences; without even a `firstTeam`, from the team on screen
 * and how many questions it has played.
 */
export function questionOrder(state: GameState, qs: QuestionRoundState): TeamId[] {
  if (isOrder(qs.order)) return [...qs.order];
  if (state.firstTeam !== undefined) {
    const first = legacyFirstTeam(state);
    return qs.round === 'connections' ? legacyPair(first) : legacyPair(otherTeam(first));
  }
  return qs.questionsDone % 2 === 0 ? legacyPair(qs.team) : legacyPair(otherTeam(qs.team));
}

/**
 * The order the teams choose walls in. A V3 state (no `order`) alternated from its first chooser: the
 * current chooser leads when an even number of walls is done, the other team otherwise.
 */
export function wallOrder(state: GameState, w: WallRoundState): TeamId[] {
  void state; // taken for symmetry with the other resolvers (the legacy wall order needs only the round state)
  if (isOrder(w.order)) return [...w.order];
  return w.wallsDone % 2 === 0 ? legacyPair(w.team) : legacyPair(otherTeam(w.team));
}

/** The display order of Missing Vowels. A V3 state (no `order`) is read as `[firstTeam, other]`. */
export function vowelsOrder(state: GameState, vs: VowelsRoundState): TeamId[] {
  if (isOrder(vs.order)) return [...vs.order];
  return legacyPair(legacyFirstTeam(state));
}

/**
 * The order of the round the host is coming from: the round on screen, else the most recently suspended
 * one (in show order: vowels before wall before sequences before connections), else null. Finished rounds
 * that were already left for the lobby are not kept, so a tie after a detour through the lobby falls back
 * to the creation order.
 */
export function previousRoundOrder(state: GameState): TeamId[] | null {
  const of = (round: RoundName, saved: QuestionRoundState | WallRoundState | VowelsRoundState | null | undefined): TeamId[] | null => {
    if (!saved) return null;
    switch (round) {
      case 'connections':
      case 'sequences':
        return questionOrder(state, saved as QuestionRoundState);
      case 'wall':
        return wallOrder(state, saved as WallRoundState);
      case 'vowels':
        return vowelsOrder(state, saved as VowelsRoundState);
      default:
        return null;
    }
  };
  switch (state.phase) {
    case 'connections':
    case 'sequences': {
      const found = of(state.phase, state.question);
      if (found) return found;
      break;
    }
    case 'wall': {
      const found = of('wall', state.wall);
      if (found) return found;
      break;
    }
    case 'vowels': {
      const found = of('vowels', state.vowels);
      if (found) return found;
      break;
    }
    default:
      break;
  }
  const suspended = state.suspended ?? {};
  for (const round of [...ROUNDS].reverse()) {
    const found = of(round, suspended[round]);
    if (found) return found;
  }
  return null;
}

/**
 * The order `round:start` uses when the host passes none: the active teams by ascending score (the team
 * furthest behind opens), ties keeping the previous round's order (`previousRoundOrder`), else the creation
 * order. So with level scores a round keeps the order of the one before it; the host passes an explicit
 * `order` to change that.
 */
export function suggestedRoundOrder(state: GameState): TeamId[] {
  const active = activeTeams(state);
  const previous = previousRoundOrder(state);
  const base = previous ? [...previous.filter((t) => active.includes(t)), ...active.filter((t) => !previous.includes(t))] : active;
  const score = (t: TeamId) => state.teams[t]?.score ?? 0;
  // Array.prototype.sort is stable, so ties keep the base order.
  return [...base].sort((a, b) => score(a) - score(b));
}

/** Checks a host-given `round:start` order: a permutation of the active teams (`invalid_order` otherwise). */
export function validateRoundOrder(state: GameState, order: unknown): TeamId[] {
  const active = activeTeams(state);
  const ok =
    Array.isArray(order) &&
    order.length === active.length &&
    new Set(order).size === order.length &&
    order.every((t) => active.includes(t as TeamId));
  if (!ok) fail(`order must list each playing team exactly once (${active.join(', ')})`, 'invalid_order');
  return [...(order as TeamId[])];
}

/** Active teams ranked by score, highest first; equal scores keep the creation order. */
export function teamStandings(state: GameState): TeamId[] {
  const score = (t: TeamId) => state.teams[t]?.score ?? 0;
  return activeTeams(state).sort((a, b) => score(b) - score(a));
}

/**
 * Fills in what a state persisted before V3.2 lacks — `activeTeams` (pink and blue), the two idle team
 * records, and the `order` of every round state present (on screen or suspended) from the V3 rules — so
 * every consumer finds every V3.2 field. Returns the same object when nothing was missing.
 */
export function normalizeGameState(state: GameState): GameState {
  let changed = false;
  const next: GameState = { ...state };
  if (!isOrder(state.activeTeams)) {
    next.activeTeams = [...DEFAULT_TEAM_IDS];
    changed = true;
  }
  const teams = { ...(state.teams ?? ({} as Record<TeamId, Team>)) };
  let teamsChanged = false;
  for (const id of TEAM_IDS) {
    if (!teams[id]) {
      teams[id] = { id, name: DEFAULT_TEAM_NAMES[id], score: 0 };
      teamsChanged = true;
    }
  }
  if (teamsChanged) {
    next.teams = teams;
    changed = true;
  }
  if (state.question && !isOrder(state.question.order)) {
    next.question = { ...state.question, order: questionOrder(state, state.question) };
    changed = true;
  }
  if (state.wall && !isOrder(state.wall.order)) {
    next.wall = { ...state.wall, order: wallOrder(state, state.wall) };
    changed = true;
  }
  if (state.vowels && !isOrder(state.vowels.order)) {
    next.vowels = { ...state.vowels, order: vowelsOrder(state, state.vowels) };
    changed = true;
  }
  if (state.suspended) {
    const suspended = { ...state.suspended };
    let suspendedChanged = false;
    for (const round of ['connections', 'sequences'] as const) {
      const saved = suspended[round];
      if (saved && !isOrder(saved.order)) {
        suspended[round] = { ...saved, order: questionOrder(state, saved) };
        suspendedChanged = true;
      }
    }
    if (suspended.wall && !isOrder(suspended.wall.order)) {
      suspended.wall = { ...suspended.wall, order: wallOrder(state, suspended.wall) };
      suspendedChanged = true;
    }
    if (suspended.vowels && !isOrder(suspended.vowels.order)) {
      suspended.vowels = { ...suspended.vowels, order: vowelsOrder(state, suspended.vowels) };
      suspendedChanged = true;
    }
    if (suspendedChanged) {
      next.suspended = suspended;
      changed = true;
    }
  }
  return changed ? next : state;
}
