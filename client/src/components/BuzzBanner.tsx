import type { TeamId } from '@only-connect/shared';
import './BuzzBanner.css';

export interface BuzzBannerProps {
  team: TeamId;
  playerName: string;
  /** Team display name shown under the player (optional). */
  teamName?: string;
  /** Small caption, e.g. "buzzed first" (default). */
  caption?: string;
  className?: string;
}

/** Big team-coloured banner announcing who buzzed. */
export function BuzzBanner({ team, playerName, teamName, caption = 'buzzed first', className }: BuzzBannerProps) {
  return (
    <div className={`oc-buzz oc-buzz--${team}${className ? ` ${className}` : ''}`} role="status" aria-live="assertive">
      <span className="oc-buzz__name">{playerName}</span>
      <span className="oc-buzz__caption">
        {teamName ? `${teamName} · ` : ''}
        {caption}
      </span>
    </div>
  );
}

export default BuzzBanner;
