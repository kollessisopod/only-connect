/**
 * THE CONTRACT between api, client and the game engine.
 * See docs/SPEC.md. Keep this file dependency-free (types + a few constants only).
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const TEAM_IDS = ['pink', 'blue'] as const;
export type TeamId = (typeof TEAM_IDS)[number];

/**
 * The twelve hieroglyphs a question can be tagged with, in grid order. The first six are the show's own; the
 * other six only appear when a pack has more than six questions in a round.
 */
export const HIEROGLYPHS = [
  'twoReeds',
  'lion',
  'twistedFlax',
  'hornedViper',
  'water',
  'eyeOfHorus',
  'ankh',
  'scarab',
  'feather',
  'owl',
  'cobra',
  'sun',
] as const;
export type Hieroglyph = (typeof HIEROGLYPHS)[number];

export const HIEROGLYPH_LABELS: Record<Hieroglyph, string> = {
  twoReeds: 'Two Reeds',
  lion: 'Lion',
  twistedFlax: 'Twisted Flax',
  hornedViper: 'Horned Viper',
  water: 'Water',
  eyeOfHorus: 'Eye of Horus',
  ankh: 'Ankh',
  scarab: 'Scarab',
  feather: 'Feather',
  owl: 'Owl',
  cobra: 'Cobra',
  sun: 'Sun',
};

/** Points available in Connections/Sequences after N clues have been revealed (index = clues revealed). */
export const CLUE_POINTS = [0, 5, 3, 2, 1] as const;
export const STEAL_POINTS = 1;
/** Connecting Wall clock: 2 minutes 30 seconds (V3; was 3:00). */
export const WALL_SECONDS = 150;
/**
 * Connections / Sequences clock (V3): started by `q:select`, it runs while the team is buying clues
 * (`stage: 'question'`). When it runs out (`q:timeUp`, fired by the server or pressed by the host) no more
 * clues can be revealed and the team must answer for the points on offer. The steal has no clock.
 */
export const QUESTION_SECONDS = 40;
export const WALL_LIVES = 3;
export const WALL_GROUP_POINT = 1;
export const WALL_CONNECTION_POINT = 1;
export const WALL_PERFECT_BONUS = 2;
export const VOWELS_CORRECT = 1;
export const VOWELS_INCORRECT = -1;
/** A Connections / Sequences round has between 1 and 12 questions (one hieroglyph each). */
export const MIN_QUESTIONS_PER_ROUND = 1;
export const MAX_QUESTIONS_PER_ROUND = 12;
/**
 * A pack has exactly 2 or 4 connecting walls (an even number, so each team chooses and plays the same number of
 * walls, alternating A, B, A, B). Each wall is tagged with a hieroglyph unique among the pack's walls.
 */
export const MIN_WALLS = 2;
export const MAX_WALLS = 4;
/**
 * The order in which the editor hands out wall hieroglyphs to new walls: the show's two wall glyphs first, then
 * the rest of `HIEROGLYPHS` (see `nextWallHieroglyph` in the engine).
 */
export const WALL_HIEROGLYPH_ORDER: readonly Hieroglyph[] = ['lion', 'water', ...HIEROGLYPHS.filter((h) => h !== 'lion' && h !== 'water')];
export const MAX_CLUES_CONNECTIONS = 4;
export const MAX_CLUES_SEQUENCES = 3;
/** Hard cap on players in one game (`player:join` fails with `game_full` beyond it). */
export const MAX_PLAYERS = 40;

export const WALL_GROUP_COLOURS = ['#4daee9', '#5db85d', '#b16ed6', '#1d4f9e'] as const;

/**
 * Show cues the host can fire on the monitor from the admin console (`cue:play`): the opening titles music
 * (`client/public/assets/sfx/openingTitlesWithFlurry.mp3`, 21 s) and the opening title clip
 * (`client/public/assets/clips/opening.mp4`, 17 s, shown full screen with its own sound). Both are static
 * client assets, not bucket media.
 */
export const CUE_NAMES = ['openingTitles', 'introClip'] as const;
export type CueName = (typeof CUE_NAMES)[number];
export const CUE_LABELS: Record<CueName, string> = {
  openingTitles: 'Opening titles (music)',
  introClip: 'Opening clip (video)',
};

