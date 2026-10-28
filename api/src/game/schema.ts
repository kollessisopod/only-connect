/**
 * zod schema for the `AdminAction` union (SPEC §5 `POST /api/admin/actions`). Payloads are validated
 * structurally here; whether an action is *allowed right now* is the engine's job (GameError -> 400).
 */
import { z } from 'zod';
import { CUE_NAMES, HIEROGLYPHS, MAX_TEAMS, MIN_TEAMS, TEAM_IDS, type AdminAction } from '@only-connect/shared';

export const teamIdSchema = z.enum(TEAM_IDS);
export const hieroglyphSchema = z.enum(HIEROGLYPHS);
export const roundNameSchema = z.enum(['connections', 'sequences', 'wall', 'vowels']);
export const cueNameSchema = z.enum(CUE_NAMES);

const name = z.string().trim().min(1).max(60);
const id = z.string().min(1).max(200);

/**
 * The teams of a new game (V3.2): 2..4 entries, each a distinct colour id with a name (empty → the default
 * name, the engine fills it in). Structural only — whether the pack has enough walls for that many teams is
 * the engine's call (`not_enough_walls`).
 */
export const newGameTeamsSchema = z
  .array(z.object({ id: teamIdSchema, name: z.string().max(60) }).strict())
  .min(MIN_TEAMS)
  .max(MAX_TEAMS)
  .refine((teams) => new Set(teams.map((t) => t.id)).size === teams.length, { message: 'each team can play only once' });

/**
 * A round's turn order (`round:start {order}`): 2..4 distinct team ids. That it is a permutation of the
 * game's *active* teams depends on the state, so the engine checks it (`invalid_order`).
 */
export const roundOrderSchema = z
  .array(teamIdSchema)
  .min(MIN_TEAMS)
  .max(MAX_TEAMS)
  .refine((order) => new Set(order).size === order.length, { message: 'a team cannot appear twice in the order' });

const simpleTypes = [
  'game:lobby',
  'game:undo',
  'q:reveal',
  'q:correct',
  'q:incorrect',
  'q:stealIncorrect',
  'q:void',
  'q:timeUp',
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
  'vowels:nobody',
  'vowels:reopen',
  'vowels:next',
  'vowels:skipCategory',
  'round:final',
  'media:stop',
  'cue:stop',
] as const;

const simple = simpleTypes.map((t) => z.object({ type: z.literal(t) }).strict());

export const adminActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('game:new'), packId: id, teams: newGameTeamsSchema }).strict(),
  z.object({ type: z.literal('game:setTeamName'), team: teamIdSchema, name }).strict(),
  z.object({ type: z.literal('game:adjustScore'), team: teamIdSchema, delta: z.number().int().min(-100).max(100) }).strict(),
  z.object({ type: z.literal('game:removePlayer'), playerId: id }).strict(),
  z.object({ type: z.literal('round:start'), round: roundNameSchema, order: roundOrderSchema.optional() }).strict(),
  z.object({ type: z.literal('q:select'), hieroglyph: hieroglyphSchema }).strict(),
  // The stealing team (V3.2): the host names it with three or more teams; with two it may be left out (the
  // other team). Whether it is active and not the answering team is the engine's check.
  z.object({ type: z.literal('q:stealCorrect'), team: teamIdSchema.optional() }).strict(),
  // The admin's wall pick. The player's tile tap (`wall:select {tileId}`) shares the type name but never
  // comes through this schema: the socket handler builds it from `wallSelectPayloadSchema` (SPEC §4).
  z.object({ type: z.literal('wall:select'), hieroglyph: hieroglyphSchema }).strict(),
  // The team that answered after a wrong buzz (V3.2); like the steal, optional only with two teams.
  z.object({ type: z.literal('vowels:otherCorrect'), team: teamIdSchema.optional() }).strict(),
  z.object({ type: z.literal('media:play'), clueIndex: z.number().int().min(0).max(3).optional() }).strict(),
  z.object({ type: z.literal('cue:play'), cue: cueNameSchema }).strict(),
  ...simple,
]);

export type AdminActionInput = z.infer<typeof adminActionSchema>;

/** Parse an unknown body into an AdminAction, or return the zod error. */
export function parseAdminAction(body: unknown): { ok: true; action: AdminAction } | { ok: false; error: z.ZodError } {
  const result = adminActionSchema.safeParse(body);
  if (!result.success) return { ok: false, error: result.error };
  return { ok: true, action: result.data as AdminAction };
}

/** First zod issue as a readable one-liner: `teams.0.name: Required`. */
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
  // Any of the four colours is a valid id; that the team is playing this game (`team_inactive`) is
  // checked by the engine against `activeTeams`.
  team: teamIdSchema,
});
export const playerIdPayloadSchema = z.object({ playerId: z.string().min(1).max(200) });
export const wallSelectPayloadSchema = z.object({ tileId: z.number().int().min(0).max(15) });
