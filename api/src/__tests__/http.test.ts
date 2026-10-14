import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { HIEROGLYPHS, type GameState, type Pack, type PackSummary, type PublicGameState, type Question, type Wall } from '@only-connect/shared';
import { setConfigForTests } from '../config.js';
import { originAllowed } from '../origin.js';
import { resetRateLimitsForTests } from '../ratelimit.js';
import { createApp } from '../server.js';
import { TEST_CONFIG, createTestDeps, demoPack, type TestDeps } from './stubs.js';

let app: FastifyInstance;
let deps: TestDeps;
let token = '';
let pack: Pack;

const auth = () => ({ authorization: `Bearer ${token}` });

beforeAll(async () => {
  setConfigForTests(TEST_CONFIG);
  pack = demoPack();
  deps = createTestDeps([pack]);
  app = await createApp({ deps, logLevel: 'silent' });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  setConfigForTests(null);
});

describe('public routes', () => {
  it('GET /api/health', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('GET /api/state returns NoGameState before a game exists', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/state' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: null, phase: 'none' });
  });

  it('unknown routes are JSON 404s', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('not_found');
  });
});

describe('login', () => {
  it('rejects bad credentials with 401', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/admin/login', payload: { username: 'admin', password: 'wrong' } });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ code: 'bad_credentials' });
  });

  it('rejects a malformed body with 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/admin/login', payload: { username: 'admin' } });
    expect(res.statusCode).toBe(400);
  });

  it('issues a token for good credentials', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/admin/login', payload: { username: 'admin', password: '12346789' } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { token: string; expiresAt: string };
    expect(body.token.split('.')).toHaveLength(3);
    expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
    token = body.token;
  });

  it('throttles repeated wrong passwords (429 + Retry-After), not successful logins', async () => {
    resetRateLimitsForTests();
    const wrong = () => app.inject({ method: 'POST', url: '/api/admin/login', payload: { username: 'admin', password: 'nope' } });
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await wrong()).statusCode);
    expect(codes.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(codes.slice(5)).toEqual([429, 429]);
    const blocked = await wrong();
    expect(blocked.json()).toMatchObject({ code: 'rate_limited' });
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    // Even the right password is refused while the bucket is empty (the attacker must slow down).
    const good = await app.inject({ method: 'POST', url: '/api/admin/login', payload: { username: 'admin', password: '12346789' } });
    expect(good.statusCode).toBe(429);
    resetRateLimitsForTests();
    const again = await app.inject({ method: 'POST', url: '/api/admin/login', payload: { username: 'admin', password: '12346789' } });
    expect(again.statusCode).toBe(200);
  });
});

describe('browser origins', () => {
  it('originAllowed: same host (any port), listed extras and non-browsers only', () => {
    expect(originAllowed(undefined, 'localhost:8089')).toBe(true);
    expect(originAllowed('http://localhost:8089', 'localhost')).toBe(true);
    expect(originAllowed('http://localhost:5173', 'localhost:3000')).toBe(true);
    expect(originAllowed('https://quiz.example.com', 'quiz.example.com')).toBe(true);
    expect(originAllowed('https://evil.example', 'quiz.example.com')).toBe(false);
    expect(originAllowed('https://evil.example', 'quiz.example.com', ['https://evil.example'])).toBe(true);
    expect(originAllowed('null', 'quiz.example.com')).toBe(false);
    expect(originAllowed('garbage', 'quiz.example.com')).toBe(false);
    expect(originAllowed('http://[::1]:8089', '[::1]:8089')).toBe(true);
  });

  it('REST reflects only same-host origins', async () => {
    const same = await app.inject({ method: 'GET', url: '/api/state', headers: { origin: 'http://localhost:8089', host: 'localhost:8089' } });
    expect(same.headers['access-control-allow-origin']).toBe('http://localhost:8089');
    const foreign = await app.inject({ method: 'GET', url: '/api/state', headers: { origin: 'https://evil.example', host: 'localhost:8089' } });
    expect(foreign.headers['access-control-allow-origin']).toBeUndefined();
    expect(foreign.statusCode).toBe(200); // same data as curl would get; only the browser-side read is blocked
  });
});

