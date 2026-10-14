import { useCallback, useEffect, useRef, useState } from 'react';
import type { Ack } from '@only-connect/shared';
import { getSocket, usePublicState, useServerNow } from '../../lib';
import { WallView } from './WallView';

/** After this long without an ack the panel says so (the tap may still be queued on the server). */
const SELECT_ACK_TIMEOUT_MS = 2_500;
/**
 * A tapped tile stays "in flight" (re-taps on that same tile are ignored) until the server answers, broadcasts
 * a newer state, or this hard cap passes: a select stuck behind a slow database write is still applied when the
 * queue drains, and a re-tap in the meantime would toggle the same tile straight off again. Taps on OTHER tiles
 * are never held back — the server applies them in order — so a quick team is not slowed to one round trip
 * per tile.
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

interface InFlight {
  /** State version seen when the tap was sent; a newer broadcast means the server has moved past it. */
  version: number;
  timer: number;
}

/** /wall — the team's touch panel for the Connecting Wall (SPEC §8). */
export function WallScreen() {
  const { state, clockOffset, connected } = usePublicState();
  const now = useServerNow(clockOffset);
  const [selecting, setSelecting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  /** Tiles with a tap in flight, keyed by tile id. */
  const inFlight = useRef<Map<number, InFlight>>(new Map());
  const noticeTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
      for (const f of inFlight.current.values()) window.clearTimeout(f.timer);
      inFlight.current.clear();
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

  const releaseTile = useCallback((tileId: number) => {
    const f = inFlight.current.get(tileId);
    if (!f) return;
    window.clearTimeout(f.timer);
    inFlight.current.delete(tileId);
    if (inFlight.current.size === 0) setSelecting(false);
  }, []);

  const releaseOlderThan = useCallback((version: number) => {
    for (const [tileId, f] of inFlight.current) if (version > f.version) {
      window.clearTimeout(f.timer);
      inFlight.current.delete(tileId);
    }
    if (inFlight.current.size === 0) setSelecting(false);
  }, []);

  const releaseAll = useCallback(() => {
    for (const f of inFlight.current.values()) window.clearTimeout(f.timer);
    inFlight.current.clear();
    setSelecting(false);
  }, []);

  // Any newer state means the server has moved past the taps sent before it (applied or not).
  const version = state && state.phase !== 'none' ? state.version : -1;
  useEffect(() => {
    if (inFlight.current.size > 0) releaseOlderThan(version);
  }, [version, releaseOlderThan]);
  useEffect(() => {
    if (!connected) releaseAll();
  }, [connected, releaseAll]);

  const onSelect = useCallback(
    (tileId: number) => {
      if (inFlight.current.has(tileId)) return;
      const seen = state && state.phase !== 'none' ? state.version : -1;
      inFlight.current.set(tileId, { version: seen, timer: window.setTimeout(() => releaseTile(tileId), SELECT_HARD_CAP_MS) });
      setSelecting(true);
      getSocket()
        .timeout(SELECT_ACK_TIMEOUT_MS)
        .emit('wall:select', { tileId }, (err: Error | null, res?: Ack) => {
          if (err) {
            // No ack yet: keep this tile held (a broadcast or the hard cap releases it) but tell the team.
            showNotice(friendlyError(err.message || 'timeout'));
            return;
          }
          releaseTile(tileId);
          if (res && !res.ok) showNotice(friendlyError(res.error));
          else if (!res) showNotice(friendlyError('no response'));
        });
    },
    [releaseTile, showNotice, state],
  );

  return (
    <WallView state={state} now={now} onSelect={onSelect} selecting={selecting} notice={notice} connected={connected} />
  );
}

export default WallScreen;
