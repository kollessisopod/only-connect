/**
 * Game lifecycle: createGame, the applyAction dispatcher, allowedActions and describeState. SPEC §4, §10.
 */
import {
  MAX_PLAYERS,
  TEAM_IDS,
  type ActionContext,
  type AdminAction,
  type GameAction,
  type GameState,
  type Pack,
  type Player,
  type RoundName,
  type Team,
  type TeamId,
} from '../types.js';
import { addScore, fail, finishedRounds, isRoundFinished, withPlayMedia } from './common.js';
import {
  allowedQuestionActions,
  currentAudioClue,
  findQuestion,
  isMidQuestion,
  judgeCorrect as qCorrect,
  judgeIncorrect as qIncorrect,
  judgeStealCorrect,
  judgeStealIncorrect,
  nextQuestion,
  revealClue,
  selectHieroglyph,
  startQuestionRound,
  visibleAudioClues,
  voidQuestion,
} from './questions.js';
import { validatePack } from './validate.js';
import {
  abortWall,
  allowedWallActions,
  assignWall,
  clearWall,
  connectionCorrect,
  connectionIncorrect,
  finishWall,
  isMidWall,
  resolveWall,
  selectTile,
  showWall,
  startWall,
  startWallRound,
  wallTimeUp,
} from './wall.js';
import {
  allowedVowelsActions,
  buzz,
  currentVowelClue,
  currentVowelGroup,
  isLastVowelClue,
  isMidVowels,
  judgeCorrect as vCorrect,
  judgeIncorrect as vIncorrect,
  judgeNobody,
  judgeOtherCorrect,
  nextClue,
  reopen,
  showClue,
  skipCategory,
  startVowelsRound,
} from './vowels.js';

const ROUNDS: readonly RoundName[] = ['connections', 'sequences', 'wall', 'vowels'];

function cleanName(name: unknown, fallback: string): string {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  return trimmed.length > 0 ? trimmed : fallback;
}

/** Build a fresh game from a playable pack. Throws GameError if validatePack(pack) has problems. */
export function createGame(
  pack: Pack,
  teams: Record<TeamId, { name: string }>,
  firstTeam: TeamId,
  ctx: ActionContext,
): GameState {
  const problems = validatePack(pack);
  if (problems.length > 0) fail(`pack is not playable: ${problems.join('; ')}`, 'unplayable_pack');
  if (!TEAM_IDS.includes(firstTeam)) fail('firstTeam must be pink or blue');
  const defaults: Record<TeamId, string> = { pink: 'Pink', blue: 'Blue' };
  const teamRecord = {} as Record<TeamId, Team>;
  for (const id of TEAM_IDS) {
    const given: { name: string } | undefined = teams ? teams[id] : undefined;
    teamRecord[id] = { id, name: cleanName(given?.name, defaults[id]), score: 0 };
  }
  return {
    id: ctx.newId(),
    packId: pack.id,
    pack,
    createdAt: ctx.now,
    updatedAt: ctx.now,
    phase: 'lobby',
    teams: teamRecord,
    players: [],
    firstTeam,
    question: null,
    wall: null,
    vowels: null,
    version: 0,
    playMedia: null,
    finishedRounds: [],
  };
}

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

/** True while something is happening that must not be abandoned (a live question, wall or buzz). */
export function isBusy(state: GameState): boolean {
  return isMidQuestion(state) || isMidWall(state) || isMidVowels(state);
}

export function canStartRound(state: GameState, round: RoundName): boolean {
  if (!ROUNDS.includes(round)) return false;
  if (isRoundFinished(state, round)) return false;
  if (state.phase === round) return false; // already in progress: nothing to start (and nothing to wipe)
  if (isBusy(state)) return false;
  if (round === 'vowels' && state.pack.vowelGroups.length === 0) return false;
  return true;
}

/** True when `round` was left before it finished and `round:start` would resume it where it was. */
export function isRoundSuspended(state: GameState, round: RoundName): boolean {
  return state.suspended?.[round] !== undefined;
}

/**
 * How far the round currently on screen has got, for "are you sure?" prompts: `null` when nothing would be
 * lost by leaving it (nothing played yet, or the round is finished), else a short description.
 */
