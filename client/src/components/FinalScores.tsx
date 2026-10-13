import type { TeamId } from '@only-connect/shared';
import { Tile } from './Tile';
import './FinalScores.css';

export interface FinalScoresTeam {
  name: string;
  score: number;
}

export interface FinalScoresProps {
  teams: Record<TeamId, FinalScoresTeam>;
  /** Computed from the scores when omitted. `'tie'` shows no winner. */
  winner?: TeamId | 'tie';
  /** White captions when drawn on the blue/purple background instead of the grey panel. */
  onDark?: boolean;
  className?: string;
}

export function computeWinner(teams: Record<TeamId, FinalScoresTeam>): TeamId | 'tie' {
  if (teams.pink.score === teams.blue.score) return 'tie';
  return teams.pink.score > teams.blue.score ? 'pink' : 'blue';
}

/** Final screen rows: wide team bar (blue or purple) + light score tile, winners first and larger. */
export function FinalScores({ teams, winner, onDark = false, className }: FinalScoresProps) {
  const result = winner ?? computeWinner(teams);
  const order: TeamId[] = result === 'blue' ? ['blue', 'pink'] : ['pink', 'blue'];

  return (
    <div className={`oc-final${onDark ? ' oc-final--on-dark' : ''}${className ? ` ${className}` : ''}`}>
      {order.map((id) => {
        const isWinner = result === id;
        return (
          <div key={id} className={`oc-final__row oc-final__row--${id}${isWinner ? ' oc-final__row--winner' : ''}`}>
            {(isWinner || result === 'tie') && (
              <div className="oc-final__caption">{isWinner ? 'Winners' : 'Draw'}</div>
            )}
            <div className="oc-final__bar">
              <span className="oc-final__name">{teams[id].name}</span>
            </div>
            <Tile size="score" className="oc-final__score" aria-label={`${teams[id].name} score`}>
              {teams[id].score}
            </Tile>
          </div>
        );
      })}
    </div>
  );
}

export default FinalScores;
