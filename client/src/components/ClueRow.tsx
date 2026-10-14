import type { ClueKind, PublicClue } from '@only-connect/shared';
import { memo, type ReactNode } from 'react';
import { InlineSvg } from './InlineSvg';
import { PointsBadge } from './PointsBadge';
import { Tile } from './Tile';
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
  /** Rendered full row width directly under the tiles (usually a TeamBar). */
  footer?: ReactNode;
  className?: string;
}

/**
 * One tile. Memoised so a parent that re-renders on a clock tick (the monitor's 40 s question clock lives in
 * the row's footer) leaves the four tiles alone as long as the clue objects themselves are unchanged.
 */
const ClueTile = memo(function ClueTile({ clue, captions }: { clue: ClueRowClue | PublicClue; captions: boolean }) {
  const qm = 'isQuestionMark' in clue && clue.isQuestionMark === true;

  if (!clue.revealed) {
    if (qm) {
      return (
        <Tile size="clue" raw aria-label="unknown fourth item">
          <span className="oc-clue__qm">?</span>
        </Tile>
      );
    }
    return <Tile size="clue" variant="dark" aria-label="hidden clue" />;
  }

  if (clue.kind === 'text') {
    return <Tile size="clue">{clue.text ?? ''}</Tile>;
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
    <Tile size="clue" raw className={caption ? 'oc-clue--captioned' : undefined}>
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

/** Four clue tiles (78 % width, 8 px gaps) with the optional points badge above and a footer below. */
export function ClueRow({ clues, captions = false, points, footer, className }: ClueRowProps) {
  const four = clues.slice(0, 4);
  while (four.length < 4) four.push({ kind: 'text', text: null, mediaUrl: null, revealed: false });

  return (
    <div className={`oc-cluerow${className ? ` ${className}` : ''}`}>
      {points !== undefined && (
        <div className="oc-cluerow__badges" aria-hidden={points === null}>
          <div className="oc-cluerow__badge-slot" style={{ gridColumn: badgeColumn(points ?? 2) }}>
            {points !== null && <PointsBadge points={points} />}
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
