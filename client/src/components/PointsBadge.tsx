import './PointsBadge.css';

export interface PointsBadgeProps {
  points: number;
  className?: string;
}

/** The "N Points" pill shown above the third clue tile. */
export function PointsBadge({ points, className }: PointsBadgeProps) {
  const label = `${points} ${Math.abs(points) === 1 ? 'Point' : 'Points'}`;
  return (
    <div className={`oc-badge${className ? ` ${className}` : ''}`} role="status" aria-live="polite">
      <span className="oc-badge__text">{label}</span>
    </div>
  );
}

export default PointsBadge;
