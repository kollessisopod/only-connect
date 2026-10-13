import { describe, expect, it } from 'vitest';
import { buildDemoPack } from '@only-connect/shared';
import { clonePack, contentIds, normalisePackInput, reassignTakenIds } from '../repo.js';

let n = 0;
const seq = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

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
