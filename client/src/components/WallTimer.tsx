import type { CSSProperties } from 'react';
import { WALL_SECONDS } from '@only-connect/shared';
import './WallTimer.css';

export interface WallTimerProps {
  /** Elapsed fraction 0..1 (0 = full time left). */
  progress: number;
  /** Optional remaining seconds label (announced to screen readers; not drawn). */
  secondsLeft?: number;
  className?: string;
}

/** Elapsed fraction for a wall from server timestamps (0 before start, 1 after the end). */
export function wallProgress(
  play: { startedAt: number | null; endsAt: number | null },
  now: number,
  totalMs: number = WALL_SECONDS * 1000,
): number {
  if (play.startedAt === null || play.endsAt === null) return 0;
  const total = Math.max(1, play.endsAt - play.startedAt || totalMs);
  const elapsed = now - play.startedAt;
  if (elapsed <= 0) return 0;
  if (elapsed >= total) return 1;
  return elapsed / total;
}

/**
 * The show's timer: a bar of remaining time anchored to the grid's right edge that shrinks towards it as
 * time runs out, with a dark cap on its leading (left) end; no track is drawn for the elapsed part.
 */
export function WallTimer({ progress, secondsLeft, className }: WallTimerProps) {
  const pct = Math.max(0, Math.min(1, progress)) * 100;
  // The bar is a full-width strip slid right by the elapsed fraction (its left end leaves the box), so the
  // glide between ticks runs on `transform` on the compositor instead of re-laying-out `width` every frame.
  // The cap keeps the show's proportion: 6 % of the remaining length, at least 24 px (see WallTimer.css).
  const fillStyle = {
    transform: `translateX(${pct}%)`,
    '--oc-timer-remaining': String((100 - pct) / 100),
  } as CSSProperties;
  return (
    <div
      className={`oc-walltimer${className ? ` ${className}` : ''}`}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
      aria-label={secondsLeft !== undefined ? `${secondsLeft} seconds left` : 'wall timer'}
    >
      <div className="oc-walltimer__fill" style={fillStyle} />
    </div>
  );
}

export default WallTimer;
