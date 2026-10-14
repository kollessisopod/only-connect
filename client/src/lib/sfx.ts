/**
 * Show sound effects (V3). The files are static client assets under `/assets/sfx/` (not bucket media), so
 * every screen can play them without a round trip. Browsers only allow `play()` after a user gesture on the
 * page: the monitor has its "tap to enable sound" overlay and the wall panel is touched by the players, so
 * callers simply fire and forget — a refused play is logged, never thrown.
 *
 * Which effect plays when is decided by the screens (see `MonitorSfx.tsx`): this module only knows the files.
 */

export const SFX = {
  /** Missing Vowels: a correct answer. */
  correctVowel: '/assets/sfx/correctVowel.mp3',
  /** Thinking-music bed (195 s): loops while a question clock or a wall clock is running. */
  gameplayBedLong: '/assets/sfx/gameplayBedLong.mp3',
  /** Wall: a wrong group (no life lost); also the "incorrect" sting for judged answers. */
  incorrectGroup: '/assets/sfx/incorrectGroup.mp3',
  /** Wall: a wrong group that cost a life. */
  loseLife: '/assets/sfx/loseLife.mp3',
  /** Missing Vowels: a new category comes up. */
  nextVowelGame: '/assets/sfx/nextVowelGame.mp3',
  /** The show's "flurry" sting (4.5 s): a round starts, the final scores come up. */
  ocFlurry: '/assets/sfx/ocFlurry.mp3',
  /** Opening titles music with the flurry (21 s): the `openingTitles` cue. */
  openingTitlesWithFlurry: '/assets/sfx/openingTitlesWithFlurry.mp3',
  /** A group found on the wall / a correct answer in Connections & Sequences. */
  solveClue: '/assets/sfx/solveClue.mp3',
  /** A clock ran out (question or wall). */
  timeUp: '/assets/sfx/timeUp.mp3',
  /** A tile tapped on the wall. */
  wallBtnClick: '/assets/sfx/wallBtnClick.mp3',
} as const;

export type SfxName = keyof typeof SFX;

/** The opening title clip (17 s, with its own sound): the `introClip` cue. */
export const INTRO_CLIP_SRC = '/assets/clips/opening.mp4';

const cache = new Map<SfxName, HTMLAudioElement>();

function template(name: SfxName): HTMLAudioElement {
  let el = cache.get(name);
  if (!el) {
    el = new Audio(SFX[name]);
    el.preload = 'auto';
    cache.set(name, el);
  }
  return el;
}

/** Warms the browser cache for every effect (call once on a screen that will play them). */
export function preloadSfx(names: readonly SfxName[] = Object.keys(SFX) as SfxName[]): void {
  for (const name of names) template(name).load();
}

export interface PlaySfxOptions {
  /** 0..1, default 1. */
  volume?: number;
}

/**
 * Plays an effect from the start (overlapping an earlier play of the same effect). Returns the element so a
 * caller can stop it early. Silently does nothing when playback is refused (no gesture yet).
 */
export function playSfx(name: SfxName, opts: PlaySfxOptions = {}): HTMLAudioElement {
  const el = template(name).cloneNode(true) as HTMLAudioElement;
  el.volume = Math.max(0, Math.min(1, opts.volume ?? 1));
  el.play().catch((err: unknown) => {
    console.warn('[sfx] playback refused', name, err);
  });
  return el;
}

/**
 * A looping background track (the thinking-music bed) with ducking: `start()` begins the loop from the top,
 * `stop()` pauses and rewinds, `duck(true)` lowers the volume while something else (an audio clue) plays.
 */
export class LoopPlayer {
  private el: HTMLAudioElement | null = null;
  private ducked = false;

  constructor(
    private readonly name: SfxName,
    private readonly volume = 0.6,
    private readonly duckedVolume = 0.15,
  ) {}

  get playing(): boolean {
    return this.el !== null && !this.el.paused;
  }

  start(): void {
    if (!this.el) {
      this.el = new Audio(SFX[this.name]);
      this.el.loop = true;
      this.el.preload = 'auto';
    }
    this.el.volume = this.ducked ? this.duckedVolume : this.volume;
    if (!this.el.paused) return;
    try {
      this.el.currentTime = 0;
    } catch {
      /* not seekable yet */
    }
    this.el.play().catch((err: unknown) => {
      console.warn('[sfx] loop playback refused', this.name, err);
    });
  }

  stop(): void {
    if (!this.el) return;
    this.el.pause();
    try {
      this.el.currentTime = 0;
    } catch {
      /* ignore */
    }
  }

  duck(on: boolean): void {
    this.ducked = on;
    if (this.el) this.el.volume = on ? this.duckedVolume : this.volume;
  }
}
