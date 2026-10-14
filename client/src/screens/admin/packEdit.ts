/**
 * Pure helpers for editing a Pack in local state. Every function returns a new Pack and keeps the Pack type
 * exact (no extra keys, no `undefined` members so the JSON round-trips unchanged).
 */
import {
  HIEROGLYPHS,
  MAX_QUESTIONS_PER_ROUND,
  MAX_WALLS,
  nextWallHieroglyph,
  stripVowels,
  type Clue,
  type ClueKind,
  type Hieroglyph,
  type MediaRef,
  type Pack,
  type Question,
  type QuestionRound,
  type VowelClue,
  type VowelGroup,
  type Wall,
  type WallGroup,
} from '@only-connect/shared';
import { newId } from './ui';

export function questionsFor(pack: Pack, round: QuestionRound): Question[] {
  return pack.questions.filter((q) => q.round === round).sort((a, b) => a.position - b.position);
}

function renumber(pack: Pack): Pack {
  const questions: Question[] = [];
  for (const round of ['connections', 'sequences'] as const) {
    questionsFor(pack, round).forEach((q, i) => questions.push(q.position === i ? q : { ...q, position: i }));
  }
  return { ...pack, questions };
}

export function emptyClue(): Clue {
  return { kind: 'text', text: '' };
}

export function firstFreeHieroglyph(pack: Pack, round: QuestionRound): Hieroglyph {
  const used = new Set(questionsFor(pack, round).map((q) => q.hieroglyph));
  return HIEROGLYPHS.find((h) => !used.has(h)) ?? HIEROGLYPHS[0];
}

/** Adds a question to the round (no-op once the round holds `MAX_QUESTIONS_PER_ROUND`). */
export function addQuestion(pack: Pack, round: QuestionRound): Pack {
  if (questionsFor(pack, round).length >= MAX_QUESTIONS_PER_ROUND) return pack;
  const q: Question = {
    id: newId(),
    round,
    hieroglyph: firstFreeHieroglyph(pack, round),
    position: questionsFor(pack, round).length,
    clues: [emptyClue(), emptyClue(), emptyClue(), emptyClue()],
    answer: '',
  };
  return renumber({ ...pack, questions: [...pack.questions, q] });
}

export function removeQuestion(pack: Pack, id: string): Pack {
  return renumber({ ...pack, questions: pack.questions.filter((q) => q.id !== id) });
}

/** Moves a question one step up (-1) or down (+1) within its round and renumbers the positions. */
export function moveQuestion(pack: Pack, id: string, delta: -1 | 1): Pack {
  const q = pack.questions.find((x) => x.id === id);
  if (!q) return pack;
  const sorted = questionsFor(pack, q.round);
  const from = sorted.findIndex((x) => x.id === id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= sorted.length) return pack;
  const [item] = sorted.splice(from, 1);
  sorted.splice(to, 0, item);
  const reordered = sorted.map((x, i) => ({ ...x, position: i }));
  return { ...pack, questions: pack.questions.map((x) => reordered.find((r) => r.id === x.id) ?? x) };
}

export function updateQuestion(pack: Pack, id: string, patch: Partial<Omit<Question, 'id' | 'round'>>): Pack {
  return {
    ...pack,
    questions: pack.questions.map((q) => {
      if (q.id !== id) return q;
      const next: Question = { ...q, ...patch };
      if ('note' in patch && (patch.note === undefined || patch.note === '')) delete next.note;
      return next;
    }),
  };
}

/** Hieroglyphs used more than once within a round. */
export function duplicateHieroglyphs(pack: Pack, round: QuestionRound): Set<Hieroglyph> {
  const counts = new Map<Hieroglyph, number>();
  for (const q of questionsFor(pack, round)) counts.set(q.hieroglyph, (counts.get(q.hieroglyph) ?? 0) + 1);
  return new Set([...counts.entries()].filter(([, n]) => n > 1).map(([h]) => h));
}