export function roundProgress(state: GameState): string | null {
  switch (state.phase) {
    case 'connections':
    case 'sequences': {
      const qs = state.question;
      if (!qs || isRoundFinished(state, state.phase) || qs.used.length === 0) return null;
      return `${qs.questionsDone} of 6 questions played`;
    }
    case 'wall': {
      const w = state.wall;
      if (!w || isRoundFinished(state, 'wall')) return null;
      if (w.current) return `${state.teams[w.current.team].name}'s wall is on screen (${w.current.stage})`;
      if (w.completed.length > 0) return `${w.completed.map((t) => state.teams[t].name).join(', ')} already played their wall`;
      return null;
    }
    case 'vowels': {
      const vs = state.vowels;
      if (!vs || isRoundFinished(state, 'vowels')) return null;
      if (vs.groupIndex === 0 && vs.clueIndex === 0 && vs.stage === 'category') return null;
      return `category ${vs.groupIndex + 1}, clue ${vs.clueIndex + 1}`;
    }
    default:
      return null;
  }
}

/** Progress of the round on screen, stored under `suspended` so `round:start` can bring it back. */
function suspendCurrentRound(state: GameState): GameState {
  if (roundProgress(state) === null) return state;
  const suspended = { ...(state.suspended ?? {}) };
  switch (state.phase) {
    case 'connections':
    case 'sequences':
      if (state.question) suspended[state.phase] = state.question;
      break;
    case 'wall':
      if (state.wall) suspended.wall = state.wall;
      break;
    case 'vowels':
      if (state.vowels) suspended.vowels = state.vowels;
      break;
    default:
      return state;
  }
  return { ...state, suspended };
}

function resumeRound(state: GameState, round: RoundName): GameState | null {
  const saved = state.suspended?.[round];
  if (!saved) return null;
  const suspended = { ...(state.suspended ?? {}) };
  delete suspended[round];
  const base: GameState = withPlayMedia({ ...state, phase: round, question: null, wall: null, vowels: null, suspended }, null);
  switch (round) {
    case 'connections':
    case 'sequences':
      return { ...base, question: saved as GameState['question'] };
    case 'wall':
      return { ...base, wall: saved as GameState['wall'] };
    case 'vowels': {
      const vs = saved as NonNullable<GameState['vowels']>;
      // Buzzers never reopen by themselves: a clue that was live comes back as its category bar.
      return { ...base, vowels: vs.stage === 'clue' ? { ...vs, stage: 'category', buzz: null, result: null, lockedPlayers: [] } : vs };
    }
    default:
      return null;
  }
}

export function canGoFinal(state: GameState): boolean {
  if (state.phase === 'final') return false;
  if (isBusy(state)) return false;
  return state.phase === 'vowels' || finishedRounds(state).length > 0;
}

function roundsThatCanStart(state: GameState): RoundName[] {
  return ROUNDS.filter((r) => canStartRound(state, r));
}

/** Admin action types that are valid right now (used to enable/disable buttons in /admin). */
export function allowedActions(state: GameState): AdminAction['type'][] {
  const out: AdminAction['type'][] = ['game:new', 'game:setTeamName', 'game:adjustScore'];
  if (state.players.length > 0) out.push('game:removePlayer');
  if (state.phase !== 'lobby') out.push('game:lobby');
  if (roundsThatCanStart(state).length > 0) out.push('round:start');
  out.push(...allowedQuestionActions(state));
  out.push(...allowedWallActions(state));
  out.push(...allowedVowelsActions(state));
  if (canGoFinal(state)) out.push('round:final');
  if (currentAudioClue(state)) out.push('media:play');
  if (state.playMedia !== null) out.push('media:stop');
  return out;
}

// ---------------------------------------------------------------------------
// Simple reducers (players, scores, lobby, final, media)
// ---------------------------------------------------------------------------

/**
 * Join or rejoin. An existing id is only accepted with the secret it was created with (the id is public,
 * the secret is not); an unknown id creates the player (the host has no say in ids, so a phone keeps its
 * id across games). Ids removed by the host are refused, the player cap is enforced, and a player cannot
 * switch teams while Missing Vowels is being played.
 */
function joinPlayer(state: GameState, playerId: string, name: string, team: TeamId, secret: string | undefined, ctx: ActionContext): GameState {
  if (typeof playerId !== 'string' || playerId.length === 0) fail('playerId is required');
  if (!TEAM_IDS.includes(team)) fail('team must be pink or blue');
  const cleaned = cleanName(name, '');
  if (!cleaned) fail('name is required');
  if ((state.removedPlayers ?? []).includes(playerId)) fail('the host removed you from the game', 'player_removed');
  const existing = state.players.find((p) => p.id === playerId);
  if (existing) {
    if (existing.secret !== undefined && existing.secret !== secret) fail('that player belongs to another device', 'not_owner');
    if (state.phase === 'vowels' && existing.team !== team) fail('teams cannot be changed during Missing Vowels', 'team_locked');
    const players = state.players.map((p) => {
      if (p.id !== playerId) return p;
      const next: Player = { ...p, name: cleaned, team, connected: true };
      if (p.secret === undefined && secret !== undefined) next.secret = secret;
      return next;
    });
    return { ...state, players };
  }
  if (state.players.length >= MAX_PLAYERS) fail(`the game is full (${MAX_PLAYERS} players)`, 'game_full');
  const player: Player = { id: playerId, name: cleaned, team, connected: true, joinedAt: ctx.now };
  if (secret !== undefined) player.secret = secret;
  return { ...state, players: [...state.players, player] };
}

