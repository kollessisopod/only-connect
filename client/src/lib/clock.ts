/**
 * Server clock offset store. Every public state broadcast carries `serverNow`; we keep
 * `offset = serverNow - Date.now()` so timers (wall countdown) can be rendered from server time
 * regardless of the device clock. Module-level so any component can read it without prop drilling.
 */

let clockOffset = 0;
const listeners = new Set<(offset: number) => void>();

/**
 * The last few samples, newest last. A sample is `serverNow - Date.now()` at the moment the message is
 * handled, so transport time and a busy main thread (the page still loading its bundle, say) can only make
 * it too low, never too high: the least-delayed packet in the window is the best estimate, as NTP does.
 * A blend of samples lagged behind by tens of ms after a slow first sample (the monitor's intro cuts and
 * the clock fill are timed to the ms against this offset, V3.1). The window lets the estimate follow a real
 * change of the server clock within a few broadcasts; a wild jump (the device slept) clears it at once.
 *
 * The published offset never steps *down* by less than `DECAY_TOLERANCE_MS`: when the least-delayed sample
 * ages out of the window the next best is a few ms lower, and the monitor's intro treats
 * `Date.now() + offset` as a forward-only clock (a drop straddling a phase boundary would flip the phase
 * back for a frame and replay the whoosh). A real drift of the device clock still gets through, in one
 * step, once the window's best sample is more than the tolerance below; the 5 s reset follows a jump at once.
 */
const SAMPLE_WINDOW = 8;
const DECAY_TOLERANCE_MS = 50;
let samples: number[] = [];

/** Records a broadcast's `serverNow`; the estimate is the largest of the recent samples (see above). */
export function recordServerNow(serverNow: number): number {
  const sample = serverNow - Date.now();
  if (!Number.isFinite(sample)) return clockOffset;
  const reset = samples.length === 0 || Math.abs(sample - clockOffset) > 5_000;
  if (reset) samples = [];
  samples.push(sample);
  if (samples.length > SAMPLE_WINDOW) samples.shift();
  const best = Math.max(...samples);
  if (reset || best >= clockOffset || clockOffset - best > DECAY_TOLERANCE_MS) clockOffset = best;
  for (const l of listeners) l(clockOffset);
  return clockOffset;
}

export function getClockOffset(): number {
  return clockOffset;
}

/** Best estimate of the server's current time in ms. */
export function serverNow(): number {
  return Date.now() + clockOffset;
}

export function subscribeClockOffset(listener: (offset: number) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
