import { memo } from 'react';
import type { TeamId } from '@only-connect/shared';
import { teamToneStyle } from './teamColours';
import './ScoreStrip.css';

export interface ScoreStripTeam {
  name: string;
  score: number;
}

export interface ScoreStripProps {
  teams: Record<TeamId, ScoreStripTeam>;
  /**
   * Which teams to show and in what order (V3.2): the round's `order` while a round is on, else
   * `activeTeams`. Idle teams are never listed, so a two-team game shows two chips as before.
   */
  order: readonly TeamId[];
  /** Highlights the team(s) in control (slightly brighter chip): one team, or every team that may steal. */
  active?: TeamId | readonly TeamId[] | null;
  className?: string;
}

/**
 * Small persistent score strip: one chip per playing team in the round's order, each "name  score".
 * `data-count` lets the stylesheet shrink three- and four-team strips (V3.2), as the lobby chips do,
 * so four long names stay clear of the monitor's round tag on the same row.
 */
export const ScoreStrip = memo(function ScoreStrip({ teams, order, active = null, className }: ScoreStripProps) {
  const lit = new Set<TeamId>(active === null ? [] : typeof active === 'string' ? [active] : active);
  return (
    <div className={`oc-scorestrip${className ? ` ${className}` : ''}`} aria-label="scores" data-count={order.length}>
      {order.map((id) => (
        <div
          key={id}
          className={`oc-scorestrip__chip oc-scorestrip__chip--${id}${lit.has(id) ? ' is-active' : ''}`}
          style={teamToneStyle(id)}
          data-team={id}
        >
          <span className="oc-scorestrip__name">{teams[id].name}</span>
          <span className="oc-scorestrip__score">{teams[id].score}</span>
        </div>
      ))}
    </div>
  );
});

export default ScoreStrip;