function removePlayer(state: GameState, playerId: string): GameState {
  if (!state.players.some((p) => p.id === playerId)) fail('unknown player', 'unknown_player');
  return { ...state, players: state.players.filter((p) => p.id !== playerId) };
}

/** The host kicked the player: remembered so a reconnecting phone does not silently re-create it. */
function kickPlayer(state: GameState, playerId: string): GameState {
  const next = removePlayer(state, playerId);
  const removed = next.removedPlayers ?? [];
  return { ...next, removedPlayers: removed.includes(playerId) ? removed : [...removed, playerId] };
}

function setConnected(state: GameState, playerId: string, connected: boolean): GameState {
  if (!state.players.some((p) => p.id === playerId)) fail('unknown player', 'unknown_player');
  return { ...state, players: state.players.map((p) => (p.id === playerId ? { ...p, connected } : p)) };
}

function setTeamName(state: GameState, team: TeamId, name: string): GameState {
  if (!TEAM_IDS.includes(team)) fail('team must be pink or blue');
  const cleaned = cleanName(name, '');
  if (!cleaned) fail('team name must not be empty');
  return { ...state, teams: { ...state.teams, [team]: { ...state.teams[team], name: cleaned } } };
}

function adjustScore(state: GameState, team: TeamId, delta: number): GameState {
  if (!TEAM_IDS.includes(team)) fail('team must be pink or blue');
  if (!Number.isInteger(delta)) fail('delta must be an integer');
  return addScore(state, team, delta);
}

function goLobby(state: GameState): GameState {
  if (state.phase === 'lobby') fail('already in the lobby');
  const kept = suspendCurrentRound(state);
  return withPlayMedia({ ...kept, phase: 'lobby', question: null, wall: null, vowels: null }, null);
}

function startRound(state: GameState, round: RoundName): GameState {
  if (!ROUNDS.includes(round)) fail(`unknown round "${String(round)}"`);
  if (isRoundFinished(state, round)) fail(`the ${round} round has already been played`);
  if (state.phase === round) fail(`the ${round} round is already in progress`);
  if (isBusy(state)) fail('finish the current question first');
  const kept = suspendCurrentRound(state);
  const resumed = resumeRound(kept, round);
  if (resumed) return resumed;
  switch (round) {
    case 'connections':
    case 'sequences':
      return startQuestionRound(kept, round);
    case 'wall':
      return startWallRound(kept);
    case 'vowels':
      return startVowelsRound(kept);
    default:
      return fail('unknown round');
  }
}

function goFinal(state: GameState): GameState {
  if (!canGoFinal(state)) fail('the final cannot be shown yet');
  const kept = suspendCurrentRound(state);
  return withPlayMedia({ ...kept, phase: 'final', question: null, wall: null, vowels: null }, null);
}

function playMedia(state: GameState, clueIndex: number | undefined): GameState {
  const visible = visibleAudioClues(state);
  const pick = clueIndex === undefined ? visible[visible.length - 1] : visible.find((v) => v.index === clueIndex);
  if (!pick || !pick.clue.media) fail(clueIndex === undefined ? 'no audio clue is on screen' : `clue ${clueIndex + 1} is not a visible audio clue`);
  return withPlayMedia(state, pick.clue.media.key);
}

