import { HIEROGLYPHS, HIEROGLYPH_LABELS, type Hieroglyph as HieroglyphId, type PublicClue } from '@only-connect/shared';
import { useRef, type CSSProperties } from 'react';
import { ClueTile, type ClueRowClue } from './ClueRow';
import { Hieroglyph } from './Hieroglyph';
import { Tile } from './Tile';
import './HieroglyphGrid.css';

export type HieroglyphGridColumns = 2 | 3 | 4;

/**
 * The chosen tile's looks during the show's pick-to-question intro (see MonitorView, V3.1): `pulse`, then
 * `whoosh` (the tile shooting out, the first HIEROGLYPH_WHOOSH_MS of the engine's `empty` phase) and `empty`
 * (the bare slot) — one element and one animation, the name is what the slot reports — then `clue`.
 */
export type HieroglyphIntroPhase = 'pulse' | 'whoosh' | 'empty' | 'clue';

/** How long the whoosh takes (HieroglyphGrid.css); the slot reports `whoosh` for that long, then `empty`. */
export const HIEROGLYPH_WHOOSH_MS = 120;

export interface HieroglyphIntro {
  /** The glyph just picked: its tile is the one animated (it is in `used` already, but is not drawn dark). */
  hieroglyph: HieroglyphId;
  phase: HieroglyphIntroPhase;
  /**
   * Ms since this phase began on the server clock (`whoosh` and `empty` count from the same moment), at the
   * first render of the phase. The phase's keyframe animation starts that far in (a negative
   * `animation-delay`), so a screen joining mid-intro is in step with the others: the pulse at the same point
   * of its cycle, a whoosh or unfold already over. Captured once per phase (see IntroTile) so later
   * re-renders do not re-seek a running animation.
   */
  elapsedMs: number;
  /**
   * Distinguishes one intro from the next (the pick time, say) when the same tile is picked twice — a pick
   * undone and made again — so the captured `elapsedMs` is taken afresh.
   */
  key: string | number;
  /** The first clue, drawn in the chosen tile's slot during `clue`. */
  clue: ClueRowClue | PublicClue | null;
}

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
  /** The pick-to-question intro playing on this board (the monitor, stage `question` before `startedAt`). */
  intro?: HieroglyphIntro | null;
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

/**
 * The chosen tile during the intro, in the chosen glyph's grid cell. `pulse`: the glyph tile, light, pulsing
 * between two cyans; `whoosh` / `empty`: the glyph tile folding up into its own top edge (~120 ms, in place),
 * then an invisible tile that keeps the cell's size; `clue`: the first clue on a light tile of the glyph
 * tile's size, unfolding in the cell from its bottom edge (~120 ms), then still. Each look is its own element (keyed), so its
 * animation starts fresh with the elapsed time as a negative delay — captured once per look and intro, since
 * a changing delay re-seeks the running animation on every re-render of the board. The slot carries
 * `data-testid="intro-tile"` and `data-intro-phase` (the e2e script observes the sequence through them).
 */
function IntroTile({ id, intro }: { id: HieroglyphId; intro: HieroglyphIntro }) {
  const look = intro.phase === 'whoosh' || intro.phase === 'empty' ? 'out' : intro.phase;
  const captured = useRef<{ key: string; elapsedMs: number } | null>(null);
  const key = `${String(intro.key)}:${look}`;
  if (captured.current?.key !== key) captured.current = { key, elapsedMs: Math.max(0, intro.elapsedMs) };
  const style = { '--oc-intro-delay': `${-captured.current.elapsedMs}ms` } as CSSProperties;
  const label = HIEROGLYPH_LABELS[id];

  if (intro.phase === 'clue') {
    const clue = intro.clue ?? { kind: 'text', text: null, mediaUrl: null, revealed: false };
    return (
      <div key="clue" className="oc-glyphgrid__slot is-clue" style={style} data-testid="intro-tile" data-intro-phase="clue">
        <ClueTile clue={clue} captions={false} size="glyph" />
      </div>
    );
  }

  return (
    <Tile
      key={look}
      size="glyph"
      raw
      variant="light"
      className={`oc-glyphgrid__pick ${look === 'pulse' ? 'is-pulse' : 'is-whoosh'}`}
      style={style}
      aria-label={`${label} (chosen)`}
      title={label}
      data-testid="intro-tile"
      data-intro-phase={intro.phase}
    >
      <Hieroglyph hieroglyph={id} />
    </Tile>
  );
}

/** The hieroglyph picker: Two Reeds, Lion, Twisted Flax / Horned Viper, Water, Eye of Horus (4×3 for 12). */
export function HieroglyphGrid({
  hieroglyphs = HIEROGLYPHS,
  used = [],
  highlight = null,
  intro = null,
  onPick,
  columns,
  className,
}: HieroglyphGridProps) {
  const cols = columns ?? defaultGridColumns(hieroglyphs.length);
  const classes = ['oc-glyphgrid', `oc-glyphgrid--cols-${cols}`];
  if (cols === 4) classes.push('oc-glyphgrid--wide');
  if (className) classes.push(className);
  return (
    <div className={classes.join(' ')} role={onPick ? 'group' : undefined} data-columns={cols}>
      {hieroglyphs.map((id) => {
        if (intro && intro.hieroglyph === id) return <IntroTile key={id} id={id} intro={intro} />;
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
