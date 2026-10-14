/**
 * zod schema for the `AdminAction` union (SPEC §5 `POST /api/admin/actions`). Payloads are validated
 * structurally here; whether an action is *allowed right now* is the engine's job (GameError -> 400).
 */
import { z } from 'zod';
import { HIEROGLYPHS, TEAM_IDS, type AdminAction } from '@only-connect/shared';

export const teamIdSchema = z.enum(TEAM_IDS);
export const hieroglyphSchema = z.enum(HIEROGLYPHS);
export const roundNameSchema = z.enum(['connections', 'sequences', 'wall', 'vowels']);

const name = z.string().trim().min(1).max(60);
const id = z.string().min(1).max(200);

const simpleTypes = [
  'game:lobby',
  'game:undo',
  'q:reveal',
  'q:correct',
  'q:incorrect',
  'q:stealCorrect',
  'q:stealIncorrect',
  'q:void',
  'q:next',
  'wall:start',
  'wall:timeUp',
  'wall:abort',
  'wall:resolve',
  'wall:connectionCorrect',
  'wall:connectionIncorrect',
  'wall:finish',
  'wall:clear',
  'vowels:showClue',
  'vowels:correct',
  'vowels:incorrect',
  'vowels:otherCorrect',
  'vowels:nobody',
  'vowels:reopen',
  'vowels:next',
  'vowels:skipCategory',
  'round:final',
  'media:stop',
] as const;

const simple = simpleTypes.map((t) => z.object({ type: z.literal(t) }).strict());

export const adminActionSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('game:new'),
      packId: id,
      teams: z.object({ pink: z.object({ name: z.string().max(60) }), blue: z.object({ name: z.string().max(60) }) }),
      firstTeam: teamIdSchema,
    })
    .strict(),
  z.object({ type: z.literal('game:setTeamName'), team: teamIdSchema, name }).strict(),
  z.object({ type: z.literal('game:adjustScore'), team: teamIdSchema, delta: z.number().int().min(-100).max(100) }).strict(),
  z.object({ type: z.literal('game:removePlayer'), playerId: id }).strict(),
  z.object({ type: z.literal('round:start'), round: roundNameSchema }).strict(),
  z.object({ type: z.literal('q:select'), hieroglyph: hieroglyphSchema }).strict(),
  // The admin's wall pick. The player's tile tap (`wall:select {tileId}`) shares the type name but never
  // comes through this schema: the socket handler builds it from `wallSelectPayloadSchema` (SPEC §4).
  z.object({ type: z.literal('wall:select'), hieroglyph: hieroglyphSchema }).strict(),
  z.object({ type: z.literal('media:play'), clueIndex: z.number().int().min(0).max(3).optional() }).strict(),
  ...simple,
]);

export type AdminActionInput = z.infer<typeof adminActionSchema>;

/** Parse an unknown body into an AdminAction, or return the zod error. */
export function parseAdminAction(body: unknown): { ok: true; action: AdminAction } | { ok: false; error: z.ZodError } {
  const result = adminActionSchema.safeParse(body);
  if (!result.success) return { ok: false, error: result.error };
  return { ok: true, action: result.data as AdminAction };
}

/** First zod issue as a readable one-liner: `teams.pink.name: Required`. */
export function describeZodError(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'invalid payload';
  const path = issue.path.join('.');
  return path ? `${path}: ${issue.message}` : issue.message;
}

// Socket payloads (namespace "/")
export const joinPayloadSchema = z.object({
  playerId: z.string().min(1).max(200).nullable().optional(),
  secret: z.string().min(1).max(200).nullable().optional(),
  name: z.string().trim().min(1).max(40),
  team: teamIdSchema,
});
export const playerIdPayloadSchema = z.object({ playerId: z.string().min(1).max(200) });
export const wallSelectPayloadSchema = z.object({ tileId: z.number().int().min(0).max(15) });
