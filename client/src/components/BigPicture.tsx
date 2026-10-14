import { memo } from 'react';
import './BigPicture.css';

export interface BigPictureProps {
  /** Picture clue url (the public state only carries it once the clue is revealed). */
  url: string;
  alt: string;
  className?: string;
}

/**
 * A revealed picture clue shown large (V3, SPEC §3.1): the clue tiles are too small for the players to make a
 * picture out the first time it appears, so the monitor also shows the latest one in the free upper part of
 * the frame. The parent box sets the available area; the picture keeps its aspect ratio inside a light
 * tile-style frame. Keyed on the url so a new picture fades/scales in while the old one is replaced at once.
 *
 * The frame measures itself against the parent with container-query units (`cqh` / `cqw`), because a
 * percentage `max-height` on an image inside a shrink-wrapped frame does not resolve.
 */
export const BigPicture = memo(function BigPicture({ url, alt, className }: BigPictureProps) {
  return (
    <div className={`oc-bigpic${className ? ` ${className}` : ''}`}>
      <div key={url} className="oc-bigpic__frame">
        <img className="oc-bigpic__img" src={url} alt={alt} draggable={false} decoding="async" />
      </div>
    </div>
  );
});

export default BigPicture;
