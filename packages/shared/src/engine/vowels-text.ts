import { hashString, mulberry32 } from './random.js';

const VOWELS = /[AEIOU]/g;

/**
 * Turns an answer into its Missing Vowels display form:
 *  - upper-cased,
 *  - A/E/I/O/U removed (every other character is kept),
 *  - the original spaces removed,
 *  - re-spaced into chunks of 2–4 characters chosen deterministically from the answer, never reproducing the
 *    original word boundaries when the answer has two or more words (so the display never gives them away).
 *
 * "POLE ARC CAP" -> e.g. "PLR CCP" or "PL RCC P".
 */
export function stripVowels(answer: string): string {
  const upper = answer.toUpperCase();
  const words = upper
    .split(/\s+/)
    .map((w) => w.replace(VOWELS, ''))
    .filter((w) => w.length > 0);
  const letters = words.join('');
  if (letters.length <= 1) return letters;

  const originalPattern = words.map((w) => w.length);
  const mustDiffer = words.length >= 2;
  const base = hashString(upper);

  for (let attempt = 0; attempt < 64; attempt++) {
    const chunks = randomChunks(letters.length, base + attempt);
    if (!mustDiffer || !sameLengths(chunks, originalPattern)) return render(letters, chunks);
  }
  // Deterministic fallback: two fixed patterns, at most one of which can equal the original.
  const alt1 = fixedChunks(letters.length, 2);
  if (!sameLengths(alt1, originalPattern)) return render(letters, alt1);
  return render(letters, fixedChunks(letters.length, 3));
}

/** Chunk lengths in 2..4 that sum to `total` (requires total >= 2), drawn from a seeded PRNG. */
function randomChunks(total: number, seed: number): number[] {
  const rnd = mulberry32(seed);
  const out: number[] = [];
  let remaining = total;
  while (remaining > 0) {
    if (remaining <= 4) {
      out.push(remaining);
      break;
    }
    const maxLen = Math.min(4, remaining - 2); // keep at least 2 for the next chunk
    const len = 2 + Math.floor(rnd() * (maxLen - 1));
    out.push(len);
    remaining -= len;
  }
  return out;
}

/** Alternating `first`, then 3/2, ... with the tail merged so every chunk stays within 2..4. */
function fixedChunks(total: number, first: 2 | 3): number[] {
  const out: number[] = [];
  let remaining = total;
  let next = first;
  while (remaining > 0) {
    if (remaining <= 4) {
      out.push(remaining);
      break;
    }
    const len = Math.min(next, remaining - 2);
    out.push(len);
    remaining -= len;
    next = next === 2 ? 3 : 2;
  }
  return out;
}

function sameLengths(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((n, i) => n === b[i]);
}

function render(letters: string, chunks: number[]): string {
  const parts: string[] = [];
  let pos = 0;
  for (const len of chunks) {
    parts.push(letters.slice(pos, pos + len));
    pos += len;
  }
  return parts.join(' ');
}
