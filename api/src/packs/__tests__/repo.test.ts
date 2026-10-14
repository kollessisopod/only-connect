import { describe, expect, it } from 'vitest';
import { HIEROGLYPHS, MAX_QUESTIONS_PER_ROUND, MAX_WALLS, buildDemoPack, validatePack, type Pack, type Question, type Wall } from '@only-connect/shared';
import { clonePack, contentIds, normalisePackInput, reassignTakenIds, toSummary } from '../repo.js';
import { packInputSchema, type PackInput } from '../schema.js';

let n = 0;
const seq = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const TS = { createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-02T00:00:00.000Z' };

/** A connections question tagged `hieroglyph`, cloned from the demo pack's first one. */
function questionWith(demo: Pack, round: Question['round'], hieroglyph: Question['hieroglyph'], position: number): Question {
  const base = demo.questions.find((q) => q.round === round);
  if (!base) throw new Error('fixture');
  return { ...base, id: seq(), hieroglyph, position, clues: base.clues.map((c) => ({ ...c })), answer: `${base.answer} (${hieroglyph})` };
}

function wallWith(demo: Pack, hieroglyph: Wall['hieroglyph'], position: number): Wall {
  const base = demo.walls[0];
  return { id: seq(), position, hieroglyph, groups: base.groups.map((g) => ({ connection: g.connection, clues: [...g.clues] })) };
}

/** 12 questions per round (all twelve glyphs) and 4 walls with distinct glyphs: the largest playable pack. */
function maxPack(): Pack {
  const demo = buildDemoPack(seq);
  const questions = (['connections', 'sequences'] as const).flatMap((round) => HIEROGLYPHS.map((h, i) => questionWith(demo, round, h, i)));
  const walls = (['lion', 'water', 'ankh', 'sun'] as const).map((h, i) => wallWith(demo, h, i));
  return { ...demo, id: seq(), name: 'Maximal', questions, walls };
}

describe('reassignTakenIds', () => {
  it('keeps free ids untouched', () => {
    const pack = buildDemoPack(seq);
    const out = reassignTakenIds(pack, new Set(), seq);
    expect(out).toEqual(pack);
  });

  it('gives fresh ids to items whose id is taken by another pack', () => {
    const demo = buildDemoPack(seq);
    const copy = { ...clonePack(demo, demo.createdAt), questions: demo.questions, walls: demo.walls, vowelGroups: demo.vowelGroups };
    const taken = new Set(contentIds(demo));
    const out = reassignTakenIds(copy, taken, seq);
    expect(contentIds(out).some((id) => taken.has(id))).toBe(false);
    expect(new Set(contentIds(out)).size).toBe(contentIds(demo).length);
    expect(out.questions.map((q) => q.answer)).toEqual(demo.questions.map((q) => q.answer));
    expect(out.walls.map((w) => w.groups)).toEqual(demo.walls.map((w) => w.groups));
    expect(out.walls.map((w) => w.hieroglyph)).toEqual(['lion', 'water']);
  });

  it('de-duplicates ids repeated inside one payload', () => {
    const demo = buildDemoPack(seq);
    const dupId = demo.questions[0].id;
    const input = normalisePackInput(
      demo.id,
      { ...demo, questions: demo.questions.map((q) => ({ ...q, id: dupId })), walls: demo.walls, vowelGroups: demo.vowelGroups },
      { createdAt: demo.createdAt, updatedAt: demo.updatedAt },
    );
    const out = reassignTakenIds(input, new Set(), seq);
    const ids = out.questions.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe(dupId);
  });
});

describe('normalisePackInput', () => {
  it('keeps a valid pack as it is (demo pack round-trips, walls keep lion / water)', () => {
    const demo = buildDemoPack(seq);
    const out = normalisePackInput(demo.id, demo, { createdAt: demo.createdAt, updatedAt: demo.updatedAt });
    expect(out).toEqual(demo);
    expect(validatePack(out)).toEqual([]);
  });

  it('renumbers question positions 0..n-1 per round in position order, walls and vowel groups per pack', () => {
    const demo = buildDemoPack(seq);
    const scrambled: PackInput = {
      ...demo,
      questions: demo.questions.map((q) => ({ ...q, position: q.position * 10 + 5 })).reverse(),
      walls: demo.walls.map((w) => ({ ...w, position: 7 - w.position })),
      vowelGroups: demo.vowelGroups.map((g, i) => ({ ...g, position: 100 + i })),
    };
    const out = normalisePackInput(demo.id, scrambled, TS);
    for (const round of ['connections', 'sequences'] as const) {
      const inRound = out.questions.filter((q) => q.round === round);
      expect(inRound.map((q) => q.position)).toEqual([0, 1, 2, 3, 4, 5]);
      // Ordered by the positions that were sent, not by payload order.
      expect(inRound.map((q) => q.hieroglyph)).toEqual(demo.questions.filter((q) => q.round === round).map((q) => q.hieroglyph));
    }
    expect(out.walls.map((w) => w.position)).toEqual([0, 1]);
    expect(out.walls.map((w) => w.hieroglyph)).toEqual(['water', 'lion']); // the wall sent with the lower position comes first
    expect(out.vowelGroups.map((g) => g.position)).toEqual(demo.vowelGroups.map((_, i) => i));
    expect(validatePack(out)).toEqual([]);
  });

  it('assigns positions in payload order when they are missing or all equal', () => {
    const demo = buildDemoPack(seq);
    const flat: PackInput = { ...demo, questions: demo.questions.map((q) => ({ ...q, position: 0 })), walls: demo.walls.map((w) => ({ ...w, position: 0 })) };
    const out = normalisePackInput(demo.id, flat, TS);
    expect(out.questions.filter((q) => q.round === 'sequences').map((q) => q.position)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(out.questions.filter((q) => q.round === 'connections').map((q) => q.answer)).toEqual(
      demo.questions.filter((q) => q.round === 'connections').map((q) => q.answer),
    );
    expect(out.walls.map((w) => w.position)).toEqual([0, 1]);
    expect(validatePack(out)).toEqual([]);
  });

  it('gives walls without a hieroglyph the first free glyph (lion, water, then the rest) and keeps explicit ones', () => {
    const demo = buildDemoPack(seq);
    const noGlyphs: PackInput = { ...demo, walls: demo.walls.map((w) => ({ id: w.id, position: w.position, groups: w.groups })) };
    expect(normalisePackInput(demo.id, noGlyphs, TS).walls.map((w) => w.hieroglyph)).toEqual(['lion', 'water']);

    const four: PackInput = {
      ...demo,
      walls: [
        { ...demo.walls[0], hieroglyph: 'water' },
        { ...demo.walls[1], hieroglyph: null },
        { ...wallWith(demo, 'lion', 2), hieroglyph: undefined },
        { ...wallWith(demo, 'sun', 3) },
      ],
    };
    const out = normalisePackInput(demo.id, four, TS);
    expect(out.walls.map((w) => w.hieroglyph)).toEqual(['water', 'lion', 'twoReeds', 'sun']);
    expect(validatePack(out)).toEqual([]);
  });

  it('keeps duplicate explicit wall glyphs so validatePack can report them', () => {
    const demo = buildDemoPack(seq);
    const dup: PackInput = { ...demo, walls: demo.walls.map((w) => ({ ...w, hieroglyph: 'lion' })) };
    const out = normalisePackInput(demo.id, dup, TS);
    expect(out.walls.map((w) => w.hieroglyph)).toEqual(['lion', 'lion']);
    expect(toSummary(out).problems).toContain('Walls: 2 walls use Lion');
  });

  it('a 12-question / 4-wall pack is playable', () => {
    const pack = maxPack();
    const out = normalisePackInput(pack.id, pack, TS);
    expect(out.questions.filter((q) => q.round === 'connections').map((q) => q.hieroglyph)).toEqual([...HIEROGLYPHS]);
    expect(out.walls.map((w) => w.hieroglyph)).toEqual(['lion', 'water', 'ankh', 'sun']);
    expect(toSummary(out)).toMatchObject({ playable: true, problems: [] });
  });
});

describe('packInputSchema bounds', () => {
  it('accepts up to 12 questions per round and 4 walls, rejects more', () => {
    const pack = maxPack();
    expect(packInputSchema.safeParse(pack).success).toBe(true);
    const demo = buildDemoPack(seq);
    const thirteen = { ...pack, questions: [...pack.questions, questionWith(demo, 'connections', 'lion', 12)] };
    const tooManyQ = packInputSchema.safeParse(thirteen);
    expect(tooManyQ.success).toBe(false);
    if (!tooManyQ.success) expect(tooManyQ.error.issues[0]).toMatchObject({ path: ['questions'], message: `at most ${MAX_QUESTIONS_PER_ROUND} connections questions (has 13)` });
    const five = { ...pack, walls: [...pack.walls, wallWith(demo, 'owl', 4)] };
    const tooManyW = packInputSchema.safeParse(five);
    expect(tooManyW.success).toBe(false);
    if (!tooManyW.success) expect(tooManyW.error.issues[0]).toMatchObject({ path: ['walls'], message: `at most ${MAX_WALLS} walls` });
  });

  it('drafts are shape-checked only: no questions / walls is fine, a missing wall glyph is fine, an unknown one is not', () => {
    const demo = buildDemoPack(seq);
    expect(packInputSchema.safeParse({ name: 'Draft' }).success).toBe(true);
    expect(packInputSchema.safeParse({ name: 'Draft', walls: [{ groups: [] }] }).success).toBe(true);
    expect(packInputSchema.safeParse({ ...demo, walls: demo.walls.map((w) => ({ ...w, hieroglyph: 'sphinx' })) }).success).toBe(false);
    expect(packInputSchema.safeParse({ ...demo, questions: demo.questions.map((q) => ({ ...q, hieroglyph: 'sphinx' })) }).success).toBe(false);
    for (const h of HIEROGLYPHS) {
      expect(packInputSchema.safeParse({ name: 'x', questions: [{ ...demo.questions[0], hieroglyph: h }], walls: [{ ...demo.walls[0], hieroglyph: h }] }).success, h).toBe(true);
    }
  });
});
