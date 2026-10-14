import type { ClueKind, PublicClue } from '@only-connect/shared';
import { memo, type CSSProperties, type ReactNode } from 'react';
import { InlineSvg } from './InlineSvg';
import { PointsBadge, type PointsClock } from './PointsBadge';
import { Tile, type TileSize } from './Tile';
import './ClueRow.css';

export const GRAMOPHONE_SRC = '/assets/gramophone.svg';
export const PICTURE_SRC = '/assets/picture.svg';

export interface ClueRowClue {
  kind: ClueKind;
  /** Clue text (or the media caption once the answer stage sends it). Null until revealed. */
  text: string | null;
  mediaUrl: string | null;
  revealed: boolean;
  /** Sequences 4th tile: shows a big "?" until revealed. */
  isQuestionMark?: boolean;
}

export interface ClueRowProps {
  /** Exactly 4 entries (PublicClue is compatible). */
  clues: ReadonlyArray<ClueRowClue | PublicClue>;
  /** Answer stage: media tiles show their caption text. */
  captions?: boolean;
  /**
   * Points badge above the last revealed tile (5 points -> tile 1, 3 -> 2, 2 -> 3, 1 -> 4, as in the show).
   * `undefined` = no badge row at all; `null` = keep the row's space but hide the badge (prevents the tiles
   * jumping when the badge disappears).
   */
  points?: number | null;
  /**
   * The 40 s question clock (stage `question`): the badge is then the timer (see PointsBadge). Omit for a
   * static badge (steal / answer).
   */
  clock?: PointsClock;
  /** Rendered full row width directly under the tiles (usually a TeamBar). */
  footer?: ReactNode;
  className?: string;
}

export interface ClueTileProps {
  clue: ClueRowClue | PublicClue;
  /** Answer stage: a media tile shows its caption text. */
  captions?: boolean;
  /** `clue` (the row's tiles) by default; the monitor's intro draws the first clue at the glyph tile's size. */
  size?: TileSize;
}

/**
 * One tile. Memoised so a parent that re-renders on a clock tick (the monitor's 40 s question clock lives in
 * the row's footer) leaves the four tiles alone as long as the clue objects themselves are unchanged. Exported
 * for the hieroglyph board's intro (V3.1), which puts the first clue in the chosen glyph's cell.
 */
export const ClueTile = memo(function ClueTile({ clue, captions = false, size = 'clue' }: ClueTileProps) {
  const qm = 'isQuestionMark' in clue && clue.isQuestionMark === true;

  if (!clue.revealed) {
    if (qm) {
      return (
        <Tile size={size} raw className="oc-clue--qm" aria-label="unknown fourth item">
          <span className="oc-clue__qm">?</span>
        </Tile>
      );
    }
    return <Tile size={size} variant="dark" aria-label="hidden clue" />;
  }

  if (clue.kind === 'text') {
    return <Tile size={size}>{clue.text ?? ''}</Tile>;
  }

  const caption = captions && clue.text ? clue.text : null;
  const media =
    clue.kind === 'audio' ? (
      <InlineSvg className="oc-clue__icon" src={GRAMOPHONE_SRC} label="audio clue" fallback="♪" />
    ) : clue.mediaUrl ? (
      <img className="oc-clue__image" src={clue.mediaUrl} alt={clue.text ?? 'picture clue'} draggable={false} />
    ) : (
      <InlineSvg className="oc-clue__icon" src={PICTURE_SRC} label="picture clue" fallback="▣" />
    );

  return (
    <Tile size={size} raw className={caption ? 'oc-clue--captioned' : undefined}>
      <div className="oc-clue__media">{media}</div>
      {caption && <div className="oc-clue__caption">{caption}</div>}
    </Tile>
  );
});

/** Grid column (1-based) the points badge sits above: the last tile revealed when that many points were on offer. */
export function badgeColumn(points: number): number {
  switch (points) {
    case 5:
      return 1;
    case 3:
      return 2;
    case 2:
      return 3;
    default:
      return 4;
  }
}

/**
 * Four clue tiles (82 % width, 8 px gaps) with the optional points badge above and a footer below. The badge
 * sits in a slot over a four-column track and glides (400 ms) to the column of the newly revealed tile when
 * the points change, instead of jumping; the row's height never depends on where the badge is.
 */
export function ClueRow({ clues, captions = false, points, clock, footer, className }: ClueRowProps) {
  const four = clues.slice(0, 4);
  while (four.length < 4) four.push({ kind: 'text', text: null, mediaUrl: null, revealed: false });

  return (
    <div className={`oc-cluerow${className ? ` ${className}` : ''}`}>
      {points !== undefined && (
        <div className="oc-cluerow__badges" aria-hidden={points === null}>
          <div className="oc-cluerow__badge-slot" style={{ '--oc-badge-col': badgeColumn(points ?? 2) - 1 } as CSSProperties}>
            {points !== null && <PointsBadge points={points} clock={clock} />}
          </div>
        </div>
      )}
      <div className="oc-cluerow__tiles">
        {four.map((clue, i) => (
          <ClueTile key={i} clue={clue} captions={captions} />
        ))}
      </div>
      {footer !== undefined && footer !== null && <div className="oc-cluerow__footer">{footer}</div>}
    </div>
  );
}

export default ClueRow;
