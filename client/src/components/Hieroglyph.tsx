import { HIEROGLYPH_LABELS, type Hieroglyph as HieroglyphId } from '@only-connect/shared';
import { InlineSvg, loadSvg } from './InlineSvg';
import './Hieroglyph.css';

const FILE_NAMES: Record<HieroglyphId, string> = {
  twoReeds: 'two-reeds',
  lion: 'lion',
  twistedFlax: 'twisted-flax',
  hornedViper: 'horned-viper',
  water: 'water',
  eyeOfHorus: 'eye-of-horus',
  ankh: 'ankh',
  scarab: 'scarab',
  feather: 'feather',
  owl: 'owl',
  cobra: 'cobra',
  sun: 'sun',
};

export function hieroglyphAssetPath(id: HieroglyphId): string {
  return `/assets/hieroglyph-${FILE_NAMES[id]}.svg`;
}

/** Warm the cache for all twelve glyphs (call once on the monitor so the grid never pops in). */
export function preloadHieroglyphs(): Promise<void> {
  return Promise.all(
    (Object.keys(FILE_NAMES) as HieroglyphId[]).map((id) => loadSvg(hieroglyphAssetPath(id)).catch(() => '')),
  ).then(() => undefined);
}

export interface HieroglyphProps {
  hieroglyph: HieroglyphId;
  className?: string;
}

/**
 * Inline white-stroke hieroglyph. The SVG file is fetched once (module cache) and injected so it
 * inherits `currentColor` and scales crisply. Falls back to the label if the asset is missing.
 */
export function Hieroglyph({ hieroglyph, className }: HieroglyphProps) {
  return (
    <InlineSvg
      src={hieroglyphAssetPath(hieroglyph)}
      label={HIEROGLYPH_LABELS[hieroglyph]}
      className={`oc-glyph oc-glyph--${hieroglyph}${className ? ` ${className}` : ''}`}
    />
  );
}

export default Hieroglyph;
