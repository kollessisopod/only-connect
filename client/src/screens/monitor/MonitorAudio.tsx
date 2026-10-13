/**
 * Media side effects for the monitor: plays audio clues and warms the image cache. Renders nothing.
 *
 * `state.playMedia` is `{ key, nonce }`: the engine bumps the nonce on every `q:reveal` of an audio clue and on
 * every `media:play`, so a changed nonce means "play this from the start". `media:stop` sets it to null.
 */
import { useEffect, useRef } from 'react';
import type { PublicStateMessage } from '@only-connect/shared';
import { mediaUrl } from '../../lib/api';

export interface MonitorAudioProps {
  /** The Audio element unlocked by the user's first gesture (null until then). */
  audio: HTMLAudioElement | null;
  /** Whether sound has been enabled (the overlay was dismissed). */
  enabled: boolean;
  state: PublicStateMessage | null;
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

/** Revealed image clue urls in the current question (public state only carries urls once revealed). */
function revealedImageUrls(state: PublicStateMessage | null): string[] {
  if (!state || state.phase === 'none' || !state.question) return [];
  return state.question.clues.flatMap((c) => (c.kind === 'image' && c.revealed && c.mediaUrl ? [c.mediaUrl] : []));
}

export function MonitorAudio({ audio, enabled, state }: MonitorAudioProps) {
  const playMedia = state && state.phase !== 'none' ? state.playMedia : null;
  const key = playMedia?.key ?? null;
  const nonce = playMedia?.nonce ?? null;

  // The nonce we last acted on. Starts "unseen" so a stale request from before this page loaded (e.g. a
  // refresh mid-question) does not blast out on arrival; the host can always press "play" again.
  const lastNonce = useRef<number | null | typeof UNSEEN>(UNSEEN);
  // A request that arrived while sound was still disabled: played as soon as the overlay is dismissed.
  const pending = useRef<PlayRequest | null>(null);

  useEffect(() => {
    if (!state) return;
    if (lastNonce.current === UNSEEN) {
      lastNonce.current = nonce;
      return;
    }
    if (key === null || nonce === null) {
      lastNonce.current = null;
      pending.current = null;
      if (audio && !audio.paused) audio.pause();
      return;
    }
    if (nonce !== lastNonce.current) {
      lastNonce.current = nonce;
      pending.current = { key, nonce };
    }
    if (pending.current && enabled && audio) {
      const request = pending.current;
      pending.current = null;
      startPlayback(audio, request.key);
    }
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
