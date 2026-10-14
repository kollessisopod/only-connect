/**
 * Public projection: what the monitor, wall panel and buzzer phones are allowed to see. SPEC §4, §10.
 *
 * Every object is built field by field — nothing from the full state is spread into the output — so a new
 * field in GameState can never leak by accident.
 */
import type {
  GameState,
  PublicClue,
  PublicGameState,
  PublicQuestionRoundState,
  PublicVowelsRoundState,
  PublicWallGroup,
  PublicWallPlay,
  PublicWallRoundState,
  PublicWallTile,
  Team,
  TeamId,
} from '../types.js';
import { findQuestion, isClueVisible } from './questions.js';
import { currentVowelClue, currentVowelGroup } from './vowels.js';

function projectTeams(state: GameState): Record<TeamId, Team> {
  return {
    pink: { id: 'pink', name: state.teams.pink.name, score: state.teams.pink.score },
    blue: { id: 'blue', name: state.teams.blue.name, score: state.teams.blue.score },
  };
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
  };
}

function projectWallPlay(state: GameState): PublicWallPlay | null {
  const play = state.wall?.current;
  if (!play) return null;
  const solvedOrderOf = new Map<number, number>();
  for (const g of play.groups) if (g.solvedOrder !== null) solvedOrderOf.set(g.index, g.solvedOrder);
  const tiles: PublicWallTile[] = play.tiles.map((t) => {
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
    stage: vs.stage,
    category: group ? group.category : '',
    display: clueVisible && clue ? clue.display : null,
    answer: vs.stage === 'answer' && clue ? clue.answer : null,
    buzz: vs.buzz ? { ...vs.buzz } : null,
    result: vs.result ? { team: vs.result.team, delta: { ...vs.result.delta } } : null,
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
    serverNow: now,
  };
}
