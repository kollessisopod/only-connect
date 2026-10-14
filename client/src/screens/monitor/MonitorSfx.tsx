/**
 * Sound effects for the monitor (V3, SPEC §4). Renders nothing.
 *
 * No server field says "play a sting": the effects are derived here by diffing consecutive public states, so
 * a sound belongs to exactly one state transition and a reload never replays it. The thinking-music bed is not
 * an event but a condition (a clock is running), so it is synchronised to the current state on every change
 * instead — which is also what starts it when sound gets enabled mid-question.
 *
 * Rules (see `effectsFor`): nothing plays for the first state after load, while sound is disabled (and no
 * backlog is queued from before that), or across a change of game id. The first state after a socket drop is
 * treated like the first after load: transitions that happened while the monitor was offline collapse into
 * one diff and their stings would play seconds or minutes late.
 */
import { useEffect, useRef } from 'react';
import { questionClockRunning, type PublicGameState, type PublicStateMessage } from '@only-connect/shared';
import { LoopPlayer, playSfx, preloadSfx, type SfxName } from '../../lib/sfx';

export interface MonitorSfxProps {
  state: PublicStateMessage | null;
  /** Whether sound has been enabled (the overlay was dismissed). */
  enabled: boolean;
  /** The clue-audio element MonitorAudio plays into (null until unlocked): the bed is ducked while it plays. */
  audio: HTMLAudioElement | null;
  /** True while a show cue (opening titles / clip) is playing: the bed stays silent meanwhile. */
  suspended?: boolean;
  /** Socket connection flag from usePublicState: a drop resets the diff so missed transitions stay silent. */
  connected?: boolean;
}

const ROUND_PHASES: ReadonlySet<PublicGameState['phase']> = new Set(['connections', 'sequences', 'wall', 'vowels', 'final']);

/** True while a clock the audience can see is running: the 40 s question clock or a live wall. */
export function clockRunning(state: PublicGameState): boolean {
  if ((state.phase === 'connections' || state.phase === 'sequences') && state.question) {
    return questionClockRunning(state.question);
  }
  if (state.phase === 'wall') return state.wall?.current?.stage === 'live';
  return false;
}

function groupsFound(play: NonNullable<PublicGameState['wall']>['current']): number {
  return play ? play.groups.filter((g) => g.foundByTeam).length : 0;
}

/**
 * The effects for the transition `prev` → `cur`, in play order. Pure, so the mapping can be read (and tested)
 * in one place:
 *  - `ocFlurry`: a round starts (phase changes into a round) or the final scores come up;
 *  - `solveClue`: a correct answer (the question reaches `answer` with a winner — by the team or by a steal),
 *    a wall group found;
 *  - `incorrectGroup`: an incorrect judgement (question → steal, steal → answer with no winner, a wrong buzz
 *    in Missing Vowels, the other team wrong too), a wrong wall group that cost no life;
 *  - `loseLife`: a wrong wall group that cost a life;
 *  - `timeUp`: the question clock ran out, a wall froze on time;
 *  - `wallBtnClick`: a tile selected on the wall (the fourth tap resolves the guess in the same action, so
 *    it is recognised by the selection going 3 → 0 and clicks before the result sting);
 *  - `correctVowel` / `nextVowelGame`: Missing Vowels correct answer / new category — not on the round start
 *    itself (the flurry already marks it) but on a resume from the lobby, which has no flurry.
 */