export function updateClue(pack: Pack, questionId: string, index: number, patch: Partial<Clue>): Pack {
  return {
    ...pack,
    questions: pack.questions.map((q) => {
      if (q.id !== questionId) return q;
      // A question loaded with fewer than 4 clues is shown padded; editing a padded row must persist.
      const padded = [...q.clues];
      while (padded.length < 4) padded.push(emptyClue());
      const clues = padded.map((c, i) => {
        if (i !== index) return c;
        const next: Clue = { ...c, ...patch };
        if ('media' in patch && !patch.media) delete next.media;
        return next;
      });
      return { ...q, clues };
    }),
  };
}

export function setClueKind(pack: Pack, questionId: string, index: number, kind: ClueKind): Pack {
  const q = pack.questions.find((x) => x.id === questionId);
  const clue = q?.clues[index];
  if (!clue) return pack;
  if (kind === 'text') return updateClue(pack, questionId, index, { kind, media: undefined });
  // Keep media only if it matches the new kind.
  const keep = clue.media && clue.media.mime.startsWith(kind === 'image' ? 'image/' : 'audio/');
  return updateClue(pack, questionId, index, { kind, media: keep ? clue.media : undefined });
}

/** After an upload: attach the media and switch the clue kind to match the file (a text clue becomes image/audio). */
export function attachMedia(pack: Pack, questionId: string, index: number, media: MediaRef): Pack {
  const kind: ClueKind = media.mime.startsWith('audio/') ? 'audio' : 'image';
  return updateClue(pack, questionId, index, { kind, media });
}

// ---------------------------------------------------------------------------
// Walls
// ---------------------------------------------------------------------------

export function emptyWallGroup(): WallGroup {
  return { connection: '', clues: ['', '', '', ''] };
}

/**
 * Adds a wall tagged with the first free glyph (lion, water, then the rest of the twelve). No-op once the pack
 * holds `MAX_WALLS`; the pack needs an even number (2 or 4), which `validatePack` reports.
 */
export function addWall(pack: Pack): Pack {
  if (pack.walls.length >= MAX_WALLS) return pack;
  const wall: Wall = {
    id: newId(),
    position: pack.walls.length,
    hieroglyph: nextWallHieroglyph(pack.walls) ?? HIEROGLYPHS[0],
    groups: [emptyWallGroup(), emptyWallGroup(), emptyWallGroup(), emptyWallGroup()],
  };
  return { ...pack, walls: [...pack.walls, wall] };
}

export function removeWall(pack: Pack, id: string): Pack {
  return { ...pack, walls: pack.walls.filter((w) => w.id !== id).map((w, i) => (w.position === i ? w : { ...w, position: i })) };
}

export function updateWall(pack: Pack, id: string, patch: Partial<Omit<Wall, 'id'>>): Pack {
  return { ...pack, walls: pack.walls.map((w) => (w.id === id ? { ...w, ...patch } : w)) };
}

/** Hieroglyphs used by more than one wall of the pack. */
export function duplicateWallHieroglyphs(pack: Pack): Set<Hieroglyph> {
  const counts = new Map<Hieroglyph, number>();
  for (const w of pack.walls) counts.set(w.hieroglyph, (counts.get(w.hieroglyph) ?? 0) + 1);
  return new Set([...counts.entries()].filter(([, n]) => n > 1).map(([h]) => h));
}

export function updateWallGroup(pack: Pack, wallId: string, groupIndex: number, patch: Partial<WallGroup>): Pack {
  return {
    ...pack,
    walls: pack.walls.map((w) => {
      if (w.id !== wallId) return w;
      const groups = [...w.groups];
      while (groups.length < 4) groups.push(emptyWallGroup());
      groups[groupIndex] = { ...groups[groupIndex], ...patch };
      return { ...w, groups };
    }),
  };
}

export function updateWallClue(pack: Pack, wallId: string, groupIndex: number, clueIndex: number, text: string): Pack {
  const wall = pack.walls.find((w) => w.id === wallId);
  const group = wall?.groups[groupIndex] ?? emptyWallGroup();
  const clues = [...group.clues];
  while (clues.length < 4) clues.push('');
  clues[clueIndex] = text;
  return updateWallGroup(pack, wallId, groupIndex, { clues });
}

// ---------------------------------------------------------------------------
// Missing vowels
// ---------------------------------------------------------------------------

