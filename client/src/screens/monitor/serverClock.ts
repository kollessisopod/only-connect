/**
 * Sub-tick server time for the monitor's timed cuts (V3.1).
 *
 * `useServerNow` re-renders every 250 ms with the server "now" of that tick; the pick-to-question intro has
 * boundaries (the whoosh, the clue sliding in, the hard cut to the question layout) that must land to the
 * frame, and in step on every screen. So the boundaries are scheduled with `setTimeout` to the exact ms and
 * the phase is read off `precise()`.
 *
 * On the live monitor `precise()` is `Date.now() + clockOffset`, the store's own estimate of server time,
 * read fresh on every call. It must not be inferred from the `now` prop: `now` is the *last tick's*
 * `Date.now()` plus the offset, so when a broadcast changes the offset the screen re-renders with a `now`
 * that is up to 250 ms stale, and a clock carried forward from "now, as of this render" is behind by that
 * much — the timer for the pulse's end, armed on the pick's own broadcast, then fired late and the 120 ms
 * whoosh was skipped whenever no tick happened to land inside it.
 *
 * Without an offset (the dev fixtures, whose `now` is synthetic) `precise()` carries `now` forward by the
 * wall time since it changed; a clock that never ticks (a frozen fixture) stays where it is, so a fixture
 * frame is still a still: nothing is scheduled for it and `precise()` returns `now` itself.
 */
import { useRef } from 'react';

export interface ServerClock {
  /** Server time now, in ms. */
  precise: () => number;
  /** False until the clock is known to run: an offset was given, or `now` has changed once since mount. */
  ticking: boolean;
}

export function useServerClock(now: number, clockOffset?: number): ServerClock {
  const tick = useRef({ now, at: Date.now(), ticking: false });
  if (tick.current.now !== now) tick.current = { now, at: Date.now(), ticking: true };
  const offset = useRef(clockOffset);
  offset.current = clockOffset;
  const ticking = clockOffset !== undefined || tick.current.ticking;
  const precise = () => {
    if (offset.current !== undefined) return Date.now() + offset.current;
    return tick.current.ticking ? tick.current.now + (Date.now() - tick.current.at) : tick.current.now;
  };
  return { precise, ticking };
}
