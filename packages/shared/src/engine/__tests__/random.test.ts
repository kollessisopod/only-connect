import { describe, expect, it } from 'vitest';
import { hashString, mulberry32, shuffleWithSeed } from '../random.js';

describe('mulberry32', () => {
  it('is deterministic for a seed and yields floats in [0, 1)', () => {
    const a = mulberry32(123);
    const b = mulberry32(123);
    for (let i = 0; i < 1000; i++) {
      const x = a();
      expect(x).toBe(b());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });

  it('produces different sequences for different seeds', () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    const seqA = Array.from({ length: 5 }, () => a());
    const seqB = Array.from({ length: 5 }, () => b());
    expect(seqA).not.toEqual(seqB);
  });

  it('tolerates non-integer, negative and NaN seeds', () => {
    expect(() => mulberry32(1.5)()).not.toThrow();
    expect(() => mulberry32(-7)()).not.toThrow();
    expect(mulberry32(NaN)()).toBe(mulberry32(0)());
  });
});

describe('shuffleWithSeed', () => {
  const items = Array.from({ length: 16 }, (_, i) => i);

  it('is a permutation that does not mutate its input', () => {
    const copy = items.slice();
    const out = shuffleWithSeed(items, 42);
    expect(items).toEqual(copy);
    expect([...out].sort((a, b) => a - b)).toEqual(items);
    expect(out).not.toBe(items);
  });

  it('is deterministic per seed and differs across seeds', () => {
    expect(shuffleWithSeed(items, 42)).toEqual(shuffleWithSeed(items, 42));
    expect(shuffleWithSeed(items, 42)).not.toEqual(shuffleWithSeed(items, 43));
    expect(shuffleWithSeed(items, 42)).not.toEqual(items);
  });

  it('handles empty and single-element arrays', () => {
    expect(shuffleWithSeed([], 1)).toEqual([]);
    expect(shuffleWithSeed(['x'], 1)).toEqual(['x']);
  });
});

describe('hashString', () => {
  it('is deterministic, unsigned and sensitive to input', () => {
    expect(hashString('POLE ARC CAP')).toBe(hashString('POLE ARC CAP'));
    expect(hashString('a')).not.toBe(hashString('b'));
    expect(hashString('')).toBeGreaterThanOrEqual(0);
  });
});
