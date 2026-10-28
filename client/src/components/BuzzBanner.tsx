import type { CSSProperties } from 'react';
import type { TeamId } from '@only-connect/shared';
import { teamToneStyle } from './teamColours';
import './BuzzBanner.css';

export interface BuzzBannerProps {
  team: TeamId;
  playerName: string;
  /** Team display name shown under the player (optional). */
  teamName?: string;
  /** Small caption, e.g. "buzzed first" (default). */
  caption?: string;
  /** Smaller type, for a row of banners (several teams may answer after a wrong buzz, V3.2). */
  compact?: boolean;
  /** Font step (0..1) for a compact banner whose name would otherwise break mid-word (see `teamChipFit`). */
  fit?: number;
  className?: string;
}

/** Big team-coloured banner announcing who buzzed. */
export function BuzzBanner({ team, playerName, teamName, caption = 'buzzed first', compact = false, fit = 1, className }: BuzzBannerProps) {
  const style = fit === 1 ? teamToneStyle(team) : ({ ...teamToneStyle(team), '--oc-fit': fit } as CSSProperties);
  return (
    <div
      className={`oc-buzz oc-buzz--${team}${compact ? ' oc-buzz--compact' : ''}${className ? ` ${className}` : ''}`}
      style={style}
      data-team={team}
      role="status"
      aria-live="assertive"
    >
      <span className="oc-buzz__name">{playerName}</span>
      <span className="oc-buzz__caption">
        {teamName ? `${teamName} · ` : ''}
        {caption}
      </span>
    </div>
  );
}

export default BuzzBanner;