export function otherTeam(team: TeamId): TeamId {
  return team === 'pink' ? 'blue' : 'pink';
}

// ---------------------------------------------------------------------------
// Content (packs)
// ---------------------------------------------------------------------------

export type ClueKind = 'text' | 'image' | 'audio';

export interface MediaRef {
  /** Object key in the bucket, e.g. `uploads/3f2c....png` */
  key: string;
  /** Relative URL to fetch it: `/api/media/<key>` */
  url: string;
  mime: string;
  name: string;
}

export interface Clue {
  kind: ClueKind;
  /** For text clues: the clue. For image/audio clues: the caption shown on answer reveal. */
  text: string;
  media?: MediaRef;
}

export type QuestionRound = 'connections' | 'sequences';

export interface Question {
  id: string;
  round: QuestionRound;
  hieroglyph: Hieroglyph;
  /** 0..n-1 ordering within the round (n = questions in that round, at most MAX_QUESTIONS_PER_ROUND) */
  position: number;
  /** Exactly 4 clues. For sequences, clue[3] is the hidden 4th item. */
  clues: Clue[];
  answer: string;
  /** Host-only note / explanation. */
  note?: string;
}

export interface WallGroup {
  connection: string;
  /** Exactly 4 clues (text only). */
  clues: string[];
}

export interface Wall {
  id: string;
  /** 0..n-1 ordering within the pack (n = walls in the pack, at most MAX_WALLS) */
  position: number;
  /** The glyph a team chooses this wall by (unique among the pack's walls; any of the 12). */
  hieroglyph: Hieroglyph;
  /** Exactly 4 groups. */
  groups: WallGroup[];
}

export interface VowelClue {
  /** Full answer, e.g. "POLE ARC CAP" */
  answer: string;
  /** Vowel-stripped display, e.g. "PL RCC P" */
  display: string;
}

export interface VowelGroup {
  id: string;
  position: number;
  category: string;
  clues: VowelClue[];
}

export interface Pack {
  id: string;
  name: string;
  questions: Question[];
  walls: Wall[];
  vowelGroups: VowelGroup[];
  createdAt: string;
  updatedAt: string;
}

