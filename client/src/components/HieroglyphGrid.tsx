import { HIEROGLYPHS, HIEROGLYPH_LABELS, type Hieroglyph as HieroglyphId } from '@only-connect/shared';
import { Hieroglyph } from './Hieroglyph';
import { Tile } from './Tile';
import './HieroglyphGrid.css';

export interface HieroglyphGridProps {
  /** Already-played hieroglyphs (rendered dark, still showing the glyph). */
  used?: ReadonlyArray<HieroglyphId>;
  /** Optional emphasis (e.g. the one just picked). */
  highlight?: HieroglyphId | null;
  /** Admin use: makes the tiles clickable; used ones stay disabled. */
  onPick?: (hieroglyph: HieroglyphId) => void;
  className?: string;
}

/** The 3×2 hieroglyph picker: Two Reeds, Lion, Twisted Flax / Horned Viper, Water, Eye of Horus. */
export function HieroglyphGrid({ used = [], highlight = null, onPick, className }: HieroglyphGridProps) {
  return (
    <div className={`oc-glyphgrid${className ? ` ${className}` : ''}`} role={onPick ? 'group' : undefined}>
      {HIEROGLYPHS.map((id) => {
        const isUsed = used.includes(id);
        return (
          <Tile
            key={id}
            size="glyph"
            raw
            variant={isUsed ? 'dark' : 'light'}
            className={highlight === id ? 'is-highlighted' : undefined}
            onClick={onPick && !isUsed ? () => onPick(id) : undefined}
            disabled={Boolean(onPick) && isUsed}
            aria-label={`${HIEROGLYPH_LABELS[id]}${isUsed ? ' (used)' : ''}`}
            title={HIEROGLYPH_LABELS[id]}
          >
            <Hieroglyph hieroglyph={id} />
          </Tile>
        );
      })}
    </div>
  );
}

export default HieroglyphGrid;
