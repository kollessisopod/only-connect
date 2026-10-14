import { memo } from 'react';
import type { TeamId } from '@only-connect/shared';
import './ScoreStrip.css';

export interface ScoreStripTeam {
  name: string;
  score: number;
}

export interface ScoreStripProps {
  teams: Record<TeamId, ScoreStripTeam>;
  /** Highlights the team in control (slightly brighter chip). */
  active?: TeamId | null;
  className?: string;
}

/** Small persistent score strip: pink chip + blue chip, each "name  score". */
export const ScoreStrip = memo(function ScoreStrip({ teams, active = null, className }: ScoreStripProps) {
  return (
    <div className={`oc-scorestrip${className ? ` ${className}` : ''}`} aria-label="scores">
      {(['pink', 'blue'] as const).map((id) => (
        <div
          key={id}
          className={`oc-scorestrip__chip oc-scorestrip__chip--${id}${active === id ? ' is-active' : ''}`}
        >
          <span className="oc-scorestrip__name">{teams[id].name}</span>
          <span className="oc-scorestrip__score">{teams[id].score}</span>
        </div>
      ))}
    </div>
  );
});

export default ScoreStrip;
