import type { HTMLAttributes, ReactNode } from 'react';
import './TeamBar.css';

export interface TeamBarProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  /** `lg` = team name under the clue tiles (default); `sm` = vowels category bar / captions. */
  size?: 'lg' | 'sm';
}

/** Full-width navy bar with a lighter top edge and centred white text. */
export function TeamBar({ children, size = 'lg', className, ...rest }: TeamBarProps) {
  return (
    <div className={`oc-teambar oc-teambar--${size}${className ? ` ${className}` : ''}`} {...rest}>
      <span className="oc-teambar__text">{children}</span>
    </div>
  );
}

export default TeamBar;
