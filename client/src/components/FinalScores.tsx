import type { TeamId } from '@only-connect/shared';
import { Tile } from './Tile';
import { teamToneStyle } from './teamColours';
import './FinalScores.css';

export interface FinalScoresTeam {
  name: string;
  score: number;
}

export interface FinalScoresProps {
  teams: Record<TeamId, FinalScoresTeam>;
  /** The teams that played (V3.2: 2 to 4, `activeTeams`); only these get a bar. */
  order: readonly TeamId[];
  /** Computed from the scores when omitted. `'tie'` shows no winner. */
  winner?: TeamId | 'tie';
  /** White captions when drawn on the blue/purple background instead of the grey panel. */
  onDark?: boolean;
  className?: string;
}

/** The winner among `order`, or `'tie'` when the top score is shared (by any number of teams). */
export function computeWinner(teams: Record<TeamId, FinalScoresTeam>, order: readonly TeamId[]): TeamId | 'tie' {
  const top = topTeams(teams, order);
  return top.length === 1 ? top[0] : 'tie';
}

/** The teams of `order` sharing the highest score (in `order`'s order). */
export function topTeams(teams: Record<TeamId, FinalScoresTeam>, order: readonly TeamId[]): TeamId[] {
  const best = Math.max(...order.map((id) => teams[id].score));
  return order.filter((id) => teams[id].score === best);
}

/** `order` by score, highest first; equal scores keep `order` (a stable sort). */
export function standings(teams: Record<TeamId, FinalScoresTeam>, order: readonly TeamId[]): TeamId[] {
  return [...order].sort((a, b) => teams[b].score - teams[a].score);
}

/**
 * Final screen rows: one wide team bar (in the team's colours) + light score tile per playing team, best
 * first, the winner larger. With a shared top score every team on it is captioned "Draw". Three or four
 * rows are drawn smaller so they still fit the lower panel.
 */
export function FinalScores({ teams, order, winner, onDark = false, className }: FinalScoresProps) {
  const result = winner ?? computeWinner(teams, order);
  const rows = standings(teams, order);
  const drawn = new Set(result === 'tie' ? topTeams(teams, order) : []);

  return (
    <div
      className={`oc-final${onDark ? ' oc-final--on-dark' : ''}${className ? ` ${className}` : ''}`}
      data-count={rows.length}
    >
      {rows.map((id) => {
        const isWinner = result === id;
        const isDraw = drawn.has(id);
        return (
          <div
            key={id}
            className={`oc-final__row oc-final__row--${id}${isWinner ? ' oc-final__row--winner' : ''}`}
            style={teamToneStyle(id)}
            data-team={id}
          >
            {(isWinner || isDraw) && <div className="oc-final__caption">{isWinner ? 'Winners' : 'Draw'}</div>}
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
