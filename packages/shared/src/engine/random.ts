/**
 * Deterministic randomness for the engine. Everything here is pure: the same seed always produces the same
 * sequence, so the API and every client can reproduce a shuffle from the seed stored in the game state.
 */

/** Normalises any number into an unsigned 32-bit integer seed (NaN -> 0). */
export function toSeed(seed: number): number {
  if (!Number.isFinite(seed)) return 0;
  return Math.floor(seed) >>> 0;
}

/** mulberry32: a small, fast 32-bit PRNG. Returns a function producing floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = toSeed(seed);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic Fisher–Yates shuffle. Never mutates `items`. */
export function shuffleWithSeed<T>(items: readonly T[], seed: number): T[] {
  const out = items.slice();
  const rnd = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

/** FNV-1a 32-bit hash of a string (unsigned). Used to derive seeds from text. */
export function hashString(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
