import { describe, expect, it } from 'vitest';
import { stripVowels } from '../vowels-text.js';

const PHRASES = [
  'POLE ARC CAP',
  'Buenos Aires',
  'Kuala Lumpur',
  'Corn Flakes',
  'Rice Krispies',
  'Shredded Wheat',
  'Coco Pops',
  'The Lord of the Rings',
  'To be or not to be',
  'New York City',
  'Salt and vinegar',
  'A tale of two cities',
  'Fish and chips',
  'Jurassic Park',
  'Dr No',
  'Ice age',
  'Only Connect',
  'Victoria Coren Mitchell',
  'Cat on a hot tin roof',
  'Big Ben',
];

function consonantsOf(s: string): string {
  return s.toUpperCase().replace(/[AEIOU\s]/g, '');
}

function originalSpacing(s: string): string {
  return s
    .toUpperCase()
    .split(/\s+/)
    .map((w) => w.replace(/[AEIOU]/g, ''))
    .filter((w) => w.length > 0)
    .join(' ');
}

describe('stripVowels', () => {
  it('upper-cases, removes AEIOU and keeps the remaining characters in order', () => {
    const out = stripVowels('POLE ARC CAP');
    expect(out).not.toMatch(/[AEIOU]/);
    expect(out.replace(/ /g, '')).toBe('PLRCCP');
    expect(out).toBe(out.toUpperCase());
  });

  it('is deterministic', () => {
    for (const p of PHRASES) expect(stripVowels(p)).toBe(stripVowels(p));
  });

  it('re-spaces into chunks of 2–4 characters', () => {
    for (const p of PHRASES) {
      const chunks = stripVowels(p).split(' ');
      for (const c of chunks) {
        expect(c.length, `${p} -> ${stripVowels(p)}`).toBeGreaterThanOrEqual(2);
        expect(c.length, `${p} -> ${stripVowels(p)}`).toBeLessThanOrEqual(4);
      }
      expect(chunks.join('')).toBe(consonantsOf(p));
    }
  });

  it('never reproduces the original word boundaries for multi-word answers', () => {
    for (const p of PHRASES) {
      if (p.trim().split(/\s+/).length < 2) continue;
      expect(stripVowels(p), p).not.toBe(originalSpacing(p));
    }
  });

  it('handles very short and empty inputs', () => {
    expect(stripVowels('')).toBe('');
    expect(stripVowels('A')).toBe('');
    expect(stripVowels('B')).toBe('B');
    expect(stripVowels('Eye')).toBe('Y');
    expect(stripVowels('Be ok')).toBe('BK');
    expect(stripVowels('   ')).toBe('');
  });

  it('keeps digits and punctuation', () => {
    const out = stripVowels("Rock 'n' roll");
    expect(out.replace(/ /g, '')).toBe("RCK'N'RLL");
    expect(stripVowels('Catch-22').replace(/ /g, '')).toBe('CTCH-22');
  });

  it('treats Y as a consonant', () => {
    expect(stripVowels('Yoyo')).toBe('YY');
  });
});