describe('admin auth', () => {
  it('rejects admin routes without / with a bad token', async () => {
    for (const url of ['/api/admin/state', '/api/admin/packs']) {
      const none = await app.inject({ method: 'GET', url });
      expect(none.statusCode, url).toBe(401);
      expect(none.json().code).toBe('unauthorized');
      const bad = await app.inject({ method: 'GET', url, headers: { authorization: 'Bearer nope' } });
      expect(bad.statusCode, url).toBe(401);
    }
    const post = await app.inject({ method: 'POST', url: '/api/admin/actions', payload: { type: 'q:reveal' } });
    expect(post.statusCode).toBe(401);
  });

  it('GET /api/admin/state is null before a game exists', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/state', headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toBeNull();
  });
});

describe('packs', () => {
  it('lists packs with playable/problems', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/admin/packs', headers: auth() });
    expect(res.statusCode).toBe(200);
    const list = res.json() as PackSummary[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: pack.id, name: pack.name, playable: true, problems: [] });
  });

  it('create -> get -> put (full replace) -> duplicate -> delete', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/admin/packs', headers: auth(), payload: { name: 'Draft' } });
    expect(created.statusCode).toBe(201);
    const draft = created.json() as Pack;
    expect(draft).toMatchObject({ name: 'Draft', questions: [], walls: [], vowelGroups: [] });

    const list = (await app.inject({ method: 'GET', url: '/api/admin/packs', headers: auth() })).json() as PackSummary[];
    expect(list.find((p) => p.id === draft.id)?.playable).toBe(false);

    const got = await app.inject({ method: 'GET', url: `/api/admin/packs/${draft.id}`, headers: auth() });
    expect(got.statusCode).toBe(200);

    const full: Pack = { ...pack, id: draft.id, name: 'Draft v2' };
    const put = await app.inject({ method: 'PUT', url: `/api/admin/packs/${draft.id}`, headers: auth(), payload: full });
    expect(put.statusCode).toBe(200);
    const saved = put.json() as Pack;
    expect(saved.name).toBe('Draft v2');
    expect(saved.questions).toHaveLength(12);
    // The payload was copied from the demo pack: its question/wall/vowel-group ids belong to that pack's rows
    // (uuid primary keys), so the saved pack gets fresh ids instead of a unique-violation 500.
    const demoIds = new Set([...pack.questions.map((q) => q.id), ...pack.walls.map((w) => w.id), ...pack.vowelGroups.map((g) => g.id)]);
    expect(saved.questions.some((q) => demoIds.has(q.id))).toBe(false);
    expect(saved.walls.some((w) => demoIds.has(w.id))).toBe(false);
    expect(saved.vowelGroups.some((g) => demoIds.has(g.id))).toBe(false);
    expect(saved.questions.map((q) => q.answer)).toEqual(pack.questions.map((q) => q.answer));
    expect(saved.createdAt).toBe(draft.createdAt);
    // Saving the pack again keeps its own (now free) ids, so the editor's references stay stable.
    const again = await app.inject({ method: 'PUT', url: `/api/admin/packs/${draft.id}`, headers: auth(), payload: saved });
    expect(again.statusCode).toBe(200);
    expect((again.json() as Pack).questions.map((q) => q.id)).toEqual(saved.questions.map((q) => q.id));
    // The demo pack itself is untouched.
    const demoAfter = (await app.inject({ method: 'GET', url: `/api/admin/packs/${pack.id}`, headers: auth() })).json() as Pack;
    expect(demoAfter.questions.map((q) => q.id)).toEqual(pack.questions.map((q) => q.id));

    const badPut = await app.inject({ method: 'PUT', url: `/api/admin/packs/${draft.id}`, headers: auth(), payload: { name: '' } });
    expect(badPut.statusCode).toBe(400);

    const dup = await app.inject({ method: 'POST', url: `/api/admin/packs/${draft.id}/duplicate`, headers: auth() });
    expect(dup.statusCode).toBe(201);
    const copy = dup.json() as Pack;
    expect(copy.name).toBe('Draft v2 (copy)');
    expect(copy.id).not.toBe(draft.id);
    expect(copy.questions.map((q) => q.id)).not.toEqual(saved.questions.map((q) => q.id));
    expect(copy.questions.map((q) => q.answer)).toEqual(saved.questions.map((q) => q.answer));

    for (const id of [draft.id, copy.id]) {
      const del = await app.inject({ method: 'DELETE', url: `/api/admin/packs/${id}`, headers: auth() });
      expect(del.statusCode).toBe(204);
    }
    const missing = await app.inject({ method: 'GET', url: `/api/admin/packs/${draft.id}`, headers: auth() });
    expect(missing.statusCode).toBe(404);
    const delAgain = await app.inject({ method: 'DELETE', url: `/api/admin/packs/${draft.id}`, headers: auth() });
    expect(delAgain.statusCode).toBe(404);
  });

  it('PUT accepts 12 questions per round (all twelve hieroglyphs) and 4 walls with distinct glyphs; the pack is playable', async () => {
    const created = (await app.inject({ method: 'POST', url: '/api/admin/packs', headers: auth(), payload: { name: 'Big' } })).json() as Pack;
    const mkQ = (round: Question['round'], h: Question['hieroglyph'], position: number): Question => {
      const base = pack.questions.find((q) => q.round === round) as Question;
      return { ...base, id: '', hieroglyph: h, position: 99 - position, answer: `${h} answer` };
    };
    const mkW = (h: Wall['hieroglyph'], position: number): Wall => ({ ...pack.walls[0], id: '', position, hieroglyph: h });
    const big = {
      ...pack,
      name: 'Big',
      questions: (['connections', 'sequences'] as const).flatMap((round) => HIEROGLYPHS.map((h, i) => mkQ(round, h, i))),
      walls: (['sun', 'lion', 'cobra', 'water'] as const).map(mkW),
    };
    const put = await app.inject({ method: 'PUT', url: `/api/admin/packs/${created.id}`, headers: auth(), payload: big });
    expect(put.statusCode).toBe(200);
    const saved = put.json() as Pack;
    expect(saved.questions).toHaveLength(24);
    // Positions are renumbered 0..11 per round in the order of the positions sent (here: reversed).
    expect(saved.questions.filter((q) => q.round === 'connections').map((q) => q.position)).toEqual(Array.from({ length: 12 }, (_, i) => i));
    expect(saved.questions.filter((q) => q.round === 'sequences').map((q) => q.hieroglyph)).toEqual([...HIEROGLYPHS].reverse());
    expect(saved.walls.map((w) => w.hieroglyph)).toEqual(['sun', 'lion', 'cobra', 'water']);
    expect(saved.walls.map((w) => w.position)).toEqual([0, 1, 2, 3]);
    const list = (await app.inject({ method: 'GET', url: '/api/admin/packs', headers: auth() })).json() as PackSummary[];
    expect(list.find((p) => p.id === created.id)).toMatchObject({ playable: true, problems: [] });

    // Hard upper bounds: a 13th question in a round or a 5th wall is a 400, a wall without a glyph gets one.
    const thirteen = await app.inject({ method: 'PUT', url: `/api/admin/packs/${created.id}`, headers: auth(), payload: { ...big, questions: [...big.questions, mkQ('connections', 'owl', 12)] } });
    expect(thirteen.statusCode).toBe(400);
    expect(thirteen.json().error).toMatch(/at most 12 connections questions/);
    const five = await app.inject({ method: 'PUT', url: `/api/admin/packs/${created.id}`, headers: auth(), payload: { ...big, walls: [...big.walls, mkW('owl', 4)] } });
    expect(five.statusCode).toBe(400);
    const bare = await app.inject({ method: 'PUT', url: `/api/admin/packs/${created.id}`, headers: auth(), payload: { ...big, walls: big.walls.map((w) => ({ id: w.id, position: w.position, groups: w.groups })) } });
    expect(bare.statusCode).toBe(200);
    expect((bare.json() as Pack).walls.map((w) => w.hieroglyph)).toEqual(['lion', 'water', 'twoReeds', 'twistedFlax']);
    expect((await app.inject({ method: 'DELETE', url: `/api/admin/packs/${created.id}`, headers: auth() })).statusCode).toBe(204);
  });

  it('export returns the pack JSON as a download; import creates a new pack from it', async () => {
    const exp = await app.inject({ method: 'GET', url: `/api/admin/packs/${pack.id}/export`, headers: auth() });
    expect(exp.statusCode).toBe(200);
    expect(exp.headers['content-disposition']).toMatch(/attachment; filename=".*\.only-connect\.json"/);
    const exported = exp.json() as Pack;
    expect(exported.id).toBe(pack.id);
    expect(exported.questions).toHaveLength(12);

    const imp = await app.inject({ method: 'POST', url: '/api/admin/packs/import', headers: auth(), payload: exported });
    expect(imp.statusCode).toBe(201);
    const imported = imp.json() as Pack;
    expect(imported.id).not.toBe(pack.id);
    expect(imported.name).toBe(pack.name);
    expect(imported.questions.map((q) => q.answer)).toEqual(pack.questions.map((q) => q.answer));
    expect(imported.questions.some((q) => pack.questions.some((o) => o.id === q.id))).toBe(false);
    const list = (await app.inject({ method: 'GET', url: '/api/admin/packs', headers: auth() })).json() as PackSummary[];
    expect(list.find((p) => p.id === imported.id)?.playable).toBe(true);
    expect((await app.inject({ method: 'DELETE', url: `/api/admin/packs/${imported.id}`, headers: auth() })).statusCode).toBe(204);

    const bad = await app.inject({ method: 'POST', url: '/api/admin/packs/import', headers: auth(), payload: { questions: 'nope' } });
    expect(bad.statusCode).toBe(400);
  });
});

