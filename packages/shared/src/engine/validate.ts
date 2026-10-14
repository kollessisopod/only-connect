import {
  HIEROGLYPHS,
  HIEROGLYPH_LABELS,
  MAX_QUESTIONS_PER_ROUND,
  MAX_WALLS,
  MIN_QUESTIONS_PER_ROUND,
  MIN_WALLS,
  type Clue,
  type Pack,
  type Question,
  type QuestionRound,
} from '../types.js';
import { stripVowels } from './vowels-text.js';

const ROUND_LABELS: Record<QuestionRound, string> = {
  connections: 'Connections',
  sequences: 'Sequences',
};

function blank(value: unknown): boolean {
  return typeof value !== 'string' || value.trim().length === 0;
}

function clueProblems(clue: Clue | undefined, where: string): string[] {
  const problems: string[] = [];
  if (!clue) {
    problems.push(`${where}: missing clue`);
    return problems;
  }
  if (clue.kind !== 'text' && clue.kind !== 'image' && clue.kind !== 'audio') {
    problems.push(`${where}: unknown clue kind "${String(clue.kind)}"`);
    return problems;
  }
  if (clue.kind === 'text') {
    if (blank(clue.text)) problems.push(`${where}: text clue is empty`);
  } else {
    if (!clue.media || blank(clue.media.key) || blank(clue.media.url)) {
      problems.push(`${where}: ${clue.kind} clue has no uploaded media`);
    }
    if (blank(clue.text)) problems.push(`${where}: ${clue.kind} clue needs a caption`);
  }
  return problems;
}

function questionProblems(q: Question, label: string): string[] {
  const problems: string[] = [];
  const clues = Array.isArray(q.clues) ? q.clues : [];
  if (clues.length !== 4) problems.push(`${label}: must have exactly 4 clues (has ${clues.length})`);
  for (let i = 0; i < Math.min(4, Math.max(clues.length, 0)); i++) {
    problems.push(...clueProblems(clues[i], `${label}, clue ${i + 1}`));
  }
  if (blank(q.answer)) problems.push(`${label}: answer is empty`);
  return problems;
}

/** Problems that make a pack unplayable. An empty array means the pack is playable. */
export function validatePack(pack: Pack): string[] {
  const problems: string[] = [];
  if (!pack || typeof pack !== 'object') return ['pack is missing'];
  if (blank(pack.name)) problems.push('Pack name is empty');

  const questions = Array.isArray(pack.questions) ? pack.questions : [];
  for (const round of ['connections', 'sequences'] as const) {
    const roundLabel = ROUND_LABELS[round];
    const inRound = questions.filter((q) => q.round === round);
    const n = inRound.length;
    if (n < MIN_QUESTIONS_PER_ROUND || n > MAX_QUESTIONS_PER_ROUND) {
      problems.push(`${roundLabel}: needs ${MIN_QUESTIONS_PER_ROUND} to ${MAX_QUESTIONS_PER_ROUND} questions (has ${n})`);
    }
    for (const h of HIEROGLYPHS) {
      const count = inRound.filter((q) => q.hieroglyph === h).length;
      if (count > 1) problems.push(`${roundLabel}: ${count} questions use ${HIEROGLYPH_LABELS[h]}`);
    }
    const positions = inRound.map((q) => q.position);
    const expected = Array.from({ length: n }, (_, i) => i);
    if (n > 0 && !expected.every((p) => positions.includes(p))) {
      problems.push(`${roundLabel}: question positions must be 0 to ${n - 1}, each used once (has ${positions.join(', ')})`);
    }
    for (const q of inRound) {
      const known = HIEROGLYPHS.includes(q.hieroglyph);
      const label = `${roundLabel} ${known ? HIEROGLYPH_LABELS[q.hieroglyph] : `question ${q.position + 1}`}`;
      if (!known) problems.push(`${label}: unknown hieroglyph "${String(q.hieroglyph)}"`);
      problems.push(...questionProblems(q, label));
    }
  }
  for (const q of questions) {
    if (q.round !== 'connections' && q.round !== 'sequences') {
      problems.push(`Question "${q.id}": unknown round "${String(q.round)}"`);
    }
  }

  const walls = Array.isArray(pack.walls) ? pack.walls : [];
  // Teams alternate choosing walls (A, B, A, B), so a pack holds an even number: exactly 2 or 4.
  if (walls.length < MIN_WALLS || walls.length > MAX_WALLS || walls.length % 2 !== 0) {
    problems.push(`Walls: needs ${MIN_WALLS} or ${MAX_WALLS} walls (has ${walls.length})`);
  }
  for (const h of HIEROGLYPHS) {
    const count = walls.filter((w) => w.hieroglyph === h).length;
    if (count > 1) problems.push(`Walls: ${count} walls use ${HIEROGLYPH_LABELS[h]}`);
  }
  walls.forEach((wall, wi) => {
    const label = `Wall ${wi + 1}`;
    if (!HIEROGLYPHS.includes(wall.hieroglyph)) {
      problems.push(
        wall.hieroglyph === undefined || wall.hieroglyph === null
          ? `${label}: needs a hieroglyph`
          : `${label}: unknown hieroglyph "${String(wall.hieroglyph)}"`,
      );
    }
    const groups = Array.isArray(wall.groups) ? wall.groups : [];
    if (groups.length !== 4) problems.push(`${label}: must have exactly 4 groups (has ${groups.length})`);
    const seen = new Map<string, number>();
    groups.forEach((g, gi) => {
      const glabel = `${label}, group ${gi + 1}`;
      if (blank(g.connection)) problems.push(`${glabel}: connection is empty`);
      const clues = Array.isArray(g.clues) ? g.clues : [];
      if (clues.length !== 4) problems.push(`${glabel}: must have exactly 4 clues (has ${clues.length})`);
      clues.forEach((c, ci) => {
        if (blank(c)) {
          problems.push(`${glabel}, clue ${ci + 1}: empty`);
          return;
        }
        const key = c.trim().toLowerCase();
        const prev = seen.get(key);
        if (prev !== undefined) problems.push(`${label}: "${c.trim()}" appears more than once`);
        else seen.set(key, gi);
      });
    });
  });

  const groups = Array.isArray(pack.vowelGroups) ? pack.vowelGroups : [];
  if (groups.length === 0) problems.push('Missing Vowels: needs at least 1 category');
  groups.forEach((g, gi) => {
    const label = `Missing Vowels category ${gi + 1}`;
    if (blank(g.category)) problems.push(`${label}: category name is empty`);
    const clues = Array.isArray(g.clues) ? g.clues : [];
    if (clues.length === 0) problems.push(`${label}: needs at least 1 clue`);
    clues.forEach((c, ci) => {
      if (blank(c.answer)) problems.push(`${label}, clue ${ci + 1}: answer is empty`);
      if (blank(c.display)) {
        problems.push(
          !blank(c.answer) && stripVowels(c.answer) === ''
            ? `${label}, clue ${ci + 1}: the answer has no consonants, so nothing can be shown — type a display by hand or choose another answer`
            : `${label}, clue ${ci + 1}: display is empty`,
        );
      }
    });
  });

  return problems;
}
