/**
 * Public projection: what the monitor, wall panel and buzzer phones are allowed to see. SPEC §4, §10.
 *
 * Every object is built field by field — nothing from the full state is spread into the output — so a new
 * field in GameState can never leak by accident.
 */
import {
  DEFAULT_TEAM_NAMES,
  TEAM_IDS,
  type GameState,
  type PublicClue,
  type PublicGameState,
  type PublicQuestionRoundState,
  type PublicVowelsRoundState,
  type PublicWallGroup,
  type PublicWallPlay,
  type PublicWallRoundState,
  type PublicWallTile,
  type Team,
  type TeamId,
} from '../types.js';
import { deltaRecord } from './common.js';
import { findQuestion, isClueVisible } from './questions.js';
import { activeTeams, questionOrder, vowelsOrder, wallOrder } from './teams.js';
import { currentVowelClue, currentVowelGroup } from './vowels.js';

/** All four teams, idle ones included (a state persisted before V3.2 holds two: the rest get defaults). */
function projectTeams(state: GameState): Record<TeamId, Team> {
  const out = {} as Record<TeamId, Team>;
  for (const id of TEAM_IDS) {
    const team = state.teams[id];
    out[id] = team ? { id, name: team.name, score: team.score } : { id, name: DEFAULT_TEAM_NAMES[id], score: 0 };
  }
  return out;
}

function projectQuestion(state: GameState): PublicQuestionRoundState | null {
  const qs = state.question;
  if (!qs || (state.phase !== 'connections' && state.phase !== 'sequences')) return null;
  const q = findQuestion(state, qs.questionId);
  const answerStage = qs.stage === 'answer';
  const clues: PublicClue[] = q
    ? q.clues.map((clue, i) => {
        const revealed = isClueVisible(qs, i);
        if (!revealed) return { kind: clue.kind, text: null, mediaUrl: null, revealed: false };
        const isMedia = clue.kind !== 'text';
        return {
          kind: clue.kind,
          // Captions of media clues are only shown once the answer is up.
          text: isMedia && !answerStage ? null : clue.text,
          mediaUrl: isMedia && clue.media ? clue.media.url : null,
          revealed: true,
        };
      })
    : [];
  return {
    round: qs.round,
    stage: qs.stage,
    // Always resolved (a state persisted before V3.2 has no `order`).
    order: questionOrder(state, qs),
    team: qs.team,
    available: [...qs.available],
    used: [...qs.used],
    hieroglyph: q ? q.hieroglyph : null,
    clues,
    revealed: qs.revealed,
    pointsOnOffer: qs.pointsOnOffer,
    answer: answerStage && q ? q.answer : null,
    result: qs.result ? { ...qs.result } : null,
    questionsDone: qs.questionsDone,
    questionsTotal: qs.questionsTotal,
    // The 40 s clock (V3); states persisted before it have no clock.
    startedAt: qs.startedAt ?? null,
    endsAt: qs.endsAt ?? null,
    timeUp: qs.timeUp === true,
  };
}

function projectWallPlay(state: GameState): PublicWallPlay | null {
  const play = state.wall?.current;
  if (!play) return null;
  const solvedOrderOf = new Map<number, number>();
  for (const g of play.groups) if (g.solvedOrder !== null) solvedOrderOf.set(g.index, g.solvedOrder);
  // Nobody sees the tiles before the host starts the clock (SPEC §3.3): `wall:start` sends them to the
  // monitor and the panel in the same broadcast, so the wall appears on both at the same time.
  const tiles: PublicWallTile[] =
    play.stage === 'ready'
      ? []
      : play.tiles.map((t) => {
          const colour = solvedOrderOf.get(t.group);
          return colour === undefined
            ? { id: t.id, text: t.text, group: null, colour: null }
            : { id: t.id, text: t.text, group: t.group, colour };
        });
  const groups: PublicWallGroup[] = play.groups.map((g) => ({
    index: g.index,
    solvedOrder: g.solvedOrder,
    foundByTeam: g.foundByTeam,
    connection: g.connectionRevealed ? g.connection : null,
    connectionCorrect: g.connectionCorrect,
  }));
  return {
    team: play.team,
    stage: play.stage,
    tiles,
    groups,
    selected: [...play.selected],
    lastWrong: play.lastWrong ? [...play.lastWrong] : null,
    lives: play.lives,
    startedAt: play.startedAt,
    endsAt: play.endsAt,
    endReason: play.endReason,
    endedAt: play.endedAt ?? null,
    resolvingGroup: play.resolvingGroup,
    awarded: play.awarded ? { ...play.awarded } : null,
  };
}

function projectWall(state: GameState): PublicWallRoundState | null {
  const w = state.wall;
  if (!w || state.phase !== 'wall') return null;
  return {
    stage: w.stage,
    order: wallOrder(state, w),
    team: w.team,
    available: [...w.available],
    used: [...w.used],
    current: projectWallPlay(state),
    wallsDone: w.wallsDone,
    wallsTotal: w.wallsTotal,
  };
}

function projectVowels(state: GameState): PublicVowelsRoundState | null {
  const vs = state.vowels;
  if (!vs || state.phase !== 'vowels') return null;
  const group = currentVowelGroup(state);
  const clue = currentVowelClue(state);
  const clueVisible = vs.stage !== 'category';
  return {
    order: vowelsOrder(state, vs),
    stage: vs.stage,
    category: group ? group.category : '',
    display: clueVisible && clue ? clue.display : null,
    answer: vs.stage === 'answer' && clue ? clue.answer : null,
    buzz: vs.buzz ? { ...vs.buzz } : null,
    // The delta is completed over all four teams (a result persisted before V3.2 holds two keys).
    result: vs.result ? { team: vs.result.team, delta: deltaRecord(vs.result.delta ?? {}) } : null,
    lockedPlayers: [...vs.lockedPlayers],
    clueNumber: vs.clueIndex + 1,
    clueCount: group ? group.clues.length : 0,
    groupNumber: vs.groupIndex + 1,
    groupCount: state.pack.vowelGroups.length,
  };
}

/** Strip everything the audience must not see. `now` becomes `serverNow`. */
export function projectPublic(state: GameState, now: number): PublicGameState {
  return {
    id: state.id,
    phase: state.phase,
    packName: state.pack.name,
    teams: projectTeams(state),
    activeTeams: activeTeams(state),
    players: state.players.map((p) => ({
      id: p.id,
      name: p.name,
      team: p.team,
      connected: p.connected,
      joinedAt: p.joinedAt,
    })),
    question: projectQuestion(state),
    wall: projectWall(state),
    vowels: projectVowels(state),
    version: state.version,
    playMedia: state.playMedia ? { key: state.playMedia.key, nonce: state.playMedia.nonce } : null,
    cue: state.cue ? { name: state.cue.name, nonce: state.cue.nonce } : null,
    serverNow: now,
  };
}