describe('game actions', () => {
  it('rejects malformed action payloads with 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/admin/actions', headers: auth(), payload: { type: 'q:select', hieroglyph: 'sphinx' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: 'invalid_action_payload' });
  });

  it('game:new -> round:start -> q:select -> q:reveal; public state hides the answer until revealed', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/actions',
      headers: auth(),
      payload: { type: 'game:new', packId: pack.id, teams: { pink: { name: 'Rosé' }, blue: { name: 'Azul' } }, firstTeam: 'pink' },
    });
    expect(res.statusCode).toBe(200);
    const state = res.json() as GameState;
    expect(state).toMatchObject({ phase: 'lobby', version: 0, packId: pack.id });
    expect(state.teams.pink.name).toBe('Rosé');

    const adminState = await app.inject({ method: 'GET', url: '/api/admin/state', headers: auth() });
    expect((adminState.json() as GameState).id).toBe(state.id);

    const send = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/admin/actions', headers: auth(), payload });
    expect((await send({ type: 'round:start', round: 'connections' })).statusCode).toBe(200);
    const selected = await send({ type: 'q:select', hieroglyph: 'twoReeds' });
    expect(selected.statusCode).toBe(200);
    const question = pack.questions.find((q) => q.round === 'connections' && q.hieroglyph === 'twoReeds');
    if (!question) throw new Error('fixture');

    let pub = (await app.inject({ method: 'GET', url: '/api/state' })).json() as PublicGameState;
    expect(pub.phase).toBe('connections');
    expect(pub.question?.clues.map((c) => c.revealed)).toEqual([true, false, false, false]);
    const text = JSON.stringify(pub);
    expect(text).not.toContain(question.answer);
    expect(text).not.toContain(question.clues[1].text);
    expect(text).not.toContain('"pack"');

    expect((await send({ type: 'q:reveal' })).statusCode).toBe(200);
    expect((await send({ type: 'q:correct' })).statusCode).toBe(200);
    pub = (await app.inject({ method: 'GET', url: '/api/state' })).json() as PublicGameState;
    expect(pub.question?.answer).toBe(question.answer);
    expect(pub.teams.pink.score).toBe(3);

    const invalid = await send({ type: 'q:reveal' });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: 'invalid_action' });
    expect(typeof invalid.json().error).toBe('string');

    const unknownPack = await send({ type: 'game:new', packId: '00000000-0000-0000-0000-000000000000', teams: { pink: { name: '' }, blue: { name: '' } }, firstTeam: 'pink' });
    expect(unknownPack.statusCode).toBe(400);
    expect(unknownPack.json()).toMatchObject({ code: 'unknown_pack' });
  });

  it('game:undo reverts the last admin action and reports what can be undone', async () => {
    const send = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/admin/actions', headers: auth(), payload });
    const before = (await send({ type: 'q:next' })).json() as GameState; // answer stage from the previous test -> selecting
    expect(before.question?.stage).toBe('selecting');
    expect(before.undoable).toBe('q:next');
    const undone = await send({ type: 'game:undo' });
    expect(undone.statusCode).toBe(200);
    const state = undone.json() as GameState;
    expect(state.question?.stage).toBe('answer');
    expect(state.version).toBe(before.version + 1);
    expect(state.undoable).toBe('q:correct');
    const pub = (await app.inject({ method: 'GET', url: '/api/state' })).json() as PublicGameState;
    expect(pub.version).toBe(state.version);
    expect(pub.question?.stage).toBe('answer');
  });
});

