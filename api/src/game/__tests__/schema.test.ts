import { describe, expect, it } from 'vitest';
import { adminActionSchema, describeZodError, joinPayloadSchema, parseAdminAction, wallSelectPayloadSchema } from '../schema.js';

describe('adminActionSchema', () => {
  it('accepts every payload-free action type', () => {
    for (const type of [
      'game:lobby', 'q:reveal', 'q:correct', 'q:incorrect', 'q:stealCorrect', 'q:stealIncorrect', 'q:void', 'q:timeUp', 'q:next',
      'wall:start', 'wall:timeUp', 'wall:resolve', 'wall:connectionCorrect', 'wall:connectionIncorrect', 'wall:finish',
      'wall:clear', 'vowels:showClue', 'vowels:correct', 'vowels:incorrect', 'vowels:otherCorrect', 'vowels:nobody',
      'vowels:reopen', 'vowels:next', 'vowels:skipCategory', 'round:final', 'media:play', 'media:stop', 'cue:stop',
    ]) {
      const res = adminActionSchema.safeParse({ type });
      expect(res.success, type).toBe(true);
    }
  });

  it('accepts payload-bearing actions', () => {
    const ok = [
      { type: 'game:new', packId: 'p1', teams: [{ id: 'pink', name: 'Rosé' }, { id: 'blue', name: '' }] },
      { type: 'game:new', packId: 'p1', teams: [{ id: 'orange', name: 'Tangerines' }, { id: 'green', name: '' }, { id: 'pink', name: 'P' }, { id: 'blue', name: 'B' }] },
      { type: 'game:new', packId: 'p1', teams: [{ id: 'green', name: 'G' }, { id: 'blue', name: 'B' }, { id: 'pink', name: 'P' }] },
      { type: 'game:setTeamName', team: 'pink', name: 'Panthers' },
      { type: 'game:setTeamName', team: 'orange', name: 'Tangerines' },
      { type: 'game:adjustScore', team: 'blue', delta: -1 },
      { type: 'game:adjustScore', team: 'green', delta: 1 },
      { type: 'game:removePlayer', playerId: 'abc' },
      { type: 'round:start', round: 'wall' },
      { type: 'round:start', round: 'sequences', order: ['blue', 'pink'] },
      { type: 'round:start', round: 'vowels', order: ['green', 'orange', 'pink', 'blue'] },
      { type: 'q:stealCorrect', team: 'green' },
      { type: 'q:stealCorrect' },
      { type: 'vowels:otherCorrect', team: 'orange' },
      { type: 'vowels:otherCorrect' },
      { type: 'q:select', hieroglyph: 'eyeOfHorus' },
      { type: 'q:select', hieroglyph: 'sun' },
      { type: 'wall:select', hieroglyph: 'lion' },
      { type: 'wall:select', hieroglyph: 'scarab' },
      { type: 'cue:play', cue: 'openingTitles' },
      { type: 'cue:play', cue: 'introClip' },
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
      { type: 'game:adjustScore', team: 'red', delta: 1 },
      { type: 'game:setTeamName', team: 'pink', name: '   ' },
      { type: 'round:start', round: 'final' },
      { type: 'game:new', packId: 'p1', teams: [{ id: 'pink', name: 'a' }] }, // one team
      { type: 'game:new', packId: 'p1', teams: [{ id: 'pink', name: 'a' }, { id: 'blue', name: 'b' }, { id: 'green', name: 'c' }, { id: 'orange', name: 'd' }, { id: 'pink', name: 'e' }] }, // five
      { type: 'game:new', packId: 'p1', teams: [{ id: 'pink', name: 'a' }, { id: 'pink', name: 'b' }] }, // duplicate ids
      { type: 'game:new', packId: 'p1', teams: [{ id: 'pink', name: 'a' }, { id: 'red', name: 'b' }] }, // unknown id
      { type: 'game:new', packId: 'p1', teams: [{ id: 'pink', name: 'a' }, { id: 'blue' }] }, // a name is required (may be empty)
      { type: 'game:new', packId: 'p1', teams: [{ id: 'pink', name: 'a' }, { id: 'blue', name: 'b', score: 3 }] },
      { type: 'game:new', packId: 'p1', teams: [{ id: 'pink', name: 'a' }, { id: 'blue', name: 'b' }], firstTeam: 'pink' }, // V3 payload
      { type: 'game:new', packId: 'p1', teams: { pink: { name: 'a' }, blue: { name: 'b' } } }, // V3 record
      { type: 'round:start', round: 'wall', order: ['pink'] }, // an order has 2..4 teams
      { type: 'round:start', round: 'wall', order: ['pink', 'pink'] }, // ... all distinct
      { type: 'round:start', round: 'wall', order: ['pink', 'red'] }, // ... and known
      { type: 'round:start', round: 'wall', order: 'pink' },
      { type: 'round:start', round: 'wall', order: ['pink', 'blue', 'green', 'orange', 'pink'] },
      { type: 'q:stealCorrect', team: 'red' },
      { type: 'q:stealCorrect', team: null },
      { type: 'q:stealCorrect', points: 1 },
      { type: 'vowels:otherCorrect', team: 'red' },
      { type: 'vowels:otherCorrect', team: 'pink', extra: 1 },
      { type: 'q:reveal', extra: true }, // strict objects
      { type: 'cue:play' }, // a cue is required
      { type: 'cue:play', cue: 'credits' },
      { type: 'cue:play', cue: 'openingTitles', loop: true },
      { type: 'cue:stop', cue: 'openingTitles' },
      { type: 'q:timeUp', now: 1 },
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
    const dup = adminActionSchema.safeParse({ type: 'game:new', packId: 'p1', teams: [{ id: 'pink', name: 'a' }, { id: 'pink', name: 'b' }] });
    expect(dup.success).toBe(false);
    if (!dup.success) expect(describeZodError(dup.error)).toBe('teams: each team can play only once');
    const missing = adminActionSchema.safeParse({ type: 'game:new', packId: 'p1', teams: [{ id: 'pink', name: 'a' }, { id: 'blue' }] });
    expect(missing.success).toBe(false);
    if (!missing.success) expect(describeZodError(missing.error)).toMatch(/^teams\.1\.name: /);
    const order = adminActionSchema.safeParse({ type: 'round:start', round: 'wall', order: ['pink', 'blue', 'pink'] });
    expect(order.success).toBe(false);
    if (!order.success) expect(describeZodError(order.error)).toBe('order: a team cannot appear twice in the order');
  });

  it('game:new keeps the team order as sent and the optional steal / other team as given (V3.2)', () => {
    const res = parseAdminAction({ type: 'game:new', packId: 'p1', teams: [{ id: 'green', name: '' }, { id: 'pink', name: 'P' }] });
    expect(res.ok).toBe(true);
    if (res.ok && res.action.type === 'game:new') expect(res.action.teams.map((t) => t.id)).toEqual(['green', 'pink']);
    const steal = parseAdminAction({ type: 'q:stealCorrect' });
    if (steal.ok && steal.action.type === 'q:stealCorrect') expect('team' in steal.action).toBe(false);
    const named = parseAdminAction({ type: 'vowels:otherCorrect', team: 'orange' });
    if (named.ok && named.action.type === 'vowels:otherCorrect') expect(named.action.team).toBe('orange');
    else throw new Error('vowels:otherCorrect {team} must parse');
  });
});

describe('socket payload schemas', () => {
  it('player:join requires a name and a team, playerId optional/null', () => {
    expect(joinPayloadSchema.safeParse({ playerId: null, name: ' Ann ', team: 'pink' }).success).toBe(true);
    expect(joinPayloadSchema.safeParse({ name: 'Ann', team: 'blue' }).success).toBe(true);
    expect(joinPayloadSchema.safeParse({ name: 'Ann', team: 'green' }).success).toBe(true); // active or not is the engine's call
    expect(joinPayloadSchema.safeParse({ name: 'Ann', team: 'orange' }).success).toBe(true);
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
