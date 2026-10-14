/**
 * zod schemas for pack payloads (SPEC §5). These check *shape* only: playability (1..12 questions per round
 * with a hieroglyph each, 2 or 4 walls, ...) is reported by the engine's `validatePack` as `problems`, never
 * enforced on save, so the editor can store drafts. The only hard limits are the upper bounds nothing can
 * display: at most MAX_QUESTIONS_PER_ROUND questions per round and MAX_WALLS walls.
 */
import { z } from 'zod';
import { HIEROGLYPHS, MAX_QUESTIONS_PER_ROUND, MAX_WALLS } from '@only-connect/shared';

const text = z.string().max(2000);
const shortText = z.string().max(500);

export const hieroglyphSchema = z.enum(HIEROGLYPHS);

export const mediaRefSchema = z
  .object({
    key: z.string().min(1).max(500),
    url: z.string().min(1).max(600),
    mime: z.string().max(100).default('application/octet-stream'),
    name: z.string().max(300).default(''),
  })
  .strip();

export const clueSchema = z
  .object({
    kind: z.enum(['text', 'image', 'audio']),
    text: text.default(''),
    media: mediaRefSchema.nullable().optional(),
  })
  .strip();

export const questionSchema = z
  .object({
    id: z.string().max(200).optional(),
    round: z.enum(['connections', 'sequences']),
    hieroglyph: hieroglyphSchema,
    position: z.number().int().min(0).max(1000).default(0),
    clues: z.array(clueSchema).max(4),
    answer: shortText.default(''),
    note: text.nullable().optional(),
  })
  .strip();

export const wallGroupSchema = z
  .object({
    connection: shortText.default(''),
    clues: z.array(shortText).max(4),
  })
  .strip();

/**
 * `hieroglyph` is optional on input so exports made before walls had one (and editor drafts) can still be
 * saved: `normalisePackInput` gives such walls the first free glyph (`nextWallHieroglyph`).
 */
export const wallSchema = z
  .object({
    id: z.string().max(200).optional(),
    position: z.number().int().min(0).max(1000).default(0),
    hieroglyph: hieroglyphSchema.nullable().optional(),
    groups: z.array(wallGroupSchema).max(4),
  })
  .strip();

export const vowelClueSchema = z
  .object({
    answer: shortText.default(''),
    display: shortText.default(''),
  })
  .strip();

export const vowelGroupSchema = z
  .object({
    id: z.string().max(200).optional(),
    position: z.number().int().min(0).max(1000).default(0),
    category: shortText.default(''),
    clues: z.array(vowelClueSchema).max(50),
  })
  .strip();

/** Body of `PUT /api/admin/packs/:id` and `POST /api/admin/packs/import` (the id in the URL wins over any id in the body). */
export const packInputSchema = z
  .object({
    id: z.string().max(200).optional(),
    name: z.string().trim().min(1, 'name must not be empty').max(200),
    questions: z.array(questionSchema).max(100).default([]), // per-round cap below
    walls: z.array(wallSchema).max(MAX_WALLS, `at most ${MAX_WALLS} walls`).default([]),
    vowelGroups: z.array(vowelGroupSchema).max(100).default([]),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
  })
  .strip()
  .superRefine((pack, ctx) => {
    for (const round of ['connections', 'sequences'] as const) {
      const n = pack.questions.filter((q) => q.round === round).length;
      if (n > MAX_QUESTIONS_PER_ROUND) {
        ctx.addIssue({
          code: z.ZodIssueCode.too_big,
          maximum: MAX_QUESTIONS_PER_ROUND,
          type: 'array',
          inclusive: true,
          path: ['questions'],
          message: `at most ${MAX_QUESTIONS_PER_ROUND} ${round} questions (has ${n})`,
        });
      }
    }
  });

export type PackInput = z.infer<typeof packInputSchema>;

export const createPackSchema = z.object({ name: z.string().trim().min(1, 'name must not be empty').max(200) }).strip();

export const loginSchema = z.object({ username: z.string().max(200), password: z.string().max(200) }).strip();
