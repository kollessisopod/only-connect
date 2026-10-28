/**
 * Human labels for admin actions (buttons, action log) and the keyboard-shortcut map.
 */
import { CUE_LABELS, DEFAULT_TEAM_NAMES, HIEROGLYPH_LABELS, TEAM_COLOUR_LABELS, type AdminAction, type GameState, type TeamId } from '@only-connect/shared';

export const ACTION_LABELS: Record<AdminAction['type'], string> = {
  'game:new': 'New game',
  'game:setTeamName': 'Rename team',
  'game:adjustScore': 'Adjust score',
  'game:removePlayer': 'Remove player',
  'game:lobby': 'Back to lobby',
  'game:undo': 'Undo',
  'round:start': 'Start round',
  'q:select': 'Pick hieroglyph',
  'q:reveal': 'Reveal next clue',
  'q:timeUp': 'Time up',
  'q:correct': 'Correct',
  'q:incorrect': 'Incorrect / pass',
  'q:stealCorrect': 'Steal correct',
  'q:stealIncorrect': 'Steal incorrect',
  'q:void': 'Void question',
  'q:next': 'Next question',
  'wall:select': 'Choose wall',
  'wall:start': 'Start wall',
  'wall:timeUp': 'Time up',
  'wall:abort': 'Abort wall',
  'wall:resolve': 'Resolve wall',
  'wall:connectionCorrect': 'Connection correct',
  'wall:connectionIncorrect': 'Connection incorrect',
  'wall:finish': 'Finish wall',
  'wall:clear': 'Clear wall',
  'vowels:showClue': 'Show clue',
  'vowels:correct': 'Correct',
  'vowels:incorrect': 'Incorrect',
  'vowels:otherCorrect': 'Other team correct',
  'vowels:nobody': 'Nobody',
  'vowels:reopen': 'Reopen buzzers',
  'vowels:next': 'Next clue',
  'vowels:skipCategory': 'Skip category',
  'round:final': 'Show final scores',
  'media:play': 'Play audio again',
  'media:stop': 'Stop audio',
  'cue:play': 'Play cue',
  'cue:stop': 'Stop cue',
};

const ROUND_NAMES = {
  connections: 'Connections',
  sequences: 'Sequences',
  wall: 'Connecting Wall',
  vowels: 'Missing Vowels',
} as const;

/** The team's name in `state`, or its default name when there is no game yet. */
export function teamNameIn(state: GameState | null, id: TeamId): string {
  return state?.teams[id]?.name ?? DEFAULT_TEAM_NAMES[id];
}

/** "A → B → C": a round order as the host reads it. */
export function describeOrder(order: readonly TeamId[], nameOf: (id: TeamId) => string): string {
  return order.map(nameOf).join(' → ');
}

/** Label for a concrete action instance, e.g. "Pick hieroglyph: Lion", "Adjust score: Pink +1". */
export function describeAction(action: AdminAction, state: GameState | null): string {
  const teamName = (id: TeamId) => teamNameIn(state, id);
  switch (action.type) {
    case 'game:new':
      return `New game (${action.teams.map((t) => t.name.trim() || DEFAULT_TEAM_NAMES[t.id]).join(' vs ')})`;
    case 'game:setTeamName':
      return `Rename ${TEAM_COLOUR_LABELS[action.team]} team to "${action.name}"`;
    case 'game:adjustScore':
      return `Adjust score: ${teamName(action.team)} ${action.delta >= 0 ? '+' : ''}${action.delta}`;
    case 'game:removePlayer': {
      const p = state?.players.find((pl) => pl.id === action.playerId);
      return `Remove player ${p ? p.name : action.playerId}`;
    }
    case 'round:start': {
      // A resumed round keeps the order it was started with, so the order only matters on a fresh start.
      const resumed = Boolean(state?.suspended?.[action.round]);
      const order = !resumed && action.order ? ` (${describeOrder(action.order, teamName)})` : '';
      return `${resumed ? 'Resume' : 'Start'} ${ROUND_NAMES[action.round]}${order}`;
    }
    case 'game:undo':
      return state?.undoable ? `Undo ${ACTION_LABELS[state.undoable].toLowerCase()}` : 'Undo';
    case 'q:select':
      return `Pick ${HIEROGLYPH_LABELS[action.hieroglyph]}`;
    case 'q:stealCorrect':
      return action.team ? `${teamName(action.team)} stole it` : ACTION_LABELS[action.type];
    case 'vowels:otherCorrect':
      return action.team ? `${teamName(action.team)} answered correctly` : ACTION_LABELS[action.type];
    case 'media:play':
      return action.clueIndex === undefined ? 'Play audio again' : `Play audio of clue ${action.clueIndex + 1}`;
    case 'cue:play':
      return `Play ${CUE_LABELS[action.cue].toLowerCase()}`;
    case 'wall:select': {
      const team = state?.phase === 'wall' ? state.wall?.team ?? null : null;
      return `Choose the ${HIEROGLYPH_LABELS[action.hieroglyph]} wall${team ? ` for ${teamName(team)}` : ''}`;
    }
    default:
      return ACTION_LABELS[action.type];
  }
}

export interface Hotkey {
  key: string;
  label: string;
  /** Candidate actions in priority order; the first one allowed right now is sent. */
  candidates: AdminAction['type'][];
}

/**
 * Keyboard shortcuts for the common judging actions (only when focus is not in a form control). With more than
 * two teams `q:stealCorrect` and `vowels:otherCorrect` need a team, which a key cannot name: the host clicks
 * the team's button instead (see `TEAM_ACTIONS`).
 */
export const HOTKEYS: Hotkey[] = [
  { key: 'r', label: 'R', candidates: ['q:reveal'] },
  { key: 'c', label: 'C', candidates: ['q:correct', 'q:stealCorrect', 'vowels:correct', 'vowels:otherCorrect', 'wall:connectionCorrect'] },
  { key: 'x', label: 'X', candidates: ['q:incorrect', 'q:stealIncorrect', 'vowels:incorrect', 'wall:connectionIncorrect'] },
  { key: 'n', label: 'N', candidates: ['q:next', 'vowels:next'] },
  { key: ' ', label: 'Space', candidates: ['vowels:showClue'] },
  { key: 'z', label: 'Z', candidates: ['game:undo'] },
];

/** Actions whose payload names a team once more than two teams play (a hotkey cannot send them then). */
export const TEAM_ACTIONS: ReadonlySet<AdminAction['type']> = new Set<AdminAction['type']>(['q:stealCorrect', 'vowels:otherCorrect']);

export function hotkeyFor(type: AdminAction['type']): string | undefined {
  return HOTKEYS.find((h) => h.candidates.includes(type))?.label;
}
