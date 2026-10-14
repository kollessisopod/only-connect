/**
 * /monitor — the public big screen. Socket + clock + audio plumbing around the presentational MonitorView:
 * MonitorAudio plays the audio clues, MonitorSfx the show's stings and thinking-music bed, MonitorCue the
 * opening titles / clip the host fires from the admin console.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { preloadHieroglyphs } from '../../components/Hieroglyph';
import { usePublicState } from '../../lib/usePublicState';
import { useServerNow } from '../../lib/useServerNow';
import { MonitorAudio, unlockAudio } from './MonitorAudio';
import { MonitorCue } from './MonitorCue';
import { MonitorSfx } from './MonitorSfx';
import { MonitorIdle, MonitorView } from './MonitorView';
import './MonitorScreen.css';

/** True after `timeoutMs` without pointer movement, so the cursor can be hidden on the big screen. */
function useIdleCursor(timeoutMs: number): boolean {
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    let timer = 0;
    const wake = () => {
      setIdle(false);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setIdle(true), timeoutMs);
    };
    wake();
    window.addEventListener('mousemove', wake);
    window.addEventListener('pointerdown', wake);
    window.addEventListener('keydown', wake);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('mousemove', wake);
      window.removeEventListener('pointerdown', wake);
      window.removeEventListener('keydown', wake);
    };
  }, [timeoutMs]);
  return idle;
}

function SpeakerIcon() {
  return (
    <svg className="oc-monitor-screen__speaker" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <path d="M10 24h10l14-11v38L20 40H10z" fill="currentColor" />
      <path
        d="M40 22a12 12 0 0 1 0 20M46 15a21 21 0 0 1 0 34"
        fill="none"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function SoundOverlay() {
  return (
    <div className="oc-monitor-screen__overlay" role="button" tabIndex={0} aria-label="Tap to enable sound">
      <div className="oc-monitor-screen__overlay-card">
        <SpeakerIcon />
        <div className="oc-monitor-screen__overlay-title">Tap to enable sound</div>
        <div className="oc-monitor-screen__overlay-hint">
          Audio clues can only play after a click or key press on this screen
        </div>
      </div>
    </div>
  );
}

export function MonitorScreen() {
  const { state, clockOffset, connected, error } = usePublicState();
  const now = useServerNow(clockOffset);
  const [audio, setAudio] = useState<HTMLAudioElement | null>(null);
  // True while a show cue plays: the bed stays silent (the clip has its own sound).
  const [cueActive, setCueActive] = useState(false);
  const idle = useIdleCursor(3000);
  const soundEnabled = audio !== null;

  useEffect(() => {
    void preloadHieroglyphs();
    const previous = document.title;
    document.title = 'Only Connect — Monitor';
    return () => {
      document.title = previous;
    };
  }, []);

  // Any click or key press unlocks audio (the browser needs a gesture before `play()` works).
  useEffect(() => {
    if (audio) return undefined;
    const unlock = () => setAudio((current) => current ?? unlockAudio());
    window.addEventListener('click', unlock);
    window.addEventListener('keydown', unlock);
    window.addEventListener('touchend', unlock);
    return () => {
      window.removeEventListener('click', unlock);
      window.removeEventListener('keydown', unlock);
      window.removeEventListener('touchend', unlock);
    };
  }, [audio]);

  let content: ReactNode;
  if (!state) {
    content = <MonitorIdle caption={error ? 'Cannot reach the server — retrying…' : 'Connecting…'} />;
  } else if (state.phase === 'none') {
    content = <MonitorIdle caption="Waiting for the game master" />;
  } else {
    content = <MonitorView state={state} now={now} soundEnabled={soundEnabled} connected={connected} />;
  }

  return (
    <div className={`screen oc-monitor-screen${idle ? ' is-idle' : ''}`}>
      {content}
      <MonitorAudio audio={audio} enabled={soundEnabled} state={state} />
      <MonitorSfx state={state} now={now} enabled={soundEnabled} audio={audio} suspended={cueActive} connected={connected} />
      <MonitorCue state={state} enabled={soundEnabled} onActiveChange={setCueActive} />
      {!connected && (
        <div className="oc-monitor-screen__pill" role="status" aria-live="polite">
          <span className="oc-monitor-screen__pill-dot" aria-hidden="true" />
          reconnecting…
        </div>
      )}
      {!soundEnabled && <SoundOverlay />}
    </div>
  );
}

export default MonitorScreen;
