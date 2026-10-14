/**
 * Media side effects for the monitor: plays audio clues and warms the image cache. Renders nothing.
 *
 * `state.playMedia` is `{ key, nonce }`: the engine bumps the nonce on every `q:reveal` of an audio clue and on
 * every `media:play`, so a changed nonce means "play this from the start". `media:stop` sets it to null.
 *
 * The pick itself requests the first clue's audio (V3.1), 5.3 s before the question layout exists: a request
 * that arrives during the pick-to-question intro is held and started on the server clock when its tile is on
 * screen (`audioHoldUntil`), with the hold dropped if the request is withdrawn or superseded meanwhile.
 */
import { useEffect, useRef } from 'react';
import { QUESTION_INTRO_MS, QUESTION_INTRO_PHASES, questionIntroPhase, type PublicGameState, type PublicStateMessage } from '@only-connect/shared';
import { mediaUrl } from '../../lib/api';
import { useServerClock } from './serverClock';

export interface MonitorAudioProps {
  /** The Audio element unlocked by the user's first gesture (null until then). */
  audio: HTMLAudioElement | null;
  /** Whether sound has been enabled (the overlay was dismissed). */
  enabled: boolean;
  state: PublicStateMessage | null;
  /** Server time in ms (useServerNow) and the clock store's offset: a clue requested during the intro is started on this clock. */
  now?: number;
  clockOffset?: number;
}

type PlayRequest = { key: string; nonce: number };

const UNSEEN = Symbol('unseen');

function startPlayback(audio: HTMLAudioElement, key: string): void {
  const url = mediaUrl(key);
  if (audio.getAttribute('data-oc-key') !== key) {
    audio.src = url;
    audio.setAttribute('data-oc-key', key);
  }
  try {
    audio.currentTime = 0;
  } catch {
    /* not seekable yet; `src` was just set so playback starts from 0 anyway */
  }
  audio.play().catch((err: unknown) => {
    // Autoplay refusal or a missing object: log for the operator, nothing else to do on a public screen.
    console.warn('[monitor] audio playback failed', key, err);
  });
}

/**
 * Builds the tiny silent WAV that `unlockAudio` plays inside the user's gesture, so later programmatic
 * `play()` calls are allowed (Safari requires an actual play within the gesture, not just a user activation).
 */
function silentWavDataUri(): string {
  const sampleRate = 8000;
  const samples = 400; // 50 ms
  const buffer = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buffer);
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + samples * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, samples * 2, true);
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return `data:audio/wav;base64,${btoa(binary)}`;
}

/** Creates the monitor's Audio element and plays a silent clip. Must be called from a user gesture handler. */
export function unlockAudio(): HTMLAudioElement {
  const audio = new Audio();
  audio.preload = 'auto';
  audio.setAttribute('playsinline', '');
  audio.src = silentWavDataUri();
  audio.play().catch(() => {
    /* the gesture still counts as user activation in browsers that reject the silent clip */
  });
  return audio;
}

/**
 * When a play request for `key` may start, in server ms, or null for "now". Outside the pick-to-question
 * intro a request plays at once. During the intro the clip waits for its tile: the first clue appears in the
 * chosen slot `emptyUntil` ms after the pick (`startedAt - QUESTION_INTRO_MS`); any other clue (one revealed
 * early by the host) is only drawn with the question layout at `startedAt`. Pure.
 */
export function audioHoldUntil(state: PublicGameState, key: string, now: number): number | null {
  if (state.phase !== 'connections' && state.phase !== 'sequences') return null;
  const q = state.question;
  const startedAt = q?.startedAt ?? null;
  if (!q || startedAt === null || questionIntroPhase(q, now) === 'none') return null;
  const first = q.clues[0];
  const isFirst = first !== undefined && first.kind === 'audio' && first.revealed && first.mediaUrl === mediaUrl(key);
  return isFirst ? startedAt - QUESTION_INTRO_MS + QUESTION_INTRO_PHASES.emptyUntil : startedAt;
}

/** Revealed image clue urls in the current question (public state only carries urls once revealed). */
function revealedImageUrls(state: PublicStateMessage | null): string[] {
  if (!state || state.phase === 'none' || !state.question) return [];
  return state.question.clues.flatMap((c) => (c.kind === 'image' && c.revealed && c.mediaUrl ? [c.mediaUrl] : []));
}

export function MonitorAudio({ audio, enabled, state, now, clockOffset }: MonitorAudioProps) {
  const playMedia = state && state.phase !== 'none' ? state.playMedia : null;
  const key = playMedia?.key ?? null;
  const nonce = playMedia?.nonce ?? null;
  // Read when a held request is scheduled, never reacted to (the 250 ms ticks must not re-run the effect).
  const clock = useServerClock(now ?? 0, clockOffset);

  // The nonce we last acted on. Starts "unseen" so a stale request from before this page loaded (e.g. a
  // refresh mid-question) does not blast out on arrival; the host can always press "play" again.
  const lastNonce = useRef<number | null | typeof UNSEEN>(UNSEEN);
  // A request that arrived while sound was still disabled: played as soon as the overlay is dismissed.
  const pending = useRef<PlayRequest | null>(null);
  // A request held for its tile during the intro (the timer), and the request currently on the state, so
  // the timer can tell whether it has been withdrawn (`media:stop`, a void) or superseded meanwhile.
  const held = useRef(0);
  const latestNonce = useRef<number | null>(null);
  latestNonce.current = nonce;
  const cancelHold = () => {
    if (held.current === 0) return;
    window.clearTimeout(held.current);
    held.current = 0;
  };
  useEffect(() => cancelHold, []);

  useEffect(() => {
    if (!state) return;
    if (lastNonce.current === UNSEEN) {
      lastNonce.current = nonce;
      return;
    }
    if (key === null || nonce === null) {
      lastNonce.current = null;
      pending.current = null;
      cancelHold();
      if (audio && !audio.paused) audio.pause();
      return;
    }
    if (nonce !== lastNonce.current) {
      lastNonce.current = nonce;
      pending.current = { key, nonce };
      cancelHold();
    }
    if (pending.current && enabled && audio) {
      const request = pending.current;
      pending.current = null;
      const at = state.phase === 'none' ? null : audioHoldUntil(state, request.key, clock.precise());
      const wait = at === null ? 0 : at - clock.precise();
      if (wait <= 0) startPlayback(audio, request.key);
      else {
        held.current = window.setTimeout(() => {
          held.current = 0;
          if (latestNonce.current === request.nonce) startPlayback(audio, request.key);
        }, wait);
      }
    }
    // `clock.precise` reads a ref: only the request and the sound state matter here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, key, nonce, audio, enabled]);

  // Warm the cache for revealed pictures (a duplicate <img> request is served from cache).
  const warmed = useRef<Set<string>>(new Set());
  const imageUrls = revealedImageUrls(state);
  const imageKey = imageUrls.join('\n');
  useEffect(() => {
    for (const url of imageUrls) {
      if (warmed.current.has(url)) continue;
      warmed.current.add(url);
      const img = new Image();
      img.decoding = 'async';
      img.src = url;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- imageUrls is derived from imageKey
  }, [imageKey]);

  return null;
}

export default MonitorAudio;
