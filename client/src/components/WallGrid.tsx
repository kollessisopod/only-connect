import { memo } from 'react';
import { WALL_GROUP_COLOURS, type PublicWallTile } from '@only-connect/shared';
import { Tile } from './Tile';
import './WallGrid.css';

export interface WallGridProps {
  /** 16 tiles in display order (row-major). */
  tiles: ReadonlyArray<PublicWallTile>;
  selected?: ReadonlyArray<number>;
  lastWrong?: ReadonlyArray<number> | null;
  /** Changes whenever a new wrong guess happens so the flash re-triggers (e.g. state.version). */
  wrongKey?: string | number;
  onSelect?: (tileId: number) => void;
  /** When false the tiles are display-only even if onSelect is set. */
  interactive?: boolean;
  className?: string;
}

export function wallGroupColour(colourIndex: number): string {
  return WALL_GROUP_COLOURS[Math.max(0, Math.min(WALL_GROUP_COLOURS.length - 1, colourIndex))];
}

/**
 * 4×4 Connecting Wall. Solved tiles take their group colour, selected ones go dark.
 * Memoised: the 16 tiles only re-render when the play state changes, not on the countdown's clock ticks.
 */
export const WallGrid = memo(function WallGrid({
  tiles,
  selected = [],
  lastWrong = null,
  wrongKey,
  onSelect,
  interactive = Boolean(onSelect),
  className,
}: WallGridProps) {
  const canTap = interactive && Boolean(onSelect);
  return (
    <div className={`oc-wall${className ? ` ${className}` : ''}`} role={canTap ? 'group' : undefined}>
      {tiles.map((tile) => {
        const solved = tile.colour !== null;
        const isSelected = !solved && selected.includes(tile.id);
        const isWrong = !solved && lastWrong !== null && lastWrong.includes(tile.id);
        return (
          <Tile
            key={tile.id}
            size="wall"
            variant={solved ? 'group' : 'light'}
            groupColour={solved ? wallGroupColour(tile.colour as number) : undefined}
            selected={isSelected}
            flash={isWrong ? 'wrong' : null}
            flashKey={wrongKey}
            onClick={canTap && !solved ? () => onSelect?.(tile.id) : undefined}
            disabled={canTap && solved}
            data-tile-id={tile.id}
          >
            {tile.text}
          </Tile>
        );
      })}
    </div>
  );
});

export default WallGrid;
