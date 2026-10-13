/**
 * SVG generators for the demo pack's image clues: four "single disc" flags and four phases of the Moon.
 * Drawn from scratch with simple shapes (flags are geometric designs, not copyrightable artwork).
 */

function svg(width: number, height: number, body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>\n`;
}

/** A plain field with one disc. */
function discFlag(width: number, height: number, field: string, disc: string, cx: number, r: number): string {
  return svg(width, height, `<rect width="${width}" height="${height}" fill="${field}"/><circle cx="${cx}" cy="${height / 2}" r="${r}" fill="${disc}"/>`);
}

export function flagPalau(): string {
  // 5:8, light blue field, golden full moon slightly towards the hoist.
  return discFlag(800, 500, '#4aadd6', '#ffde00', 360, 150);
}

export function flagBangladesh(): string {
  // 3:5, bottle green field, red disc centred at 9/20 of the length with radius 1/5 of the length.
  return discFlag(600, 360, '#006a4e', '#f42a41', 270, 120);
}

export function flagJapan(): string {
  // 2:3, white field, crimson disc of 3/5 the height.
  return discFlag(600, 400, '#ffffff', '#bc002d', 300, 120);
}

export function flagLaos(): string {
  // 2:3, red-blue-red horizontal 1:2:1, white disc with diameter 4/5 of the blue band.
  const w = 600;
  const h = 400;
  return svg(
    w,
    h,
    `<rect width="${w}" height="${h}" fill="#ce1126"/>` +
      `<rect y="${h / 4}" width="${w}" height="${h / 2}" fill="#002868"/>` +
      `<circle cx="${w / 2}" cy="${h / 2}" r="${(h / 2) * 0.4}" fill="#ffffff"/>`,
  );
}

/**
 * Phase of the Moon as seen from the northern hemisphere (waxing = lit on the right).
 * `illuminated` is the lit fraction 0..1 (0 new, 0.25 waxing crescent, 0.5 first quarter, 0.75 waxing gibbous).
 */
export function moonPhase(illuminated: number): string {
  const size = 400;
  const c = size / 2;
  const r = 150;
  const sky = '#0b1026';
  const dark = '#242a3d';
  const lit = '#f4f1de';
  const f = Math.max(0, Math.min(1, illuminated));
  const stars = [
    [40, 60], [90, 330], [350, 70], [370, 300], [200, 20], [30, 200], [380, 190], [120, 380], [300, 385],
  ]
    .map(([x, y]) => `<circle cx="${x}" cy="${y}" r="1.8" fill="#9aa3c4"/>`)
    .join('');
  let litShape = '';
  if (f > 0) {
    // Right half of the disc...
    const rightHalf = `M ${c} ${c - r} A ${r} ${r} 0 0 1 ${c} ${c + r} Z`;
    litShape += `<path d="${rightHalf}" fill="${lit}"/>`;
    // ...plus/minus the terminator ellipse.
    const rx = Math.abs(2 * f - 1) * r;
    if (rx > 0.5) {
      const colour = f < 0.5 ? dark : lit;
      litShape += `<ellipse cx="${c}" cy="${c}" rx="${rx.toFixed(1)}" ry="${r}" fill="${colour}"/>`;
    }
  }
  const body =
    `<rect width="${size}" height="${size}" fill="${sky}"/>${stars}` +
    `<circle cx="${c}" cy="${c}" r="${r}" fill="${dark}"/>` +
    litShape +
    `<circle cx="${c}" cy="${c}" r="${r}" fill="none" stroke="#525a78" stroke-width="2"/>`;
  return svg(size, size, body);
}

/** Demo image clues keyed by the file name used in the demo pack. */
export const DEMO_IMAGES: Record<string, () => string> = {
  'flag-palau.svg': flagPalau,
  'flag-bangladesh.svg': flagBangladesh,
  'flag-laos.svg': flagLaos,
  'flag-japan.svg': flagJapan,
  'moon-new.svg': () => moonPhase(0),
  'moon-waxing-crescent.svg': () => moonPhase(0.25),
  'moon-first-quarter.svg': () => moonPhase(0.5),
  'moon-waxing-gibbous.svg': () => moonPhase(0.75),
};
