import { HIEROGLYPHS, HIEROGLYPH_LABELS, type Hieroglyph as HieroglyphId } from '@only-connect/shared';
import { Hieroglyph } from './Hieroglyph';
import { Tile } from './Tile';
import './HieroglyphGrid.css';

export type HieroglyphGridColumns = 2 | 3 | 4;

export interface HieroglyphGridProps {
  /**
   * The hieroglyphs on the board (the round's `available` list), in HIEROGLYPHS order. Defaults to all of them.
   * Six or fewer sit in the show's 3×2; more than six (packs with up to 12 questions a round) use four columns.
   */
  hieroglyphs?: ReadonlyArray<HieroglyphId>;
  /** Already-played hieroglyphs (rendered dark, still showing the glyph). */
  used?: ReadonlyArray<HieroglyphId>;
  /** Optional emphasis (e.g. the one just picked). */
  highlight?: HieroglyphId | null;
  /** Admin use: makes the tiles clickable; used ones stay disabled. */
  onPick?: (hieroglyph: HieroglyphId) => void;
  /**
   * Column count. Default: 3 for up to six glyphs, 4 for 7..12 (three rows at most). The wall board passes 2
   * so its two or four walls come out as large tiles (one row of two, or a 2×2).
   */
  columns?: HieroglyphGridColumns;
  className?: string;
}

/** Columns used when none are given: the show's 3×2 for six, four columns (3 rows max) for up to twelve. */
export function defaultGridColumns(count: number): HieroglyphGridColumns {
  return count > 6 ? 4 : 3;
}

/** The hieroglyph picker: Two Reeds, Lion, Twisted Flax / Horned Viper, Water, Eye of Horus (4×3 for 12). */
export function HieroglyphGrid({ hieroglyphs = HIEROGLYPHS, used = [], highlight = null, onPick, columns, className }: HieroglyphGridProps) {
  const cols = columns ?? defaultGridColumns(hieroglyphs.length);
  const classes = ['oc-glyphgrid', `oc-glyphgrid--cols-${cols}`];
  if (cols === 4) classes.push('oc-glyphgrid--wide');
  if (className) classes.push(className);
  return (
    <div className={classes.join(' ')} role={onPick ? 'group' : undefined} data-columns={cols}>
      {hieroglyphs.map((id) => {
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
