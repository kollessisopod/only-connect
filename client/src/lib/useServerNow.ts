import { useEffect, useState } from 'react';
import { getClockOffset } from './clock';

/**
 * Server-time "now" that re-renders every `intervalMs` (default 250 ms). Pass the offset from
 * `usePublicState()` or omit it to use the module-level clock store (same value).
 */
export function useServerNow(clockOffset?: number, intervalMs = 250): number {
  const offset = clockOffset ?? getClockOffset();
  const [tick, setTick] = useState(() => Date.now());

  useEffect(() => {
    const id = window.setInterval(() => setTick(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);

  return tick + offset;
}
