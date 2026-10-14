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
  wallOpener,
  selectableWallHieroglyphs,
  WALL_MS,
} from './wall.js';
export {
  isClueVisible,
  currentAudioClue,
  visibleAudioClues,
  maxCluesFor,
  roundOpener,
  roundQuestions,
  roundHieroglyphs,
} from './questions.js';
export { isLastVowelClue, currentVowelClue, currentVowelGroup } from './vowels.js';
export { buildDemoPack, DEMO_MEDIA_PREFIX, type DemoPackOptions } from './demo-pack.js';
