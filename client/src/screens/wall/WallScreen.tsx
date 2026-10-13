import { useCallback, useEffect, useRef, useState } from 'react';
import type { Ack } from '@only-connect/shared';
import { getSocket, usePublicState, useServerNow } from '../../lib';
import { WallView } from './WallView';

/** After this long without an ack the panel says so (the tap may still be queued on the server). */
const SELECT_ACK_TIMEOUT_MS = 2_500;
/**
 * A tap stays "pending" (no further taps) until the server answers or broadcasts a newer state, or until this
 * hard cap: a select that is stuck behind a slow database write is still applied when the queue drains, and a
 * re-tap in the meantime would toggle the same tile straight off again.
 */
const SELECT_HARD_CAP_MS = 12_000;
const NOTICE_MS = 1_600;

function friendlyError(error: string | undefined): string {
  const text = (error ?? 'something went wrong').trim();
  if (/time is up/i.test(text)) return "Time's up";
  if (/not live/i.test(text)) return 'The wall is not live';
  if (/timeout/i.test(text)) return 'No answer from the server';
  if (/too many/i.test(text)) return 'Slow down';
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** /wall — the team's touch panel for the Connecting Wall (SPEC §8). */
export function WallScreen() {
  const { state, clockOffset, connected } = usePublicState();
  const now = useServerNow(clockOffset);
  const [selecting, setSelecting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  /** The tap in flight: the state version seen when it was sent, so a newer broadcast releases it. */
  const pending = useRef<{ version: number; timer: number | null } | null>(null);
  const noticeTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
      if (pending.current?.timer !== null && pending.current?.timer !== undefined) window.clearTimeout(pending.current.timer);
    },
    [],
  );

  const showNotice = useCallback((text: string) => {
    setNotice(text);
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => {
      noticeTimer.current = null;
      setNotice(null);
    }, NOTICE_MS);
  }, []);

  const release = useCallback(() => {
    const p = pending.current;
    if (!p) return;
    if (p.timer !== null) window.clearTimeout(p.timer);
    pending.current = null;
    setSelecting(false);
  }, []);

  // Any newer state means the server has moved past our tap (applied or not): the panel is usable again.
  const version = state && state.phase !== 'none' ? state.version : -1;
  useEffect(() => {
    const p = pending.current;
    if (p && version > p.version) release();
  }, [version, release]);
  useEffect(() => {
    if (!connected) release();
  }, [connected, release]);

  const onSelect = useCallback(
    (tileId: number) => {
      if (pending.current) return;
      const seen = state && state.phase !== 'none' ? state.version : -1;
      pending.current = { version: seen, timer: window.setTimeout(release, SELECT_HARD_CAP_MS) };
      setSelecting(true);
      getSocket()
        .timeout(SELECT_ACK_TIMEOUT_MS)
        .emit('wall:select', { tileId }, (err: Error | null, res?: Ack) => {
          if (err) {
            // No ack yet: keep the guard (a broadcast or the hard cap releases it) but tell the team.
            showNotice(friendlyError(err.message || 'timeout'));
            return;
          }
          release();
          if (res && !res.ok) showNotice(friendlyError(res.error));
          else if (!res) showNotice(friendlyError('no response'));
        });
    },
    [release, showNotice, state],
  );

  return (
    <WallView state={state} now={now} onSelect={onSelect} selecting={selecting} notice={notice} connected={connected} />
  );
}

export default WallScreen;
