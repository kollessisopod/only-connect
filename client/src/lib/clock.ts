/**
 * Server clock offset store. Every public state broadcast carries `serverNow`; we keep
 * `offset = serverNow - Date.now()` so timers (wall countdown) can be rendered from server time
 * regardless of the device clock. Module-level so any component can read it without prop drilling.
 */

let clockOffset = 0;
const listeners = new Set<(offset: number) => void>();

/** Blend new samples so a single delayed packet does not make the countdown jump. */
export function recordServerNow(serverNow: number): number {
  const sample = serverNow - Date.now();
  if (!Number.isFinite(sample)) return clockOffset;
  // First sample (or a wildly different one, e.g. after the device slept) is taken as-is.
  if (clockOffset === 0 || Math.abs(sample - clockOffset) > 5_000) {
    clockOffset = sample;
  } else {
    clockOffset = Math.round(clockOffset * 0.7 + sample * 0.3);
  }
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
