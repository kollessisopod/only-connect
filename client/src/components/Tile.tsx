import {
  forwardRef,
  type CSSProperties,
  type HTMLAttributes,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import './Tile.css';

export type TileVariant = 'light' | 'dark' | 'group';
export type TileSize = 'clue' | 'wall' | 'glyph' | 'score';

export interface TileProps extends Omit<HTMLAttributes<HTMLDivElement>, 'children'> {
  variant?: TileVariant;
  /** Flat fill for `variant="group"` (one of WALL_GROUP_COLOURS). */
  groupColour?: string;
  size?: TileSize;
  /** Renders as the dark variant (wall selection, used hieroglyph). */
  selected?: boolean;
  /** Brief shake + red tint. Re-triggers whenever `flashKey` changes. */
  flash?: 'wrong' | null;
  flashKey?: string | number;
  /** Plain text children are wrapped so they centre and wrap to two lines. */
  children?: ReactNode;
  /** Set when the content is not text (image, glyph) so no text wrapper is used. */
  raw?: boolean;
  disabled?: boolean;
}

/**
 * Shrink factor for text that would otherwise be clipped (tiles have a fixed aspect ratio and hide overflow).
 * Clue tiles fit about three short lines; wall tiles one word of ~13 letters. Exported for the fixtures.
 */
export function textFit(size: TileSize, text: string): number {
  if (size === 'clue') {
    const n = text.trim().length;
    if (n <= 45) return 1;
    if (n <= 60) return 0.86;
    if (n <= 80) return 0.74;
    if (n <= 110) return 0.62;
    return 0.52;
  }
  if (size === 'wall') {
    const longest = text.split(/\s+/).reduce((m, w) => Math.max(m, w.length), 0);
    if (longest <= 11) return 1;
    return Math.max(0.42, 11 / longest);
  }
  return 1;
}

/**
 * The show's glossy tile. Light (clue), dark (unknown / selected / used), or a flat group colour.
 * Sizes set the aspect ratio and the clamp()ed font size; the parent sets the width.
 */
export const Tile = forwardRef<HTMLDivElement, TileProps>(function Tile(
  {
    variant = 'light',
    groupColour,
    size = 'clue',
    selected = false,
    flash = null,
    flashKey,
    children,
    raw = false,
    disabled = false,
    className,
    style,
    onClick,
    onKeyDown,
    ...rest
  },
  ref,
) {
  const effective: TileVariant = selected ? 'dark' : variant;
  const classes = [
    'oc-tile',
    `oc-tile--${effective}`,
    `oc-tile--${size}`,
    selected ? 'is-selected' : '',
    flash === 'wrong' ? 'oc-tile--wrong' : '',
    onClick ? 'is-interactive' : '',
    disabled ? 'is-disabled' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  const fit = !raw && typeof children === 'string' ? textFit(size, children) : 1;
  const vars: Record<string, string> = {};
  if (effective === 'group' && groupColour) vars['--oc-tile-group'] = groupColour;
  if (fit !== 1) vars['--oc-fit'] = String(fit);
  const mergedStyle: CSSProperties | undefined =
    Object.keys(vars).length > 0 ? ({ ...style, ...vars } as CSSProperties) : style;

  const handleKey = (e: KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(e);
    if (onClick && !disabled && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      onClick(e as unknown as MouseEvent<HTMLDivElement>);
    }
  };

  return (
    <div
      ref={ref}
      // key on flashKey so a repeated wrong guess restarts the animation
      key={flash === 'wrong' ? `wrong-${flashKey ?? ''}` : undefined}
      className={classes}
      style={mergedStyle}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick && !disabled ? 0 : undefined}
      aria-pressed={onClick ? selected : undefined}
      aria-disabled={disabled || undefined}
      onClick={disabled ? undefined : onClick}
      onKeyDown={onClick ? handleKey : onKeyDown}
      {...rest}
    >
      {raw ? children : <span className="oc-tile__text">{children}</span>}
    </div>
  );
});

export default Tile;
