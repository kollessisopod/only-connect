/**
 * Show cues on the monitor (V3, SPEC §4): the opening titles music and the opening clip, fired from the admin
 * console as `cue:play {cue}` / `cue:stop`. `state.cue` is `{ name, nonce }`; a changed nonce means "play this
 * from the start" (the same pattern as `playMedia` in MonitorAudio, including: the cue already set when the
 * page loaded is ignored, and a cue that arrives before sound is enabled waits for the overlay tap).
 *
 * Renders the full-screen clip while it plays, nothing otherwise. `onActiveChange` tells the parent while a
 * cue is on (MonitorSfx keeps the thinking-music bed silent meanwhile).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CueName, PublicStateMessage } from '@only-connect/shared';
import { INTRO_CLIP_SRC, playSfx } from '../../lib/sfx';
import './MonitorCue.css';

export interface MonitorCueProps {
  state: PublicStateMessage | null;
  /** Whether sound has been enabled (the overlay was dismissed). */
  enabled: boolean;
  onActiveChange?: (active: boolean) => void;
}

type CueRequest = { name: CueName; nonce: number };

const UNSEEN = Symbol('unseen');

export function MonitorCue({ state, enabled, onActiveChange }: MonitorCueProps) {
  const cue = state && state.phase !== 'none' ? state.cue : null;
  const name = cue?.name ?? null;
  const nonce = cue?.nonce ?? null;

  const lastNonce = useRef<number | null | typeof UNSEEN>(UNSEEN);
  const pending = useRef<CueRequest | null>(null);
  const music = useRef<HTMLAudioElement | null>(null);
  const [musicOn, setMusicOn] = useState(false);
  /** Nonce of the clip on screen (keys the <video> so a repeat restarts it), null when hidden. */
  const [clip, setClip] = useState<number | null>(null);

  const stopAll = useCallback(() => {
    if (music.current) {
      music.current.pause();
      music.current = null;
    }
    setMusicOn(false);
    setClip(null);
  }, []);

  useEffect(() => {
    if (!state) return;
    if (lastNonce.current === UNSEEN) {
      lastNonce.current = nonce;
      return;
    }
    if (name === null || nonce === null) {
      lastNonce.current = null;
      pending.current = null;
      stopAll();
      return;
    }
    if (nonce !== lastNonce.current) {
      lastNonce.current = nonce;
      pending.current = { name, nonce };
    }
    if (pending.current && enabled) {
      const request = pending.current;
      pending.current = null;
      stopAll();
      if (request.name === 'openingTitles') {
        const el = playSfx('openingTitlesWithFlurry');
        music.current = el;
        setMusicOn(true);
        el.addEventListener('ended', () => {
          if (music.current === el) {
            music.current = null;
            setMusicOn(false);
          }
        });
      } else {
        setClip(request.nonce);
      }
    }
  }, [state, name, nonce, enabled, stopAll]);

  const active = musicOn || clip !== null;
  useEffect(() => {
    onActiveChange?.(active);
  }, [active, onActiveChange]);

  // Leaving the screen stops whatever is playing.
  useEffect(() => () => stopAll(), [stopAll]);

  if (clip === null) return null;
  return (
    <div className="oc-monitor-cue" role="presentation">
      <video
        key={clip}
        className="oc-monitor-cue__video"
        data-testid="intro-video"
        src={INTRO_CLIP_SRC}
        autoPlay
        playsInline
        onEnded={() => setClip(null)}
        onError={(e) => {
          // No decoder for the file (headless builds lack H.264) or a 404: drop the black overlay rather than
          // leaving the audience staring at it; the admin's action log still shows the cue was fired.
          console.warn('[cue] opening clip cannot play', e.currentTarget.error?.code ?? 'unknown error');
          setClip(null);
        }}
      />
    </div>
  );
}

export default MonitorCue;
