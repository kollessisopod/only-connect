import { describe, expect, it } from 'vitest';
import type { Pack } from '../../types.js';
import { validatePack } from '../validate.js';
import { demoPack } from './fixtures.js';

function clone(pack: Pack): Pack {
  return JSON.parse(JSON.stringify(pack)) as Pack;
}

describe('validatePack', () => {
  it('accepts the demo pack (with and without media)', () => {
    expect(validatePack(demoPack())).toEqual([]);
    expect(validatePack(demoPack({ media: false }))).toEqual([]);
  });

  it('reports a missing connections question and the missing hieroglyph', () => {
    const pack = clone(demoPack());
    pack.questions = pack.questions.filter((q) => !(q.round === 'connections' && q.hieroglyph === 'lion'));
    const problems = validatePack(pack);
    expect(problems).toContain('Connections: needs exactly 6 questions (has 5)');
    expect(problems).toContain('Connections: no question for Lion');
  });

  it('reports a hieroglyph used twice in a round', () => {
    const pack = clone(demoPack());
    const q = pack.questions.find((x) => x.round === 'sequences' && x.hieroglyph === 'water');
    if (!q) throw new Error('fixture');
    q.hieroglyph = 'lion';
    const problems = validatePack(pack);
    expect(problems).toContain('Sequences: 2 questions use Lion');
    expect(problems).toContain('Sequences: no question for Water');
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

    const one = clone(demoPack());
    one.walls = one.walls.slice(0, 1);
    expect(validatePack(one)).toContain('Walls: needs exactly 2 walls (has 1)');
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