describe('wall round (walls chosen by hieroglyph)', () => {
  const send = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/admin/actions', headers: auth(), payload });

  it('wall:select {hieroglyph} puts the chosen wall on screen; wall:assign / wall:show are gone', async () => {
    expect((await send({ type: 'wall:assign', team: 'pink', wallId: pack.walls[0].id })).statusCode).toBe(400);
    expect((await send({ type: 'wall:show', wallId: pack.walls[0].id })).statusCode).toBe(400);
    const started = await send({ type: 'round:start', round: 'wall' });
    expect(started.statusCode).toBe(200);
    // Pink is ahead (3 points from the connections question), so blue chooses first.
    expect((started.json() as GameState).wall).toMatchObject({ stage: 'selecting', team: 'blue', available: ['lion', 'water'], used: [], current: null, wallsDone: 0, wallsTotal: 2 });
    const pub = (await app.inject({ method: 'GET', url: '/api/state' })).json() as PublicGameState;
    expect(pub.wall).toMatchObject({ stage: 'selecting', team: 'blue', available: ['lion', 'water'], used: [], current: null, wallsTotal: 2 });

    expect((await send({ type: 'wall:select', hieroglyph: 'ankh' })).json()).toMatchObject({ code: 'invalid_action' }); // not a wall of this pack
    expect((await send({ type: 'wall:select', tileId: 0 })).statusCode).toBe(400); // the tile tap is not an admin action
    const chosen = await send({ type: 'wall:select', hieroglyph: 'water' });
    expect(chosen.statusCode).toBe(200);
    const state = chosen.json() as GameState;
    expect(state.wall).toMatchObject({ stage: 'playing', team: 'blue', used: ['water'] });
    expect(state.wall?.current).toMatchObject({ wallId: pack.walls[1].id, team: 'blue', stage: 'ready' });
    expect(state.undoable).toBe('wall:select');
    expect((await send({ type: 'wall:select', hieroglyph: 'lion' })).statusCode).toBe(400); // one wall at a time
  });

  it('plays both walls to the end: teams alternate, points accumulate, the round finishes', async () => {
    const playOut = async () => {
      expect((await send({ type: 'wall:start' })).statusCode).toBe(200);
      expect((await send({ type: 'wall:timeUp' })).statusCode).toBe(200);
      expect((await send({ type: 'wall:resolve' })).statusCode).toBe(200);
      for (let i = 0; i < 4; i++) expect((await send({ type: 'wall:connectionCorrect' })).statusCode).toBe(200);
      const finished = (await send({ type: 'wall:finish' })).json() as GameState;
      expect(finished.wall?.current).toMatchObject({ stage: 'done', awarded: { connections: 4 } });
      return (await send({ type: 'wall:clear' })).json() as GameState;
    };
    const afterFirst = await playOut();
    expect(afterFirst.wall).toMatchObject({ stage: 'selecting', team: 'pink', used: ['water'], current: null, wallsDone: 1, wallsTotal: 2 });
    expect(afterFirst.teams.blue.score).toBe(4);
    expect(afterFirst.finishedRounds ?? []).not.toContain('wall');
    expect((await send({ type: 'wall:select', hieroglyph: 'water' })).statusCode).toBe(400); // already used
    expect((await send({ type: 'wall:select', hieroglyph: 'lion' })).statusCode).toBe(200);
    const afterSecond = await playOut();
    expect(afterSecond.wall).toMatchObject({ stage: 'selecting', used: ['water', 'lion'], current: null, wallsDone: 2, wallsTotal: 2 });
    expect(afterSecond.teams.pink.score).toBe(3 + 4);
    expect(afterSecond.finishedRounds).toContain('wall');
    expect((await send({ type: 'wall:select', hieroglyph: 'lion' })).statusCode).toBe(400);
  });
});

