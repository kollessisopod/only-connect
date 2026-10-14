/**
 * Sound effects for the monitor (V3, SPEC §4). Renders nothing.
 *
 * No server field says "play a sting": the effects are derived here by diffing consecutive public states, so
 * a sound belongs to exactly one state transition and a reload never replays it. The wall's thinking-music bed
 * is not an event but a condition (the wall clock is running), so it is synchronised to the current state on
 * every change instead — which is also what starts it when sound gets enabled mid-wall. The question music
 * (`solving45`, V3.1) is both: it starts on the transition into a question (so a reload mid-question stays
 * quiet rather than starting the track from the top half-way through) and stops on the condition "no question
 * clock running" (judged, voided, time up, sound off, a cue playing).
 *
 * Rules (see `effectsFor`): nothing plays for the first state after load, while sound is disabled (and no
 * backlog is queued from before that), or across a change of game id. The first state after a socket drop is
 * treated like the first after load: transitions that happened while the monitor was offline collapse into
 * one diff and their stings would play seconds or minutes late.
 */
import { useEffect, useRef } from 'react';
import { questionClockRunning, type PublicGameState, type PublicStateMessage, type TeamId } from '@only-connect/shared';
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
  /** Server time in ms (useServerNow): where on its clock a question is when its music starts. */
  now?: number;
}

const ROUND_PHASES: ReadonlySet<PublicGameState['phase']> = new Set(['connections', 'sequences', 'wall', 'vowels', 'final']);

/** The team buzzers of Missing Vowels (the owner's "buzzer 1" is blue, "buzzer 2" pink). */
const BUZZER: Record<TeamId, SfxName> = { blue: 'buzzerBlue', pink: 'buzzerPink' };

/** True while the wall's 2:30 clock is running (a live wall): the thinking-music bed loops meanwhile. */
export function wallClockRunning(state: PublicGameState): boolean {
  return state.phase === 'wall' && state.wall?.current?.stage === 'live';
}

/** True while the 40 s question clock is running: the question music plays meanwhile. */
export function questionMusicWanted(state: PublicGameState): boolean {
  return (state.phase === 'connections' || state.phase === 'sequences') && state.question !== null && questionClockRunning(state.question);
}

/**
 * True for the transition that starts a question: the clock begins (stage `question`, clock set) where the
 * previous state was not already in that question with its clock running — a pick after `selecting`, or a
 * new question of the same round (counted by `questionsDone`). Pure; the music starts exactly here.
 */
export function questionMusicStarts(prev: PublicGameState, cur: PublicGameState): boolean {
  if (cur.id !== prev.id || !questionMusicWanted(cur)) return false;
  const pq = prev.question;
  if (prev.phase !== cur.phase || !pq) return true;
  return !questionClockRunning(pq) || pq.questionsDone !== cur.question?.questionsDone;
}

/**
 * Ms already elapsed on the question clock when its music starts: ~0 at a pick (socket latency), but an
 * early "Time's up" undone by the host re-runs the same clock from where it is, and the music resumes there
 * rather than from the top. Pure; 0 without a clock or a `now`.
 */
export function questionMusicOffsetMs(cur: PublicGameState, now: number | undefined): number {
  const startedAt = cur.question?.startedAt ?? null;
  if (now === undefined || startedAt === null) return 0;
  return Math.max(0, now - startedAt);
}

/** A start this far into the clock seeks the track; closer to the top it plays from the start, unseeked. */
const RESUME_SEEK_MS = 1000;

/**
 * A track played once (the question music): `start()` plays it from the top, `stop()` cuts it, `duck()`
 * lowers it while an audio clue plays. Same volumes as the bed so the two rounds sound alike.
 */
class OnceTrack {
  private el: HTMLAudioElement | null = null;
  private ducked = false;

  constructor(
    private readonly name: SfxName,
    private readonly volume = 0.6,
    private readonly duckedVolume = 0.15,
  ) {}

  get playing(): boolean {
    return this.el !== null && !this.el.paused && !this.el.ended;
  }

  /** Plays from the top, or from `atMs` into the track when the clock it follows is already that far. */
  start(atMs = 0): void {
    this.stop();
    this.el = playSfx(this.name, { volume: this.ducked ? this.duckedVolume : this.volume });
    if (atMs < RESUME_SEEK_MS) return;
    try {
      // Before the clone's metadata is in, this sets its default start position (HTML spec), so the seek
      // holds either way.
      this.el.currentTime = atMs / 1000;
    } catch {
      /* not seekable: play from the top */
    }
  }