function stopMedia(state: GameState): GameState {
  if (state.playMedia === null) fail('nothing is playing');
  return withPlayMedia(state, null);
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

function reduce(state: GameState, action: GameAction, ctx: ActionContext): GameState {
  switch (action.type) {
    case 'game:new':
      return fail('game:new is handled by the host (createGame)');
    case 'game:setTeamName':
      return setTeamName(state, action.team, action.name);
    case 'game:adjustScore':
      return adjustScore(state, action.team, action.delta);
    case 'game:removePlayer':
      return kickPlayer(state, action.playerId);
    case 'game:lobby':
      return goLobby(state);
    case 'game:undo':
      return fail('game:undo is handled by the host');
    case 'round:start':
      return startRound(state, action.round);
    case 'q:select':
      return selectHieroglyph(state, action.hieroglyph);
    case 'q:reveal':
      return revealClue(state);
    case 'q:correct':
      return qCorrect(state);
    case 'q:incorrect':
      return qIncorrect(state);
    case 'q:stealCorrect':
      return judgeStealCorrect(state);
    case 'q:stealIncorrect':
      return judgeStealIncorrect(state);
    case 'q:void':
      return voidQuestion(state);
    case 'q:next':
      return nextQuestion(state);
    case 'wall:assign':
      return assignWall(state, action.team, action.wallId);
    case 'wall:show':
      return showWall(state, action.team, ctx);
    case 'wall:start':
      return startWall(state, ctx);
    case 'wall:timeUp':
      return wallTimeUp(state, ctx);
    case 'wall:abort':
      return abortWall(state);
    case 'wall:resolve':
      return resolveWall(state);
    case 'wall:connectionCorrect':
      return connectionCorrect(state);
    case 'wall:connectionIncorrect':
      return connectionIncorrect(state);
    case 'wall:finish':
      return finishWall(state);
    case 'wall:clear':
      return clearWall(state);
    case 'vowels:showClue':
      return showClue(state);
    case 'vowels:correct':
      return vCorrect(state);
    case 'vowels:incorrect':
      return vIncorrect(state);
    case 'vowels:otherCorrect':
      return judgeOtherCorrect(state);
    case 'vowels:nobody':
      return judgeNobody(state);
    case 'vowels:reopen':
      return reopen(state);
    case 'vowels:next':
      return nextClue(state);
    case 'vowels:skipCategory':
      return skipCategory(state);
    case 'round:final':
      return goFinal(state);
    case 'media:play':
      return playMedia(state, action.clueIndex);
    case 'media:stop':
      return stopMedia(state);
    case 'player:join':
      return joinPlayer(state, action.playerId, action.name, action.team, action.secret, ctx);
    case 'player:leave':
      return removePlayer(state, action.playerId);
    case 'player:connected':
      return setConnected(state, action.playerId, action.connected);
    case 'player:buzz':
      return buzz(state, action.playerId, ctx);
    case 'wall:select':
      return selectTile(state, action.tileId, ctx);
    default:
      return fail(`unknown action "${String((action as { type?: unknown }).type)}"`);
  }
}

/**
 * Apply any action except `game:new`. Throws GameError when the action is not allowed in the current state.
 * Always bumps `version` and sets `updatedAt = ctx.now`. Never mutates `state`.
 */
export function applyAction(state: GameState, action: GameAction, ctx: ActionContext): GameState {
  if (!action || typeof action !== 'object' || typeof (action as { type?: unknown }).type !== 'string') {
    fail('malformed action');
  }
  const next = reduce(state, action, ctx);
  return { ...next, version: state.version + 1, updatedAt: ctx.now };
}

// ---------------------------------------------------------------------------
// describeState
// ---------------------------------------------------------------------------

const ROUND_TITLES: Record<RoundName, string> = {
  connections: 'Connections',
  sequences: 'Sequences',
  wall: 'Connecting Wall',
  vowels: 'Missing Vowels',
};

function pluralPoints(n: number): string {
  return `${n} point${n === 1 ? '' : 's'}`;
}

function secondsLabel(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Human readable description of the current state for the admin console. */
export function describeState(state: GameState): string {
  const name = (t: TeamId) => state.teams[t].name;
  switch (state.phase) {
    case 'lobby': {
      const played = finishedRounds(state);
      const paused = ROUNDS.filter((r) => isRoundSuspended(state, r));
      const parts: string[] = [];
      if (played.length > 0) parts.push(`played: ${played.map((r) => ROUND_TITLES[r]).join(', ')}`);
      if (paused.length > 0) parts.push(`paused: ${paused.map((r) => ROUND_TITLES[r]).join(', ')}`);
      return parts.length === 0 ? 'Lobby — waiting to start' : `Lobby — ${parts.join('; ')}`;
    }
    case 'connections':
    case 'sequences': {
      const qs = state.question;
      const title = ROUND_TITLES[state.phase];
      if (!qs) return title;
      const q = findQuestion(state, qs.questionId);
      const label = q ? `Q${qs.questionsDone + 1} (${q.hieroglyph})` : `Q${qs.questionsDone + 1}`;
      switch (qs.stage) {
        case 'selecting':
          return `${title} — ${name(qs.team)} to pick (${qs.questionsDone}/6 done)`;
        case 'question':
          return `${title} — ${label}: ${name(qs.team)} answering, ${qs.revealed} clue${qs.revealed === 1 ? '' : 's'} shown, ${pluralPoints(qs.pointsOnOffer)} on offer`;
        case 'steal':
          return `${title} — ${label}: ${name(otherTeamOf(qs.team))} may steal for 1 point`;
        case 'answer': {
          const r = qs.result;
          const outcome =
            r && r.winner
              ? `${name(r.winner)} +${r.points}${r.viaSteal ? ' (steal)' : ''}`
              : 'no points';
          if (qs.questionsDone >= 6) return `${title} — round over (${outcome}); start the next round`;
          return `${title} — ${label} answer shown: ${outcome}; next up ${name(otherTeamOf(qs.team))}`;
        }
        default:
          return title;
      }
    }
    case 'wall': {
      const w = state.wall;
      if (!w) return ROUND_TITLES.wall;
      const play = w.current;
      if (!play) {
        const pending = TEAM_IDS.filter((t) => !w.completed.includes(t));
        if (pending.length === 0) return 'Connecting Wall — both walls played; start the next round';
        return `Connecting Wall — choose a wall for ${pending.map(name).join(' / ')}`;
      }
      const who = name(play.team);
      switch (play.stage) {
        case 'ready':
          return `Connecting Wall — ${who}: wall on screen, waiting to start`;
        case 'live': {
          const found = play.groups.filter((g) => g.foundByTeam).length;
          const lives = play.lives === null ? '' : `, ${play.lives} lives`;
          const left = play.endsAt !== null && play.startedAt !== null ? ` (${secondsLabel(play.endsAt - play.startedAt)} total)` : '';
          return `Connecting Wall — ${who} playing: ${found}/4 groups${lives}${left}`;
        }
        case 'frozen': {
          const found = play.groups.filter((g) => g.foundByTeam).length;
          const why = play.endReason === 'complete' ? 'wall complete' : play.endReason === 'lives' ? 'out of lives' : "time's up";
          return `Connecting Wall — ${who}: ${why}, ${found}/4 groups found; resolve the wall`;
        }
        case 'resolving':
          return play.resolvingGroup === null
            ? `Connecting Wall — ${who}: all connections judged; finish to award points`
            : `Connecting Wall — ${who}: asking connection ${play.resolvingGroup + 1}/4`;
        case 'done':
          return `Connecting Wall — ${who} scored ${play.awarded?.total ?? 0}; clear the wall`;
        default:
          return ROUND_TITLES.wall;
      }
    }
    case 'vowels': {
      const vs = state.vowels;
      if (!vs) return ROUND_TITLES.vowels;
      const group = currentVowelGroup(state);
      const clue = currentVowelClue(state);
      const where = `${group?.category ?? '?'} (${vs.groupIndex + 1}/${state.pack.vowelGroups.length}), clue ${vs.clueIndex + 1}/${group?.clues.length ?? 0}`;
      switch (vs.stage) {
        case 'category':
          return `Missing Vowels — ${where}: category shown`;
        case 'clue':
          return `Missing Vowels — ${where}: buzzers open`;
        case 'buzzed':
          return `Missing Vowels — ${where}: ${vs.buzz?.playerName ?? '?'} (${vs.buzz ? name(vs.buzz.team) : '?'}) buzzed — answer is "${clue?.answer ?? ''}"`;
        case 'other':
          return `Missing Vowels — ${where}: ${vs.buzz ? name(otherTeamOf(vs.buzz.team)) : '?'} may answer — "${clue?.answer ?? ''}"`;
        case 'answer':
          return isLastVowelClue(state)
            ? `Missing Vowels — last clue done; show the final scores`
            : `Missing Vowels — ${where}: answer shown`;
        default:
          return ROUND_TITLES.vowels;
      }
    }
    case 'final': {
      const pink = state.teams.pink;
      const blue = state.teams.blue;
      if (pink.score === blue.score) return `Final — tie at ${pink.score}`;
      const winner = pink.score > blue.score ? pink : blue;
      const loser = winner === pink ? blue : pink;
      return `Final — ${winner.name} win ${winner.score}–${loser.score}`;
    }
    default:
      return String(state.phase);
  }
}

function otherTeamOf(team: TeamId): TeamId {
  return team === 'pink' ? 'blue' : 'pink';
}

/** Winner of the game (null for a tie). */
export function winningTeam(state: GameState): TeamId | null {
  const pink = state.teams.pink.score;
  const blue = state.teams.blue.score;
  if (pink === blue) return null;
  return pink > blue ? 'pink' : 'blue';
}
