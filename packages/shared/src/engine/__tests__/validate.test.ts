import { describe, expect, it } from 'vitest';
import { HIEROGLYPHS, MAX_QUESTIONS_PER_ROUND, MAX_WALLS, MIN_WALLS, type Hieroglyph, type Pack } from '../../types.js';
import { validatePack } from '../validate.js';
import { customPack, demoPack } from './fixtures.js';

function clone(pack: Pack): Pack {
  return JSON.parse(JSON.stringify(pack)) as Pack;
}

describe('validatePack', () => {
  it('accepts the demo pack (with and without media)', () => {
    expect(validatePack(demoPack())).toEqual([]);
    expect(validatePack(demoPack({ media: false }))).toEqual([]);
  });

  it('accepts any round size from 1 to 12 questions and 2 or 4 walls', () => {
    expect(HIEROGLYPHS).toHaveLength(MAX_QUESTIONS_PER_ROUND);
    for (const n of [1, 2, 5, 7, 12]) expect(validatePack(customPack({ connections: n, sequences: 13 - n })), `${n} questions`).toEqual([]);
    for (const n of [2, 4]) expect(validatePack(customPack({ walls: n })), `${n} walls`).toEqual([]);
    expect(MIN_WALLS).toBe(2);
    expect(MAX_WALLS).toBe(4);
  });

  it('rejects rounds with 0 or more than 12 questions', () => {
    const none = clone(demoPack());
    none.questions = none.questions.filter((q) => q.round !== 'connections');
    expect(validatePack(none)).toContain('Connections: needs 1 to 12 questions (has 0)');
    expect(validatePack(none).filter((p) => p.startsWith('Sequences'))).toEqual([]);

    const tooMany = customPack({ sequences: 12 });
    const extra = { ...tooMany.questions[tooMany.questions.length - 1], id: 'thirteen', position: 12, hieroglyph: 'sphinx' as Hieroglyph };
    tooMany.questions.push(extra);
    const problems = validatePack(tooMany);
    expect(problems).toContain('Sequences: needs 1 to 12 questions (has 13)');
    expect(problems).toContain('Sequences question 13: unknown hieroglyph "sphinx"');
  });

  it('rejects 0, 1, 3 or 5 walls (teams alternate, so 2 or 4)', () => {
    const none = clone(demoPack());
    none.walls = [];
    expect(validatePack(none)).toEqual(['Walls: needs 2 or 4 walls (has 0)']);
    expect(validatePack(customPack({ walls: 1 }))).toEqual(['Walls: needs 2 or 4 walls (has 1)']);
    expect(validatePack(customPack({ walls: 3 }))).toEqual(['Walls: needs 2 or 4 walls (has 3)']);
    const five = customPack({ walls: 4 });
    five.walls.push({ ...five.walls[0], id: 'wall-5', position: 4, hieroglyph: 'sun' });
    expect(validatePack(five)).toEqual(['Walls: needs 2 or 4 walls (has 5)']);
  });

  it('requires a known hieroglyph per wall, unique among the pack walls', () => {
    const dup = clone(demoPack());
    dup.walls[1].hieroglyph = 'lion';
    expect(validatePack(dup)).toEqual(['Walls: 2 walls use Lion']);
    const unknown = clone(demoPack());
    unknown.walls[1].hieroglyph = 'sphinx' as Hieroglyph;
    expect(validatePack(unknown)).toEqual(['Wall 2: unknown hieroglyph "sphinx"']);
    const missing = clone(demoPack());
    delete (missing.walls[0] as Partial<Pack['walls'][number]>).hieroglyph;
    expect(validatePack(missing)).toEqual(['Wall 1: needs a hieroglyph']);
    // Any of the twelve glyphs will do, not just the show's lion / water.
    const any = clone(demoPack());
    any.walls[0].hieroglyph = 'sun';
    any.walls[1].hieroglyph = 'twoReeds';
    expect(validatePack(any)).toEqual([]);
  });

  it('a round does not need every hieroglyph, only distinct ones', () => {
    const pack = clone(demoPack());
    pack.questions = pack.questions.filter((q) => !(q.round === 'connections' && q.hieroglyph === 'lion'));
    pack.questions.filter((q) => q.round === 'connections').forEach((q, i) => (q.position = i));
    expect(validatePack(pack)).toEqual([]);
  });

  it('reports a hieroglyph used twice in a round', () => {
    const pack = clone(demoPack());
    const q = pack.questions.find((x) => x.round === 'sequences' && x.hieroglyph === 'water');
    if (!q) throw new Error('fixture');
    q.hieroglyph = 'lion';
    const problems = validatePack(pack);
    expect(problems).toEqual(['Sequences: 2 questions use Lion']);
  });

  it('reports question positions that are not 0..n-1', () => {
    const gap = clone(demoPack());
    gap.questions = gap.questions.filter((q) => !(q.round === 'connections' && q.hieroglyph === 'lion'));
    expect(validatePack(gap)).toEqual(['Connections: question positions must be 0 to 4, each used once (has 0, 2, 3, 4, 5)']);
    const dup = clone(demoPack());
    dup.questions.filter((q) => q.round === 'sequences')[2].position = 0;
    expect(validatePack(dup)).toEqual(['Sequences: question positions must be 0 to 5, each used once (has 0, 1, 0, 3, 4, 5)']);
  });

  it('reports bad clues and empty answers', () => {
    const pack = clone(demoPack());
    const q = pack.questions[0];
    q.clues[1] = { kind: 'text', text: '  ' };
    q.clues[2] = { kind: 'image', text: 'caption' };
    q.answer = '';
    const problems = validatePack(pack);
    expect(problems.some((p) => p.includes('clue 2: text clue is empty'))).toBe(true);
    expect(problems.some((p) => p.includes('clue 3: image clue has no uploaded media'))).toBe(true);
    expect(problems.some((p) => p.endsWith('answer is empty'))).toBe(true);
  });

  it('reports a question with the wrong number of clues', () => {
    const pack = clone(demoPack());
    pack.questions[3].clues = pack.questions[3].clues.slice(0, 3);
    expect(validatePack(pack).some((p) => p.includes('must have exactly 4 clues (has 3)'))).toBe(true);
  });

  it('reports wall problems', () => {
    const pack = clone(demoPack());
    pack.walls[0].groups = pack.walls[0].groups.slice(0, 3);
    pack.walls[1].groups[0].clues[0] = '';
    pack.walls[1].groups[1].connection = '';
    pack.walls[1].groups[2].clues[1] = pack.walls[1].groups[3].clues[2];
    const problems = validatePack(pack);
    expect(problems).toContain('Wall 1: must have exactly 4 groups (has 3)');
    expect(problems).toContain('Wall 2, group 1, clue 1: empty');
    expect(problems).toContain('Wall 2, group 2: connection is empty');
    expect(problems.some((p) => p.startsWith('Wall 2: "') && p.endsWith('appears more than once'))).toBe(true);
  });

  it('reports missing vowels problems', () => {
    const pack = clone(demoPack());
    pack.vowelGroups = [];
    expect(validatePack(pack)).toContain('Missing Vowels: needs at least 1 category');

    const pack2 = clone(demoPack());
    pack2.vowelGroups[0].clues = [];
    pack2.vowelGroups[1].category = '';
    pack2.vowelGroups[2].clues[0].display = '';
    const problems = validatePack(pack2);
    expect(problems).toContain('Missing Vowels category 1: needs at least 1 clue');
    expect(problems).toContain('Missing Vowels category 2: category name is empty');
    expect(problems).toContain('Missing Vowels category 3, clue 1: display is empty');
  });

  it('tolerates structurally broken input instead of crashing', () => {
    const broken = { id: 'x', name: '', questions: null, walls: undefined, vowelGroups: 'nope' } as unknown as Pack;
    const problems = validatePack(broken);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems).toContain('Pack name is empty');
  });
});
