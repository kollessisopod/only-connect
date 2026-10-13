import { WALL_LIVES } from '@only-connect/shared';
import './WallLives.css';

export interface WallLivesProps {
  /** Lives left; `null` = not yet limited (nothing is rendered). */
  lives: number | null;
  max?: number;
  className?: string;
}

/** Three dots that empty as the team loses lives after the second group. */
export function WallLives({ lives, max = WALL_LIVES, className }: WallLivesProps) {
  if (lives === null) return null;
  return (
    <div
      className={`oc-lives${className ? ` ${className}` : ''}`}
      role="img"
      aria-label={`${lives} of ${max} lives left`}
    >
      {Array.from({ length: max }, (_, i) => (
        <span key={i} className={`oc-lives__dot${i < lives ? ' is-alive' : ''}`} />
      ))}
    </div>
  );
}

export default WallLives;