export function effectsFor(prev: PublicGameState, cur: PublicGameState): SfxName[] {
  const out: SfxName[] = [];
  if (cur.id !== prev.id) return out;

  const roundStarted = cur.phase !== prev.phase && ROUND_PHASES.has(cur.phase);
  if (roundStarted) out.push('ocFlurry');

  const pq = prev.question;
  const cq = cur.question;
  if (!roundStarted && pq && cq && (cur.phase === 'connections' || cur.phase === 'sequences')) {
    if (cq.stage === 'answer' && pq.stage !== 'answer' && cq.result?.winner) out.push('solveClue');
    else if (cq.stage === 'steal' && pq.stage === 'question') out.push('incorrectGroup');
    else if (cq.stage === 'answer' && pq.stage === 'steal' && !cq.result?.winner) out.push('incorrectGroup');
    if (cq.stage === 'question' && cq.timeUp && !pq.timeUp) out.push('timeUp');
  }

  const pw = prev.wall?.current ?? null;
  const cw = cur.wall?.current ?? null;
  if (!roundStarted && pw && cw && cur.phase === 'wall' && pw.team === cw.team && prev.wall?.wallsDone === cur.wall?.wallsDone) {
    if (cw.selected.length > pw.selected.length || (pw.selected.length === 3 && cw.selected.length === 0)) out.push('wallBtnClick');
    if (groupsFound(cw) > groupsFound(pw)) out.push('solveClue');
    if (pw.lives !== null && cw.lives !== null && cw.lives < pw.lives) out.push('loseLife');
    // A guess resolves the selection: a wrong one leaves `lastWrong` set (any later tap clears it again).
    else if (cw.lastWrong !== null && pw.selected.length > 0 && cw.selected.length === 0) out.push('incorrectGroup');
    if (cw.stage === 'frozen' && pw.stage !== 'frozen' && cw.endReason === 'time') out.push('timeUp');
  }

  const pv = prev.vowels;
  const cv = cur.vowels;
  if (cv && cur.phase === 'vowels') {
    if (roundStarted) {
      // The flurry is playing: doubling it with the category sting is noise.
    } else if (!pv) out.push('nextVowelGame');
    else {
      if (cv.groupNumber !== pv.groupNumber) out.push('nextVowelGame');
      if (cv.stage === 'answer' && pv.stage !== 'answer' && cv.result?.team) out.push('correctVowel');
      else if (
        (cv.stage === 'other' && pv.stage === 'buzzed') ||
        (cv.stage === 'answer' && (pv.stage === 'other' || pv.stage === 'buzzed') && !cv.result?.team)
      ) {
        out.push('incorrectGroup');
      }
    }
  }

  return out;
}

export function MonitorSfx({ state, enabled, audio, suspended = false, connected = true }: MonitorSfxProps) {
  const current = state && state.phase !== 'none' ? state : null;
  const prev = useRef<PublicGameState | null>(null);
  const bed = useRef<LoopPlayer | null>(null);
  if (bed.current === null) bed.current = new LoopPlayer('gameplayBedLong');

  // Warm the browser cache once (load() needs no gesture) and silence the bed when the screen goes away.
  useEffect(() => {
    preloadSfx();
    return () => bed.current?.stop();
  }, []);

  // A socket drop forgets the last state: whatever arrives on reconnect is recorded, not diffed (see above).
  useEffect(() => {
    if (!connected) prev.current = null;
  }, [connected]);

  // Stings: diff the previous state against this one. The first state is only recorded.
  useEffect(() => {
    const last = prev.current;
    prev.current = current;
    if (!current || !last || last === current || !enabled) return;
    for (const name of effectsFor(last, current)) playSfx(name);
  }, [current, enabled]);

  // The bed is a condition, not an event: running clock + sound on + no cue playing.
  useEffect(() => {
    const want = enabled && !suspended && current !== null && clockRunning(current);
    const loop = bed.current as LoopPlayer;
    if (want && !loop.playing) loop.start();
    else if (!want && loop.playing) loop.stop();
  }, [current, enabled, suspended]);

  // Duck the bed while an audio clue plays (the element is MonitorScreen's; MonitorAudio drives it).
  useEffect(() => {
    if (!audio) return undefined;
    const loop = bed.current as LoopPlayer;
    const sync = () => loop.duck(!audio.paused && !audio.ended);
    audio.addEventListener('play', sync);
    audio.addEventListener('pause', sync);
    audio.addEventListener('ended', sync);
    sync();
    return () => {
      audio.removeEventListener('play', sync);
      audio.removeEventListener('pause', sync);
      audio.removeEventListener('ended', sync);
      loop.duck(false);
    };
  }, [audio]);

  return null;
}

export default MonitorSfx;