describe('media', () => {
  const boundary = '----oc-test-boundary';
  const multipart = (fieldName: string, filename: string, mime: string, body: Buffer) =>
    Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`),
      body,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

  it('uploads images/audio to uploads/<uuid>.<ext>, records them and streams them back', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/media',
      headers: { ...auth(), 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipart('file', 'photo.PNG', 'image/png', png),
    });
    expect(res.statusCode).toBe(201);
    const ref = res.json() as { key: string; url: string; mime: string; name: string };
    expect(ref.key).toMatch(/^uploads\/[0-9a-f-]{36}\.png$/);
    expect(ref).toMatchObject({ url: `/api/media/${ref.key}`, mime: 'image/png', name: 'photo.PNG' });
    expect(deps.media.records).toEqual([expect.objectContaining({ key: ref.key, mime: 'image/png', size: png.length })]);

    const get = await app.inject({ method: 'GET', url: ref.url });
    expect(get.statusCode).toBe(200);
    expect(get.headers['content-type']).toBe('image/png');
    expect(get.headers['cache-control']).toBe('public, max-age=86400');
    expect(get.headers['accept-ranges']).toBe('bytes');
    expect(get.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(get.headers['x-content-type-options']).toBe('nosniff');
    expect(get.rawPayload.equals(png)).toBe(true);

    const head = await app.inject({ method: 'HEAD', url: ref.url });
    expect(head.statusCode).toBe(200);
    expect(head.headers['content-length']).toBe(String(png.length));
    expect(head.body).toBe('');

    const range = await app.inject({ method: 'GET', url: ref.url, headers: { range: 'bytes=0-3' } });
    expect(range.statusCode).toBe(206);
    expect(range.headers['content-range']).toBe(`bytes 0-3/${png.length}`);
    expect(range.rawPayload.equals(png.subarray(0, 4))).toBe(true);

    const badRange = await app.inject({ method: 'GET', url: ref.url, headers: { range: 'bytes=999-' } });
    expect(badRange.statusCode).toBe(416);
  });

  it('rejects non image/audio uploads (and SVG), and requires auth', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/admin/media',
      headers: { ...auth(), 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipart('file', 'notes.txt', 'text/plain', Buffer.from('hello')),
    });
    expect(res.statusCode).toBe(415);
    const svg = await app.inject({
      method: 'POST',
      url: '/api/admin/media',
      headers: { ...auth(), 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipart('file', 'evil.svg', 'image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>')),
    });
    expect(svg.statusCode).toBe(415);
    expect(deps.objects.objects.size).toBe(1);

    const noAuth = await app.inject({
      method: 'POST',
      url: '/api/admin/media',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload: multipart('file', 'a.png', 'image/png', Buffer.from('x')),
    });
    expect(noAuth.statusCode).toBe(401);
  });

  it('GET /api/media/* is a JSON 404 for missing or malformed keys', async () => {
    for (const url of ['/api/media/uploads/missing.png', '/api/media/..%2Fetc%2Fpasswd', '/api/media/demo//x.svg']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(404);
      expect(res.json().code, url).toBe('not_found');
    }
  });

  it('deleting a pack removes the uploads only it referenced; the sweep removes old orphans', async () => {
    const upload = async (name: string) =>
      (
        await app.inject({
          method: 'POST',
          url: '/api/admin/media',
          headers: { ...auth(), 'content-type': `multipart/form-data; boundary=${boundary}` },
          payload: multipart('file', name, 'image/png', Buffer.from('89504e47', 'hex')),
        })
      ).json() as { key: string; url: string; mime: string; name: string };
    const onlyMine = await upload('a.png');
    const shared = await upload('b.png');
    const loose = await upload('c.png');
    const withMedia = (ref: { key: string; url: string; mime: string; name: string }, name: string): Pack => {
      const p: Pack = { ...structuredClone(pack), id: '', name };
      p.questions[0].clues[0] = { kind: 'image', text: 'pic', media: ref };
      p.questions[0].clues[1] = { kind: 'image', text: 'pic', media: shared };
      return p;
    };
    const mk = async (p: Pack) => (await app.inject({ method: 'POST', url: '/api/admin/packs/import', headers: auth(), payload: p })).json() as Pack;
    const a = await mk(withMedia(onlyMine, 'A'));
    const b = await mk(withMedia(shared, 'B'));
    expect((await app.inject({ method: 'DELETE', url: `/api/admin/packs/${a.id}`, headers: auth() })).statusCode).toBe(204);
    expect(deps.objects.objects.has(onlyMine.key)).toBe(false);
    expect(deps.objects.objects.has(shared.key)).toBe(true); // still used by B
    expect(deps.media.records.some((r) => r.key === onlyMine.key)).toBe(false);
    // The sweep only touches uploads older than an hour.
    const fresh = await app.inject({ method: 'POST', url: '/api/admin/media/sweep', headers: auth() });
    expect(fresh.json()).toEqual({ removed: 0, keys: [] });
    for (const r of deps.media.records) if (r.key === loose.key) r.createdAt = new Date(Date.now() - 2 * 3600_000).toISOString();
    const orphans = (await app.inject({ method: 'GET', url: '/api/admin/media/orphans', headers: auth() })).json() as { keys: string[] };
    expect(orphans.keys).toEqual([loose.key]);
    const swept = await app.inject({ method: 'POST', url: '/api/admin/media/sweep', headers: auth() });
    expect(swept.json()).toEqual({ removed: 1, keys: [loose.key] });
    expect(deps.objects.objects.has(loose.key)).toBe(false);
    expect(deps.objects.objects.has(shared.key)).toBe(true);
    expect((await app.inject({ method: 'DELETE', url: `/api/admin/packs/${b.id}`, headers: auth() })).statusCode).toBe(204);
    expect(deps.objects.objects.has(shared.key)).toBe(false);
  });
});
