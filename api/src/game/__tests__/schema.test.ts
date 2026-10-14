import { describe, expect, it } from 'vitest';
import { adminActionSchema, describeZodError, joinPayloadSchema, parseAdminAction, wallSelectPayloadSchema } from '../schema.js';

describe('adminActionSchema', () => {
  it('accepts every payload-free action type', () => {
    for (const type of [
      'game:lobby', 'q:reveal', 'q:correct', 'q:incorrect', 'q:stealCorrect', 'q:stealIncorrect', 'q:next',
      'wall:start', 'wall:timeUp', 'wall:resolve', 'wall:connectionCorrect', 'wall:connectionIncorrect', 'wall:finish',
      'wall:clear', 'vowels:showClue', 'vowels:correct', 'vowels:incorrect', 'vowels:otherCorrect', 'vowels:nobody',
      'vowels:reopen', 'vowels:next', 'vowels:skipCategory', 'round:final', 'media:play', 'media:stop',
    ]) {
      const res = adminActionSchema.safeParse({ type });
      expect(res.success, type).toBe(true);
    }
  });

  it('accepts payload-bearing actions', () => {
    const ok = [
      { type: 'game:new', packId: 'p1', teams: { pink: { name: 'Rosé' }, blue: { name: '' } }, firstTeam: 'blue' },
      { type: 'game:setTeamName', team: 'pink', name: 'Panthers' },
      { type: 'game:adjustScore', team: 'blue', delta: -1 },
      { type: 'game:removePlayer', playerId: 'abc' },
      { type: 'round:start', round: 'wall' },
      { type: 'q:select', hieroglyph: 'eyeOfHorus' },
      { type: 'q:select', hieroglyph: 'sun' },
      { type: 'wall:select', hieroglyph: 'lion' },
      { type: 'wall:select', hieroglyph: 'scarab' },
    ];
    for (const a of ok) {
      const res = parseAdminAction(a);
      expect(res.ok, a.type).toBe(true);
      if (res.ok) expect(res.action).toEqual(a);
    }
  });

  it('rejects malformed or unknown actions with a readable message', () => {
    const bad: unknown[] = [
      null,
      {},
      { type: 'nope' },
      { type: 'player:buzz', playerId: 'x' }, // player actions are not admin actions
      { type: 'wall:select', tileId: 1 }, // the tile tap is a player action (socket only)
      { type: 'wall:select', hieroglyph: 'lion', tileId: 1 },
      { type: 'wall:select', hieroglyph: 'sphinx' },
      { type: 'wall:select' },
      { type: 'wall:assign', team: 'pink', wallId: 'w1' }, // removed with walls chosen by hieroglyph
      { type: 'wall:show', wallId: 'w1' },
      { type: 'wall:show', team: 'pink' },
      { type: 'q:select', hieroglyph: 'sphinx' },
      { type: 'game:adjustScore', team: 'blue', delta: 1.5 },
      { type: 'game:adjustScore', team: 'green', delta: 1 },
      { type: 'game:setTeamName', team: 'pink', name: '   ' },
      { type: 'round:start', round: 'final' },
      { type: 'game:new', packId: 'p1', teams: { pink: { name: 'a' } }, firstTeam: 'pink' },
      { type: 'q:reveal', extra: true }, // strict objects
    ];
    for (const a of bad) {
      const res = parseAdminAction(a);
      expect(res.ok, JSON.stringify(a)).toBe(false);
      if (!res.ok) expect(describeZodError(res.error).length).toBeGreaterThan(0);
    }
  });

  it('describes the first issue with its path', () => {
    const res = adminActionSchema.safeParse({ type: 'game:adjustScore', team: 'blue', delta: 'x' });
    expect(res.success).toBe(false);
    if (!res.success) expect(describeZodError(res.error)).toMatch(/^delta: /);
  });
});

describe('socket payload schemas', () => {
  it('player:join requires a name and a team, playerId optional/null', () => {
    expect(joinPayloadSchema.safeParse({ playerId: null, name: ' Ann ', team: 'pink' }).success).toBe(true);
    expect(joinPayloadSchema.safeParse({ name: 'Ann', team: 'blue' }).success).toBe(true);
    expect(joinPayloadSchema.safeParse({ name: '', team: 'blue' }).success).toBe(false);
    expect(joinPayloadSchema.safeParse({ name: 'Ann', team: 'red' }).success).toBe(false);
    const parsed = joinPayloadSchema.parse({ playerId: null, name: ' Ann ', team: 'pink' });
    expect(parsed.name).toBe('Ann');
  });

  it('wall:select requires a tile id 0..15', () => {
    expect(wallSelectPayloadSchema.safeParse({ tileId: 0 }).success).toBe(true);
    expect(wallSelectPayloadSchema.safeParse({ tileId: 15 }).success).toBe(true);
    expect(wallSelectPayloadSchema.safeParse({ tileId: 16 }).success).toBe(false);
    expect(wallSelectPayloadSchema.safeParse({ tileId: '3' }).success).toBe(false);
  });
});
