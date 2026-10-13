import {
  HIEROGLYPHS,
  HIEROGLYPH_LABELS,
  QUESTIONS_PER_ROUND,
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
    if (inRound.length !== QUESTIONS_PER_ROUND) {
      problems.push(`${roundLabel}: needs exactly ${QUESTIONS_PER_ROUND} questions (has ${inRound.length})`);
    }
    for (const h of HIEROGLYPHS) {
      const count = inRound.filter((q) => q.hieroglyph === h).length;
      if (count === 0) problems.push(`${roundLabel}: no question for ${HIEROGLYPH_LABELS[h]}`);
      else if (count > 1) problems.push(`${roundLabel}: ${count} questions use ${HIEROGLYPH_LABELS[h]}`);
    }
    for (const q of inRound) {
      const label = `${roundLabel} ${HIEROGLYPH_LABELS[q.hieroglyph] ?? String(q.hieroglyph)}`;
      if (!HIEROGLYPHS.includes(q.hieroglyph)) problems.push(`${label}: unknown hieroglyph`);
      problems.push(...questionProblems(q, label));
    }
  }
  for (const q of questions) {
    if (q.round !== 'connections' && q.round !== 'sequences') {
      problems.push(`Question "${q.id}": unknown round "${String(q.round)}"`);
    }
  }

  const walls = Array.isArray(pack.walls) ? pack.walls : [];
  if (walls.length !== 2) problems.push(`Walls: needs exactly 2 walls (has ${walls.length})`);
  walls.forEach((wall, wi) => {
    const label = `Wall ${wi + 1}`;
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