export function addVowelGroup(pack: Pack): Pack {
  const group: VowelGroup = {
    id: newId(),
    position: pack.vowelGroups.length,
    category: '',
    clues: [emptyVowelClue(), emptyVowelClue(), emptyVowelClue(), emptyVowelClue()],
  };
  return { ...pack, vowelGroups: [...pack.vowelGroups, group] };
}

export function emptyVowelClue(): VowelClue {
  return { answer: '', display: '' };
}

export function removeVowelGroup(pack: Pack, id: string): Pack {
  return {
    ...pack,
    vowelGroups: pack.vowelGroups.filter((g) => g.id !== id).map((g, i) => (g.position === i ? g : { ...g, position: i })),
  };
}

export function moveVowelGroup(pack: Pack, id: string, delta: -1 | 1): Pack {
  const sorted = [...pack.vowelGroups].sort((a, b) => a.position - b.position);
  const from = sorted.findIndex((g) => g.id === id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= sorted.length) return pack;
  const [item] = sorted.splice(from, 1);
  sorted.splice(to, 0, item);
  return { ...pack, vowelGroups: sorted.map((g, i) => ({ ...g, position: i })) };
}

export function updateVowelGroup(pack: Pack, id: string, patch: Partial<Omit<VowelGroup, 'id'>>): Pack {
  return { ...pack, vowelGroups: pack.vowelGroups.map((g) => (g.id === id ? { ...g, ...patch } : g)) };
}

export function addVowelClue(pack: Pack, groupId: string): Pack {
  const g = pack.vowelGroups.find((x) => x.id === groupId);
  if (!g) return pack;
  return updateVowelGroup(pack, groupId, { clues: [...g.clues, emptyVowelClue()] });
}

export function removeVowelClue(pack: Pack, groupId: string, index: number): Pack {
  const g = pack.vowelGroups.find((x) => x.id === groupId);
  if (!g) return pack;
  return updateVowelGroup(pack, groupId, { clues: g.clues.filter((_, i) => i !== index) });
}

/**
 * Sets a clue's answer. The display is regenerated with `stripVowels` unless the host edited it by hand
 * (i.e. it differs from what the previous answer would have generated).
 */
export function setVowelAnswer(pack: Pack, groupId: string, index: number, answer: string): Pack {
  const g = pack.vowelGroups.find((x) => x.id === groupId);
  const clue = g?.clues[index];
  if (!g || !clue) return pack;
  const wasAuto = clue.display === '' || clue.display === stripVowels(clue.answer);
  const display = wasAuto ? stripVowels(answer) : clue.display;
  return updateVowelGroup(pack, groupId, { clues: g.clues.map((c, i) => (i === index ? { answer, display } : c)) });
}

export function setVowelDisplay(pack: Pack, groupId: string, index: number, display: string): Pack {
  const g = pack.vowelGroups.find((x) => x.id === groupId);
  if (!g) return pack;
  return updateVowelGroup(pack, groupId, { clues: g.clues.map((c, i) => (i === index ? { ...c, display } : c)) });
}

export function regenerateVowelDisplay(pack: Pack, groupId: string, index: number): Pack {
  const g = pack.vowelGroups.find((x) => x.id === groupId);
  const clue = g?.clues[index];
  if (!g || !clue) return pack;
  return setVowelDisplay(pack, groupId, index, stripVowels(clue.answer));
}

/** Rough per-tab problem counts from `validatePack` output (by the message prefix the engine uses). */
export function problemsByTab(problems: string[]): Record<'connections' | 'sequences' | 'walls' | 'vowels' | 'other', string[]> {
  const out = { connections: [] as string[], sequences: [] as string[], walls: [] as string[], vowels: [] as string[], other: [] as string[] };
  for (const p of problems) {
    if (p.startsWith('Connections')) out.connections.push(p);
    else if (p.startsWith('Sequences')) out.sequences.push(p);
    else if (p.startsWith('Wall')) out.walls.push(p);
    else if (p.startsWith('Missing Vowels')) out.vowels.push(p);
    else out.other.push(p);
  }
  return out;
}