export interface PackSummary {
  id: string;
  name: string;
  playable: boolean;
  problems: string[];
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Game state (authoritative, full — admin only)
// ---------------------------------------------------------------------------

export type Phase = 'lobby' | 'connections' | 'sequences' | 'wall' | 'vowels' | 'final';

/** The four playable rounds (the `round:start` targets). */
export type RoundName = 'connections' | 'sequences' | 'wall' | 'vowels';

export interface Team {
  id: TeamId;
  name: string;
  score: number;
}

export interface Player {
  id: string;
  name: string;
  team: TeamId;
  connected: boolean;
  joinedAt: number;
  /**
   * Bearer secret issued to the device that created the player (returned in the `player:join` ack). A
   * `player:join` for an existing id must present it; the public projection never includes it. Optional
   * (additive): players persisted before it existed adopt the first secret they are rejoined with.
   */
  secret?: string;
}

export type QuestionStage =
  | 'selecting' // hieroglyph grid shown, `team` is choosing
  | 'question' // clues being revealed to `team`
  | 'steal' // all clues shown, other team may steal for 1 point
  | 'answer'; // answer revealed, waiting for `q:next`

export interface QuestionRoundState {
  round: QuestionRound;
  stage: QuestionStage;
  /** Team whose turn it is (the one that picked / is answering). */
  team: TeamId;
  /** Hieroglyphs of this round's questions (the grid), in HIEROGLYPHS order. */
  available: Hieroglyph[];
  /** Hieroglyphs already used in this round. */
  used: Hieroglyph[];
  /** Index of the current question in pack.questions (filtered by round), or null while selecting. */
  questionId: string | null;
  /** 1..4 clues currently visible (sequences max 3 until answer). */
  revealed: number;
  /** Points on offer right now (CLUE_POINTS[revealed] or STEAL_POINTS in steal stage). */
  pointsOnOffer: number;
  /** Outcome of the question once judged. */
  result: null | { winner: TeamId | null; points: number; viaSteal: boolean };
  questionsDone: number;
  /** Number of questions in this round (= available.length); the round ends when questionsDone reaches it. */
  questionsTotal: number;
  /**
   * The 40 s clock (V3, `QUESTION_SECONDS`): server time (ms) it started (set by `q:select`) and when it runs
   * out; null while selecting and once the question is judged (`steal` / `answer`). Optional (additive):
   * states persisted before the clock existed are read as null (no clock on that question).
   */
  startedAt?: number | null;
  endsAt?: number | null;
  /** True once `q:timeUp` applied: `q:reveal` is no longer allowed, the team must answer. Optional (additive). */
  timeUp?: boolean;
}

export type WallStage =
  | 'ready' // wall chosen for a team but not started (panel inert)
  | 'live' // timer running, team selecting
  | 'frozen' // ended (time up / out of lives / complete), before resolution
  | 'resolving' // admin revealing groups + asking connections
  | 'done'; // scored, waiting for the other team's wall or round end

export type WallEndReason = 'complete' | 'lives' | 'time' | null;

export interface WallTile {
  /** Stable tile id within this wall (0..15, in the *shuffled* display order). */
  id: number;
  text: string;
  /** Index of the group this tile belongs to (0..3). Stripped from public state until solved/revealed. */
  group: number;
}

export interface WallGroupState {
  index: number; // 0..3 in the pack
  connection: string; // stripped from public state until revealed
  /** Order in which it was solved/revealed (0..3) → colour index; null until then. */
  solvedOrder: number | null;
  foundByTeam: boolean;
  connectionRevealed: boolean;
  connectionCorrect: boolean | null;
}

export interface WallPlay {
  wallId: string;
  team: TeamId;
  stage: WallStage;
  seed: number;
  tiles: WallTile[];
  groups: WallGroupState[];
  /** Tile ids currently selected (max 4). */
  selected: number[];
  /** Last wrong guess tile ids, for the flash animation; cleared on next select. */
  lastWrong: number[] | null;
  /** Lives remaining once 2 groups are found; null before that (unlimited). */
  lives: number | null;
  startedAt: number | null;
  endsAt: number | null;
  endReason: WallEndReason;
  /**
   * Server time (ms) at which the wall froze (complete / out of lives / time up), so timers can stay where
   * they stopped. Optional (additive): states persisted before this field existed are read as `null`.
   */
  endedAt?: number | null;
  /** Which group the admin is currently asking the connection for during resolution. */
  resolvingGroup: number | null;
  /** Points awarded when `done` (null before). */
  awarded: null | { groups: number; connections: number; bonus: number; total: number };
}

/**
 * The wall round works like the question rounds: the pack's walls are shown as a hieroglyph grid, the team
 * whose turn it is chooses one (the admin clicks it, `wall:select`), plays it, and after `wall:clear` the other
 * team chooses from what is left. Teams strictly alternate (A, B with 2 walls; A, B, A, B with 4).
 */
export interface WallRoundState {
  /** `selecting`: the glyph grid is shown and `team` is choosing; `playing`: `current` is on screen. */
  stage: 'selecting' | 'playing';
  /** The team choosing (in `selecting`) and then playing (in `playing`) the current wall. */
  team: TeamId;
  /** The hieroglyphs of this pack's walls (the grid), in HIEROGLYPHS order. */
  available: Hieroglyph[];
  /** Walls already chosen (the one on screen included), in the order they were chosen. */
  used: Hieroglyph[];
  /** The wall currently on screen, or null while selecting. */
  current: WallPlay | null;
  /** Walls played to the end (scored and cleared). */
  wallsDone: number;
  /** Number of walls in the pack (= available.length); the round ends when every one has been chosen and played. */
  wallsTotal: number;
}

export type VowelsStage =
  | 'category' // category bar shown, no clue yet
  | 'clue' // clue shown, buzzers open
  | 'buzzed' // someone buzzed, admin judging
  | 'other' // buzzer was wrong, other team may answer
  | 'answer'; // answer revealed, waiting for next

export interface VowelsRoundState {
  stage: VowelsStage;
  groupIndex: number; // into pack.vowelGroups
  clueIndex: number; // into group.clues
  /** Set when stage is buzzed/other/answer. */
  buzz: null | { playerId: string; playerName: string; team: TeamId; at: number };
  /** Outcome for the current clue. */
  result: null | { team: TeamId | null; delta: Record<TeamId, number> };
  /** Players who already buzzed (and were wrong) on this clue are locked out. */
  lockedPlayers: string[];
}

export interface GameState {
  id: string;
  packId: string;
  pack: Pack;
  createdAt: number;
  updatedAt: number;
  phase: Phase;
  teams: Record<TeamId, Team>;
  players: Player[];
  /** Which team started round 1; round 2 starts with the other team. */
  firstTeam: TeamId;
  question: QuestionRoundState | null;
  wall: WallRoundState | null;
  vowels: VowelsRoundState | null;
  /** Monotonic counter, incremented on every applied action (clients can detect staleness). */
  version: number;
  /** For audio clues: the media key the monitor should (re)play, and a nonce so repeats re-trigger. */
  playMedia: null | { key: string; nonce: number };
  /**
   * Show cue the monitor should play (`cue:play`), with a nonce so repeats re-trigger; `cue:stop` (or a new
   * game) sets it to null. Optional (additive): a missing value means no cue.
   */
  cue?: null | { name: CueName; nonce: number };
  /**
   * Rounds that have been played to completion. A finished round cannot be restarted (SPEC §10); the engine
   * needs this because `question`/`wall`/`vowels` are replaced when the next round starts. Optional (additive)
   * so states built without it are still valid: the engine treats a missing value as `[]`.
   */
  finishedRounds?: RoundName[];
  /**
   * Progress of rounds that were left before they finished (`round:start` of another round, `game:lobby`,
   * `round:final`). `round:start` of such a round resumes it instead of starting from scratch. Optional
   * (additive); a missing value means nothing is suspended.
   */
  suspended?: Partial<{ connections: QuestionRoundState; sequences: QuestionRoundState; wall: WallRoundState; vowels: VowelsRoundState }>;
  /**
   * Ids of players removed by the host (`game:removePlayer`); a `player:join` with one of them fails with
   * `player_removed` instead of silently re-creating the player. Optional (additive).
   */
  removedPlayers?: string[];
  /**
   * Set by the host (not the engine): the type of the last admin action that `game:undo` would revert, or
   * null when there is nothing to undo. Informational for the admin console.
   */
  undoable?: AdminAction['type'] | null;
}

// ---------------------------------------------------------------------------
// Public projection (what the monitor / wall / button screens receive)
// ---------------------------------------------------------------------------

export interface PublicClue {
  kind: ClueKind;
  /** Null until revealed. For media clues the caption is only sent once the answer stage is reached. */
  text: string | null;
  /** Media url, present as soon as the clue is revealed. */
  mediaUrl: string | null;
  revealed: boolean;
}

export interface PublicQuestionRoundState {
  round: QuestionRound;
  stage: QuestionStage;
  team: TeamId;
  /** The grid: hieroglyphs of this round's questions, in HIEROGLYPHS order. */
  available: Hieroglyph[];
  used: Hieroglyph[];
  hieroglyph: Hieroglyph | null;
  clues: PublicClue[]; // always 4 entries when a question is live, else []
  revealed: number;
  pointsOnOffer: number;
  /** Null until the answer stage. */
  answer: string | null;
  result: QuestionRoundState['result'];
  questionsDone: number;
  questionsTotal: number;
  /** The 40 s clock: null while selecting / judged (see QuestionRoundState). */
  startedAt: number | null;
  endsAt: number | null;
  timeUp: boolean;
}

export interface PublicWallTile {
  id: number;
  text: string;
  /** Group index if solved/revealed, else null. */
  group: number | null;
  /** Colour index (solve order) if solved/revealed, else null. */
  colour: number | null;
}

export interface PublicWallGroup {
  index: number;
  solvedOrder: number | null;
  foundByTeam: boolean;
  /** Null until revealed. */
  connection: string | null;
  connectionCorrect: boolean | null;
}

export interface PublicWallPlay {
  team: TeamId;
  stage: WallStage;
  /**
   * The 16 tiles — but **empty while `stage` is `ready`** (V3): the audience and the wall panel must not see
   * the wall before the host starts the clock; `wall:start` sends the tiles to both at the same time.
   */
  tiles: PublicWallTile[];
  groups: PublicWallGroup[];
  selected: number[];
  lastWrong: number[] | null;
  lives: number | null;
  startedAt: number | null;
  endsAt: number | null;
  endReason: WallEndReason;
  /** When the wall froze (server ms), null while ready/live. */
  endedAt: number | null;
  resolvingGroup: number | null;
  awarded: WallPlay['awarded'];
}

export interface PublicWallRoundState {
  stage: WallRoundState['stage'];
  team: TeamId;
  /** The grid: hieroglyphs of this pack's walls, in HIEROGLYPHS order. */
  available: Hieroglyph[];
  used: Hieroglyph[];
  current: PublicWallPlay | null;
  wallsDone: number;
  wallsTotal: number;
}

export interface PublicVowelsRoundState {
  stage: VowelsStage;
  category: string;
  /** Vowel-stripped clue, null in `category` stage. */
  display: string | null;
  /** Full answer, null until `answer` stage. */
  answer: string | null;
  buzz: VowelsRoundState['buzz'];
  result: VowelsRoundState['result'];
  lockedPlayers: string[];
  clueNumber: number; // 1-based within the category
  clueCount: number;
  groupNumber: number; // 1-based
  groupCount: number;
}

export interface PublicGameState {
  id: string;
  phase: Phase;
  packName: string;
  teams: Record<TeamId, Team>;
  players: Player[];
  question: PublicQuestionRoundState | null;
  wall: PublicWallRoundState | null;
  vowels: PublicVowelsRoundState | null;
  version: number;
  playMedia: GameState['playMedia'];
  /** Show cue to play (see GameState.cue); null when none. */
  cue: null | { name: CueName; nonce: number };
  /** Server clock (ms) at broadcast time, so clients can compute offsets for timers. */
  serverNow: number;
}

/** What the server sends when there is no game at all. */
export interface NoGameState {
  id: null;
  phase: 'none';
  serverNow: number;
}

export type PublicStateMessage = PublicGameState | NoGameState;

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** Actions only the game master may send (REST /api/admin/actions). */
export type AdminAction =
  | { type: 'game:new'; packId: string; teams: Record<TeamId, { name: string }>; firstTeam: TeamId }
  | { type: 'game:setTeamName'; team: TeamId; name: string }
  | { type: 'game:adjustScore'; team: TeamId; delta: number }
  | { type: 'game:removePlayer'; playerId: string }
  | { type: 'game:lobby' } // back to lobby screen (keeps scores)
  | { type: 'game:undo' } // host-handled (not the engine): revert the last admin action
  | { type: 'round:start'; round: 'connections' | 'sequences' | 'wall' | 'vowels' } // resumes a suspended round
  | { type: 'q:select'; hieroglyph: Hieroglyph }
  | { type: 'q:reveal' }
  | { type: 'q:correct' }
  | { type: 'q:incorrect' } // also used for "pass"
  | { type: 'q:stealCorrect' }
  | { type: 'q:stealIncorrect' }
  | { type: 'q:void' } // broken question: no points, no steal, nothing revealed; counts as played
  | { type: 'q:timeUp' } // the 40 s clock ran out (sent by the server timer; also allowed from admin, early)
  | { type: 'q:next' }
  | { type: 'wall:select'; hieroglyph: Hieroglyph } // the choosing team picks a wall by its glyph -> on screen in `ready` stage
  | { type: 'wall:start' } // starts the timer, panel goes live
  | { type: 'wall:timeUp' } // sent by the server timer (also allowed from admin)
  | { type: 'wall:abort' } // hand an unfinished wall back (ready/live/frozen/resolving): off screen, glyph available again, nothing awarded
  | { type: 'wall:resolve' } // frozen -> resolving (reveals remaining groups)
  | { type: 'wall:connectionCorrect' }
  | { type: 'wall:connectionIncorrect' }
  | { type: 'wall:finish' } // award points, stage done
  | { type: 'wall:clear' } // remove current wall from screen (after done); the other team chooses next
  | { type: 'vowels:showClue' } // category -> clue (buzzers open)
  | { type: 'vowels:correct' }
  | { type: 'vowels:incorrect' }
  | { type: 'vowels:otherCorrect' }
  | { type: 'vowels:nobody' }
  | { type: 'vowels:reopen' } // reopen buzzers on the same clue (e.g. false buzz)
  | { type: 'vowels:next' } // next clue / next category
  | { type: 'vowels:skipCategory' }
  | { type: 'round:final' }
  | { type: 'media:play'; clueIndex?: number } // replay an audio clue (default: the last visible one)
  | { type: 'media:stop' }
  | { type: 'cue:play'; cue: CueName } // play a show cue (opening titles music / opening clip) on the monitor
  | { type: 'cue:stop' }; // stop / hide the cue

/**
 * Actions originating from players / the wall panel (socket). `wall:select {tileId}` (a tile tap) shares its
 * type name with the admin's `wall:select {hieroglyph}` (choosing a wall): the engine tells them apart by the
 * payload, and the host must build the tile action itself from the validated tap (never pass a socket payload
 * through) so a phone can never choose a wall.
 */
export type PlayerAction =
  | { type: 'player:join'; playerId: string; name: string; team: TeamId; secret?: string }
  | { type: 'player:leave'; playerId: string }
  | { type: 'player:connected'; playerId: string; connected: boolean }
  | { type: 'player:buzz'; playerId: string }
  | { type: 'wall:select'; tileId: number };

export type GameAction = AdminAction | PlayerAction;

export interface ActionContext {
  /** ms since epoch */
  now: number;
  /** Random seed for shuffles (the engine must be deterministic given the seed). */
  seed: number;
  /** Returns a fresh id (uuid) — provided by the host. */
  newId: () => string;
}

export class GameError extends Error {
  readonly code: string;
  constructor(message: string, code = 'invalid_action') {
    super(message);
    this.name = 'GameError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Socket contract
// ---------------------------------------------------------------------------

export interface Ack<T = undefined> {
  ok: boolean;
  error?: string;
  /** Machine-readable reason for a failure (a `GameError` code such as `buzz_lost`, `wall_time_up`). */
  code?: string;
  data?: T;
}

/** Namespace "/" — monitor, wall, button */
export interface ClientToServerEvents {
  /**
   * Join as a new player (`playerId: null`) or rejoin an existing one (`playerId` + the `secret` from the
   * earlier ack). The ack returns both; the client keeps them in localStorage. Failure codes: `not_owner`
   * (id exists, wrong secret), `player_removed` (kicked by the host), `game_full`, `team_locked`.
   */
  'player:join': (
    payload: { playerId: string | null; secret?: string | null; name: string; team: TeamId },
    ack: (res: Ack<{ playerId: string; secret: string }>) => void,
  ) => void;
  /** Leaves as the player this socket joined as (the payload id is ignored). */
  'player:leave': (payload: { playerId: string }, ack: (res: Ack) => void) => void;
  /** Buzzes as the player this socket joined as (the payload id is ignored; `not_joined` when none). */
  'player:buzz': (payload: { playerId: string }, ack: (res: Ack<{ won: boolean }>) => void) => void;
  'wall:select': (payload: { tileId: number }, ack: (res: Ack) => void) => void;
}

export interface ServerToClientEvents {
  state: (state: PublicStateMessage) => void;
}

/** Namespace "/admin" — requires `auth.token` in the handshake */
export interface AdminServerToClientEvents {
  state: (state: GameState | null) => void;
}

// ---------------------------------------------------------------------------
// Auth / misc API payloads
// ---------------------------------------------------------------------------

export interface LoginRequest {
  username: string;
  password: string;
}
export interface LoginResponse {
  token: string;
  expiresAt: string;
}
export interface ApiError {
  error: string;
  code?: string;
}
