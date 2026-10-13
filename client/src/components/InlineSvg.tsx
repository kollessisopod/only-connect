import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';

const pending = new Map<string, Promise<string>>();
const resolved = new Map<string, string>();

/** Keep only the <svg> element; drop XML prologs / doctype / comments. */
function extractSvg(text: string): string {
  const start = text.indexOf('<svg');
  const end = text.lastIndexOf('</svg>');
  if (start < 0 || end < 0) throw new Error('not an svg');
  return text.slice(start, end + '</svg>'.length);
}

/** Fetches a same-origin SVG asset once (module cache) and returns its markup. */
export function loadSvg(src: string): Promise<string> {
  const cached = resolved.get(src);
  if (cached !== undefined) return Promise.resolve(cached);
  let p = pending.get(src);
  if (!p) {
    p = fetch(src, { cache: 'force-cache' })
      .then((res) => {
        if (!res.ok) throw new Error(`${res.status} loading ${src}`);
        return res.text();
      })
      .then((text) => {
        const svg = extractSvg(text);
        resolved.set(src, svg);
        return svg;
      })
      .finally(() => {
        pending.delete(src);
      });
    pending.set(src, p);
  }
  return p;
}

export interface InlineSvgProps {
  /** Same-origin path, e.g. "/assets/gramophone.svg". */
  src: string;
  /** Accessible name; the element is role="img". */
  label: string;
  className?: string;
  style?: CSSProperties;
  /** Shown while loading / if the asset is missing (defaults to nothing while loading, label on error). */
  fallback?: ReactNode;
}

/**
 * Inlines an SVG asset so it can use `currentColor` and scale crisply. Our own static assets are
 * the only sources, so injecting the markup is safe.
 */
export function InlineSvg({ src, label, className, style, fallback }: InlineSvgProps) {
  const [svg, setSvg] = useState<string | null>(() => resolved.get(src) ?? null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setFailed(false);
    const cached = resolved.get(src);
    if (cached !== undefined) {
      setSvg(cached);
    } else {
      setSvg(null);
      loadSvg(src)
        .then((text) => {
          if (alive) setSvg(text);
        })
        .catch(() => {
          if (alive) setFailed(true);
        });
    }
    return () => {
      alive = false;
    };
  }, [src]);

  if (svg) {
    return (
      <span
        className={`oc-svg${className ? ` ${className}` : ''}`}
        style={style}
        role="img"
        aria-label={label}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    );
  }
  return (
    <span className={`oc-svg oc-svg--pending${className ? ` ${className}` : ''}`} style={style} role="img" aria-label={label}>
      {failed ? (fallback ?? label) : null}
    </span>
  );
}

export default InlineSvg;
