import { useRef, type CSSProperties } from 'react';
import { QUESTION_MS } from '@only-connect/shared';
import './PointsBadge.css';

/**
 * The 40 s question clock as the badge sees it: server timestamps plus the server "now" of the render.
 * `now` is only read when the clock starts (or the badge mounts into a running clock), never on a tick.
 */
export interface PointsClock {
  startedAt: number | null;
  endsAt: number | null;
  now: number;
  timeUp: boolean;
}

export interface PointsBadgeProps {
  points: number;
  /**
   * The question clock, when the badge is the timer (stage `question`). Without it the badge is static and
   * shows `elapsed`.
   */
  clock?: PointsClock;
  /**
   * Elapsed fraction 0..1 drawn by a badge without a running clock (steal, answer reveal). Defaults to the
   * look of the show's answer frame: mostly navy with a sliver of light blue left at the right end.
   */
  elapsed?: number;
  className?: string;
}

/** Static fill of a badge that has no clock (the reference answer frame shows ~85 % navy). */
export const STATIC_ELAPSED = 0.85;

/**
 * The "N Points" pill — which in the show is also the question clock: its two tones are the time. The light
 * blue part is the time remaining, anchored at the pill's right end; the navy part is the time elapsed and
 * grows from the left over the 40 s, so early in a question the pill is mostly light, late it is mostly navy.
 *
 * The navy fill is a CSS animation (translateX −100 % → 0 over the clock's length, linear) started with a
 * negative delay equal to the time already elapsed on the server clock, so the 250 ms state ticks never
 * touch the DOM: React only re-applies a style property whose value changed, and the delay is captured once
 * per clock start. A reload mid-question lands on the right position for the same reason. Once the time is up
 * the fill is fully navy and nothing animates.
 *
 * The delay is captured again whenever the badge comes back into the timing state with the same clock: an
 * early "Time's up" undone by the host keeps `startedAt`, but the `is-up` → `is-timing` class change restarts
 * the CSS animation, which must then resume at the clock's real position, not at the delay of the pick.
 */
export function PointsBadge({ points, clock, elapsed = STATIC_ELAPSED, className }: PointsBadgeProps) {
  const label = `${points} ${Math.abs(points) === 1 ? 'Point' : 'Points'}`;
  const timing = clock !== undefined && clock.startedAt !== null && clock.endsAt !== null && !clock.timeUp;
  const timeUp = clock?.timeUp === true;

  // The delay is captured when the clock (startedAt) first shows up, not re-derived from `now` on every tick:
  // a changing animation-delay would re-seek the running animation 4× a second.
  const captured = useRef<{ startedAt: number; delayMs: number; durationMs: number } | null>(null);
  const wasTiming = useRef(false);
  if (timing && clock.startedAt !== null && clock.endsAt !== null && (captured.current?.startedAt !== clock.startedAt || !wasTiming.current)) {
    const durationMs = Math.max(1, clock.endsAt - clock.startedAt || QUESTION_MS);
    captured.current = { startedAt: clock.startedAt, delayMs: Math.max(0, clock.now - clock.startedAt), durationMs };
  }
  wasTiming.current = timing;

  let style: CSSProperties | undefined;
  let state = 'is-static';
  if (timeUp) {
    state = 'is-up';
  } else if (timing && captured.current) {
    state = 'is-timing';
    style = {
      '--oc-badge-duration': `${captured.current.durationMs}ms`,
      '--oc-badge-delay': `${-captured.current.delayMs}ms`,
    } as CSSProperties;
  } else {
    style = { '--oc-badge-elapsed': String(Math.max(0, Math.min(1, elapsed))) } as CSSProperties;
  }

  const testProps =
    clock !== undefined
      ? { 'data-testid': 'question-timer', 'data-time-up': timeUp ? 'true' : 'false', role: 'timer' as const }
      : { role: 'status' as const };

  return (
    <div className={`oc-badge ${state}${className ? ` ${className}` : ''}`} style={style} aria-live="polite" {...testProps}>
      <div className="oc-badge__fill" aria-hidden="true" />
      <span className="oc-badge__text">{label}</span>
    </div>
  );
}

export default PointsBadge;
