import { describe, expect, it } from 'vitest';
import type { GameState, PublicGameState } from '../../types.js';
import { applyAction } from '../game.js';
import { projectPublic } from '../project.js';
import {
  groupTileIds,
  liveWall,
  makeCtx,
  newGame,
  packSecrets,
  run,
  selectGroup,
  withPlayers,
  NOW,
} from './fixtures.js';

const ctx = makeCtx();

function pub(state: GameState): PublicGameState {
  return projectPublic(state, NOW + 5);
}

function json(state: GameState): string {
  return JSON.stringify(pub(state));
}

function expectNoneOf(text: string, secrets: string[]): void {
  for (const s of secrets) expect(text, `leaked "${s}"`).not.toContain(JSON.stringify(s).slice(1, -1));
}

describe('projectPublic', () => {
  it('exposes only the public shape in the lobby and no pack secrets at all', () => {
    const s = withPlayers(newGame());
    const p = pub(s);
    expect(Object.keys(p).sort()).toEqual(['id', 'packName', 'phase', 'playMedia', 'players', 'question', 'serverNow', 'teams', 'version', 'vowels', 'wall'].sort());
    expect(p).toMatchObject({ id: s.id, phase: 'lobby', packName: 'Demo pack', serverNow: NOW + 5, version: s.version, question: null, wall: null, vowels: null });
    expect(p.players.map((x) => x.name)).toEqual(['Ann', 'Bob', 'Cat']);
    expect(p.teams.pink.name).toBe('Pink Panthers');
    expectNoneOf(json(s), packSecrets(s.pack));
    expect(json(s)).not.toContain('"pack"');
    expect(json(s)).not.toContain('finishedRounds');
  });

  it('hides unrevealed clues, captions of media clues, the answer and the host note', () => {
    let s = run(newGame(), [{ type: 'round:start', round: 'connections' }]);
    expect(pub(s).question).toMatchObject({ stage: 'selecting', hieroglyph: null, clues: [], answer: null, used: [] });

    // Text question: only clue 1 visible.
    s = applyAction(s, { type: 'q:select', hieroglyph: 'twoReeds' }, ctx);
    const question = s.pack.questions.find((x) => x.id === s.question?.questionId);
    if (!question) throw new Error('fixture');
    let p = pub(s).question;
    expect(p?.hieroglyph).toBe('twoReeds');
    expect(p?.clues).toEqual([
      { kind: 'text', text: 'A whip', mediaUrl: null, revealed: true },
      { kind: 'text', text: null, mediaUrl: null, revealed: false },
      { kind: 'text', text: null, mediaUrl: null, revealed: false },
      { kind: 'text', text: null, mediaUrl: null, revealed: false },
    ]);
    expect(p?.answer).toBeNull();
    let text = json(s);
    for (const c of question.clues.slice(1)) expect(text).not.toContain(c.text);
    expect(text).not.toContain(question.answer);
    expect(text).not.toContain(question.note ?? '§never§');
    expectNoneOf(text, packSecrets(s.pack));

    s = run(s, [{ type: 'q:reveal' }, { type: 'q:reveal' }]);
    p = pub(s).question;
    expect(p?.clues.map((c) => c.text)).toEqual(['A whip', 'A code', 'A joke', null]);
    expect(p?.pointsOnOffer).toBe(2);

    s = applyAction(s, { type: 'q:correct' }, ctx);
    p = pub(s).question;
    expect(p?.clues.map((c) => c.text)).toEqual(['A whip', 'A code', 'A joke', 'An egg']);
    expect(p?.answer).toBe('Things you can crack');
    expect(p?.result).toEqual({ winner: 'pink', points: 2, viaSteal: false });
    expect(json(s)).not.toContain(question.note ?? '§never§');
  });

  it('sends media urls on reveal but captions only at the answer stage', () => {
    let s = run(newGame(), [{ type: 'round:start', round: 'connections' }, { type: 'q:select', hieroglyph: 'twistedFlax' }]);
    let p = pub(s).question;
    expect(p?.clues[0]).toEqual({ kind: 'image', text: null, mediaUrl: '/api/media/demo/flag-palau.svg', revealed: true });
    expect(p?.clues[1]).toEqual({ kind: 'image', text: null, mediaUrl: null, revealed: false });
    expect(json(s)).not.toContain('flag-bangladesh');
    expect(json(s)).not.toContain('Palau');

    s = run(s, [{ type: 'q:reveal' }, { type: 'q:incorrect' }]);
    p = pub(s).question;
    expect(p?.stage).toBe('steal');
    expect(p?.clues.map((c) => c.mediaUrl)).toEqual([
      '/api/media/demo/flag-palau.svg',
      '/api/media/demo/flag-bangladesh.svg',
      '/api/media/demo/flag-laos.svg',
      '/api/media/demo/flag-japan.svg',
    ]);
    expect(p?.clues.every((c) => c.text === null)).toBe(true);
    expect(p?.answer).toBeNull();

    s = applyAction(s, { type: 'q:stealIncorrect' }, ctx);
    p = pub(s).question;
    expect(p?.clues.map((c) => c.text)).toEqual(['Flag of Palau', 'Flag of Bangladesh', 'Flag of Laos', 'Flag of Japan']);
    expect(p?.answer).toBe('Flags with a single disc on them');
  });

  it('passes playMedia through for audio clues', () => {
    const s = run(newGame(), [{ type: 'round:start', round: 'sequences' }, { type: 'q:select', hieroglyph: 'eyeOfHorus' }]);
    expect(pub(s).playMedia).toEqual({ key: 'demo/solfege-do.wav', nonce: s.version });
    expect(pub(s).question?.clues[0].mediaUrl).toBe('/api/media/demo/solfege-do.wav');
  });

  it('hides wall group membership and connections until solved / revealed', () => {
    let s = liveWall('pink');
    const wall = s.pack.walls.find((w) => w.id === s.wall?.current?.wallId);
    if (!wall) throw new Error('fixture');
    const connections = wall.groups.map((g) => g.connection);

    let w = pub(s).wall;
    expect(w?.completed).toEqual([]);
    expect(w?.current).toMatchObject({ team: 'pink', stage: 'live', startedAt: NOW, endsAt: NOW + 180_000, lives: null });
    expect(w?.current?.tiles).toHaveLength(16);
    expect(w?.current?.tiles.every((t) => t.group === null && t.colour === null)).toBe(true);
    expect(w?.current?.groups.every((g) => g.connection === null && g.solvedOrder === null)).toBe(true);
    expect(Object.keys(w?.current ?? {})).not.toContain('seed');
    expect(Object.keys(w?.current ?? {})).not.toContain('wallId');
    expectNoneOf(json(s), connections);
    expect(json(s)).not.toContain('connectionRevealed');

    // One group solved: those tiles get group + colour, the others stay hidden; connection still hidden.
    s = selectGroup(s, 1);
    w = pub(s).wall;
    const solvedIds = groupTileIds(s, 1);
    for (const t of w?.current?.tiles ?? []) {
      if (solvedIds.includes(t.id)) expect(t).toMatchObject({ group: 1, colour: 0 });
      else expect(t).toMatchObject({ group: null, colour: null });
    }
    expect(w?.current?.tiles.slice(0, 4).map((t) => t.colour)).toEqual([0, 0, 0, 0]);
    expect(w?.current?.groups[1]).toEqual({ index: 1, solvedOrder: 0, foundByTeam: true, connection: null, connectionCorrect: null });
    expectNoneOf(json(s), connections);
    expect(w?.current?.selected).toEqual([]);

    // Partial selection is public (the monitor mirrors the wall panel).
    s = run(s, [{ type: 'wall:select', tileId: groupTileIds(s, 0)[0] }]);
    expect(pub(s).wall?.current?.selected).toEqual([groupTileIds(s, 0)[0]]);

    // Resolution: everything grouped, connections revealed one at a time.
    s = run(s, [{ type: 'wall:timeUp' }, { type: 'wall:resolve' }]);
    w = pub(s).wall;
    expect(w?.current?.tiles.every((t) => t.group !== null && t.colour !== null)).toBe(true);
    expect(w?.current?.groups.every((g) => g.connection === null)).toBe(true);
    expectNoneOf(json(s), connections);
    s = applyAction(s, { type: 'wall:connectionCorrect' }, ctx);
    w = pub(s).wall;
    expect(w?.current?.groups[1].connection).toBe(wall.groups[1].connection);
    expect(w?.current?.groups[1].connectionCorrect).toBe(true);
    expectNoneOf(json(s), connections.filter((_, i) => i !== 1));
    s = run(s, [{ type: 'wall:connectionIncorrect' }, { type: 'wall:connectionCorrect' }, { type: 'wall:connectionCorrect' }, { type: 'wall:finish' }]);
    w = pub(s).wall;
    expect(w?.current?.stage).toBe('done');
    expect(w?.current?.awarded).toEqual({ groups: 1, connections: 3, bonus: 0, total: 4 });
    expect(w?.completed).toEqual(['pink']);
    for (const c of connections) expect(json(s)).toContain(c);
  });

  it('hides vowel answers until the answer stage and exposes the rest', () => {
    let s = run(withPlayers(newGame()), [{ type: 'round:start', round: 'vowels' }]);
    const group = s.pack.vowelGroups[0];
    const answers = s.pack.vowelGroups.flatMap((g) => g.clues.map((c) => c.answer));
    let v = pub(s).vowels;
    expect(v).toEqual({
      stage: 'category',
      category: group.category,
      display: null,
      answer: null,
      buzz: null,
      result: null,
      lockedPlayers: [],
      clueNumber: 1,
      clueCount: group.clues.length,
      groupNumber: 1,
      groupCount: s.pack.vowelGroups.length,
    });
    expectNoneOf(json(s), answers);

    s = applyAction(s, { type: 'vowels:showClue' }, ctx);
    v = pub(s).vowels;
    expect(v?.display).toBe(group.clues[0].display);
    expect(v?.answer).toBeNull();
    expectNoneOf(json(s), answers);

    s = run(s, [{ type: 'player:buzz', playerId: 'p-bob' }, { type: 'vowels:incorrect' }]);
    v = pub(s).vowels;
    expect(v?.stage).toBe('other');
    expect(v?.buzz).toMatchObject({ playerId: 'p-bob', playerName: 'Bob', team: 'blue' });
    expect(v?.answer).toBeNull();
    expectNoneOf(json(s), answers);

    s = applyAction(s, { type: 'vowels:otherCorrect' }, ctx);
    v = pub(s).vowels;
    expect(v?.answer).toBe(group.clues[0].answer);
    expect(v?.result).toEqual({ team: 'pink', delta: { pink: 1, blue: -1 } });
    expectNoneOf(json(s), answers.filter((a) => a !== group.clues[0].answer));
  });

  it('does not share object references with the full state', () => {
    const s = run(withPlayers(newGame()), [{ type: 'round:start', round: 'connections' }, { type: 'q:select', hieroglyph: 'lion' }]);
    const p = pub(s);
    expect(p.teams).not.toBe(s.teams);
    expect(p.players).not.toBe(s.players);
    expect(p.players[0]).not.toBe(s.players[0]);
    expect(p.question?.used).not.toBe(s.question?.used);
  });
});
