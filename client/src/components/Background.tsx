import type { ReactNode } from 'react';
import './Background.css';

/**
 * `blue` / `purple` are the show's two team backdrops (blue team / pink team); `green` and `orange` are the
 * same drawing in the colours of the two extra teams (V3.2); `grey` is the flat lower panel. Which team gets
 * which variant is decided in `teamColours.ts` (`teamBackground`).
 */
export type BackgroundVariant = 'blue' | 'purple' | 'green' | 'orange' | 'grey';
export type TintedBackgroundVariant = Exclude<BackgroundVariant, 'grey'>;
export const TINTED_BACKGROUND_VARIANTS: readonly TintedBackgroundVariant[] = ['blue', 'purple', 'green', 'orange'];

export interface BackgroundProps {
  variant?: BackgroundVariant;
  className?: string;
  children?: ReactNode;
}

interface Ring {
  r1: number;
  r2: number;
  count: number;
  /** fraction of each slot left empty between segments */
  gap: number;
  /** rotation offset in radians */
  rot: number;
  opacity: number;
}

const CX = 960;
const CY = 540;

// Three concentric rings; the outer one runs off-screen like the show graphic. In the reference frames the
// segments are only a touch lighter than the gaps (~10/255 per channel): the glow is the feature, not the rings.
const RINGS: Ring[] = [
  { r1: 290, r2: 480, count: 18, gap: 0.065, rot: 0.09, opacity: 0.12 },
  { r1: 520, r2: 820, count: 16, gap: 0.055, rot: -0.12, opacity: 0.11 },
  { r1: 860, r2: 1320, count: 22, gap: 0.045, rot: 0.05, opacity: 0.09 },
];

function pt(r: number, a: number): string {
  return `${(CX + r * Math.cos(a)).toFixed(1)},${(CY + r * Math.sin(a)).toFixed(1)}`;
}

/** Tapered trapezoid (straight edges) between radii r1..r2 spanning angles a0..a1. */
function segment(r1: number, r2: number, a0: number, a1: number): string {
  const mid = (a0 + a1) / 2;
  // Straight outer/inner edges, with a slight bulge so wide segments do not look flat.
  return `M${pt(r1, a0)} L${pt(r2, a0)} Q${pt(r2 * 1.03, mid)} ${pt(r2, a1)} L${pt(r1, a1)} Q${pt(r1 * 1.015, mid)} ${pt(r1, a0)} Z`;
}

function buildRings(): { d: string; opacity: number }[] {
  const out: { d: string; opacity: number }[] = [];
  for (const ring of RINGS) {
    const slot = (Math.PI * 2) / ring.count;
    const span = slot * (1 - ring.gap);
    for (let i = 0; i < ring.count; i += 1) {
      const a0 = ring.rot + i * slot + (slot - span) / 2;
      // Slight per-segment variation so the ring does not look machine-perfect.
      const wobble = 0.85 + 0.3 * Math.abs(Math.sin(i * 2.399 + ring.r1));
      out.push({ d: segment(ring.r1, ring.r2, a0, a0 + span), opacity: ring.opacity * wobble });
    }
  }
  return out;
}

const RING_SEGMENTS = buildRings();

const RING_COLOURS: Record<TintedBackgroundVariant, { inner: string; outer: string }> = {
  blue: { inner: '#3a4ad8', outer: '#2a38b8' },
  purple: { inner: '#c45ef0', outer: '#a52be0' },
  green: { inner: '#4fd98a', outer: '#23b35f' },
  orange: { inner: '#ffb24d', outer: '#f08a10' },
};

function RingPattern({ variant }: { variant: TintedBackgroundVariant }) {
  const id = `oc-ring-${variant}`;
  const stops = RING_COLOURS[variant];
  return (
    <svg
      className="oc-bg__rings"
      viewBox="0 0 1920 1080"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <radialGradient id={id} cx={CX} cy={CY} r={1320} gradientUnits="userSpaceOnUse">
          <stop offset="0.22" stopColor={stops.inner} />
          <stop offset="0.5" stopColor={stops.outer} />
          <stop offset="1" stopColor={stops.outer} stopOpacity="0.55" />
        </radialGradient>
      </defs>
      <g fill={`url(#${id})`}>
        {RING_SEGMENTS.map((s, i) => (
          <path key={i} d={s.d} fillOpacity={s.opacity} />
        ))}
      </g>
    </svg>
  );
}

/**
 * Full-bleed background. `blue` / `purple` draw the show's radial glow with the ring-of-segments
 * pattern; `grey` is the flat lower panel used on answer reveals and the final scores.
 */
/**
 * Owner-supplied studio backdrop (client/public/assets/title_upscaled.png). When present it replaces the drawn
 * ring pattern and stays behind every screen; a colour tint keeps the team variant and text legibility.
 * Set to null to go back to the drawn rings.
 */
export const BACKGROUND_IMAGE: string | null = '/assets/title_upscaled.png';

export function Background({ variant = 'blue', className, children }: BackgroundProps) {
  const image = variant !== 'grey' && BACKGROUND_IMAGE;
  return (
    <div className={`oc-bg oc-bg--${variant}${image ? ' oc-bg--image' : ''}${className ? ` ${className}` : ''}`}>
      {/* Everything static (picture, tint, vignette) sits in one contained, composited layer, so updates to
          the content in front (tiles, timer, text) never repaint the big image. */}
      <div className="oc-bg__backdrop" aria-hidden="true">
        {image ? (
          <>
            <img className="oc-bg__image" src={image} alt="" draggable={false} />
            <div className={`oc-bg__tint oc-bg__tint--${variant}`} />
          </>
        ) : (
          variant !== 'grey' && <RingPattern variant={variant} />
        )}
        {variant !== 'grey' && <div className="oc-bg__vignette" />}
      </div>
      <div className="oc-bg__content">{children}</div>
    </div>
  );
}

export default Background;
