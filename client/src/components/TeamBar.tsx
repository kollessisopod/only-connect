import type { HTMLAttributes, ReactNode } from 'react';
import type { TeamId } from '@only-connect/shared';
import { teamToneStyle } from './teamColours';
import './TeamBar.css';

export interface TeamBarProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  /** `lg` = team name under the clue tiles (default); `sm` = vowels category bar / captions. */
  size?: 'lg' | 'sm';
  /**
   * Colours the bar in a team's tone (V3.2) instead of the show's navy: used where the bar is the only
   * thing that says whose turn it is (the wall panel). The monitor keeps navy bars, as in the show.
   */
  tone?: TeamId | null;
}

/** Full-width navy bar with a lighter top edge and centred white text. */
export function TeamBar({ children, size = 'lg', tone = null, className, style, ...rest }: TeamBarProps) {
  const toned = tone ? teamToneStyle(tone) : undefined;
  return (
    <div
      className={`oc-teambar oc-teambar--${size}${tone ? ` oc-teambar--toned oc-teambar--${tone}` : ''}${className ? ` ${className}` : ''}`}
      style={toned ? { ...toned, ...style } : style}
      data-team={tone ?? undefined}
      {...rest}
    >
      <span className="oc-teambar__text">{children}</span>
    </div>
  );
}

export default TeamBar;
