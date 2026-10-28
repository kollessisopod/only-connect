/**
 * Public engine API (SPEC §10). Pure, synchronous, deterministic. Never mutates inputs.
 */
export {
  createGame,
  applyAction,
  allowedActions,
  describeState,
  isBusy,
  canStartRound,
  canGoFinal,
  winningTeam,
  roundProgress,
  isRoundSuspended,
} from './game.js';
export {
  activeTeams,
  isActiveTeam,
  normalizeGameState,
  previousRoundOrder,
  suggestedRoundOrder,
  validateRoundOrder,
  teamStandings,
  questionOrder,
  wallOrder,
  vowelsOrder,
} from './teams.js';
export { deltaRecord } from './common.js';
export { projectPublic } from './project.js';
export { validatePack } from './validate.js';
export { stripVowels } from './vowels-text.js';
export { shuffleWithSeed, mulberry32, hashString } from './random.js';
export {
  wallSecondsRemaining,
  computeAwarded,
  buildWallPlay,
  packWalls,
  wallHieroglyphs,
  wallByHieroglyph,
  nextWallHieroglyph,
  wallsTotalFor,
  teamForWall,
  selectableWallHieroglyphs,
  WALL_MS,
} from './wall.js';
export {
  isClueVisible,
  currentAudioClue,
  visibleAudioClues,
  maxCluesFor,
  teamForQuestion,
  stealCandidates,
  roundQuestions,
  roundHieroglyphs,
  questionSecondsRemaining,
  questionClockRunning,
  questionClockStarted,
  questionIntroPhase,
  QUESTION_MS,
  type QuestionClock,
  type QuestionIntroPhase,
} from './questions.js';
export { isLastVowelClue, currentVowelClue, currentVowelGroup, otherAnswerCandidates } from './vowels.js';
export { buildDemoPack, DEMO_MEDIA_PREFIX, type DemoPackOptions } from './demo-pack.js';