  stop(): void {
    if (!this.el) return;
    this.el.pause();
    this.el = null;
  }

  duck(on: boolean): void {
    this.ducked = on;
    if (this.el) this.el.volume = on ? this.duckedVolume : this.volume;
  }
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
 *    itself (the flurry already marks it) but on a resume from the lobby, which has no flurry;
 *  - `buzzerBlue` / `buzzerPink`: a buzz accepted in Missing Vowels (stage → `buzzed`), the buzzing team's
 *    buzzer (the phone that won the buzz plays the same sound on its ack).
 * The question music (`solving45`) and the wall bed (`gameplayBedLong`) are not stings and are handled by
 * `questionMusicStarts` / `questionMusicWanted` / `wallClockRunning`.
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
      if (cv.stage === 'buzzed' && pv.stage !== 'buzzed' && cv.buzz) out.push(BUZZER[cv.buzz.team]);
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

export function MonitorSfx({ state, enabled, audio, suspended = false, connected = true, now }: MonitorSfxProps) {
  const current = state && state.phase !== 'none' ? state : null;
  const prev = useRef<PublicGameState | null>(null);
  // Read when the music starts, never reacted to: the 250 ms ticks must not re-run the diff.
  const nowRef = useRef(now);
  nowRef.current = now;
  const bed = useRef<LoopPlayer | null>(null);
  if (bed.current === null) bed.current = new LoopPlayer('gameplayBedLong');
  const music = useRef<OnceTrack | null>(null);
  if (music.current === null) music.current = new OnceTrack('solving45');

  // Warm the browser cache once (load() needs no gesture; `preloadSfx` covers every file in SFX, the question
  // music and the buzzers included) and silence the bed and the music when the screen goes away.
  useEffect(() => {
    preloadSfx();
    return () => {
      bed.current?.stop();
      music.current?.stop();
    };
  }, []);

  // A socket drop forgets the last state: whatever arrives on reconnect is recorded, not diffed (see above).
  useEffect(() => {
    if (!connected) prev.current = null;
  }, [connected]);

  // Stings: diff the previous state against this one. The first state is only recorded. The question music
  // starts on the same diff (once per question), unless a cue is playing.
  useEffect(() => {
    const last = prev.current;
    prev.current = current;
    if (!current || !last || last === current || !enabled) return;
    for (const name of effectsFor(last, current)) playSfx(name);
    if (!suspended && questionMusicStarts(last, current)) music.current?.start(questionMusicOffsetMs(current, nowRef.current));
    // `suspended` is read, not reacted to: a cue ending mid-question must not start the music late.
  }, [current, enabled]);

  // The bed is a condition, not an event: wall clock running + sound on + no cue playing.
  useEffect(() => {
    const want = enabled && !suspended && current !== null && wallClockRunning(current);
    const loop = bed.current as LoopPlayer;
    if (want && !loop.playing) loop.start();
    else if (!want && loop.playing) loop.stop();
  }, [current, enabled, suspended]);

  // The question music stops on a condition: the clock no longer runs (judged, voided, time up — the time-up
  // sting plays on its own), sound off, a cue playing. It is never started here (see the diff above).
  useEffect(() => {
    const keep = enabled && !suspended && current !== null && questionMusicWanted(current);
    const track = music.current as OnceTrack;
    if (!keep && track.playing) track.stop();
  }, [current, enabled, suspended]);

  // Duck the bed and the music while an audio clue plays (the element is MonitorScreen's; MonitorAudio
  // drives it).
  useEffect(() => {
    if (!audio) return undefined;
    const loop = bed.current as LoopPlayer;
    const track = music.current as OnceTrack;
    const sync = () => {
      const on = !audio.paused && !audio.ended;
      loop.duck(on);
      track.duck(on);
    };
    audio.addEventListener('play', sync);
    audio.addEventListener('pause', sync);
    audio.addEventListener('ended', sync);
    sync();
    return () => {
      audio.removeEventListener('play', sync);
      audio.removeEventListener('pause', sync);
      audio.removeEventListener('ended', sync);
      loop.duck(false);
      track.duck(false);
    };
  }, [audio]);

  return null;
}

export default MonitorSfx;
