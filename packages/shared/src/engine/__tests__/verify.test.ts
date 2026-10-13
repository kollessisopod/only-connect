/**
 * Adversarial verification of the engine against SPEC §3 / §10 and the types contract.
 *
 * A full, deliberately varied game is driven through `applyAction` with every input (state, action, ctx and
 * the pack) deep-frozen, so any mutation throws. Every intermediate state is recorded and then checked for
 * structural invariants, score bookkeeping, projection leaks and the `allowedActions` <-> `applyAction`
 * equivalence (with real payloads for the payload-bearing actions).
 */
import { describe, expect, it } from 'vitest';
import {
  CLUE_POINTS,
  GameError,
  HIEROGLYPHS,
  QUESTIONS_PER_ROUND,
  STEAL_POINTS,
  TEAM_IDS,
  WALL_LIVES,
  WALL_SECONDS,
  otherTeam,
  type ActionContext,
  type AdminAction,
  type GameAction,
  type GameState,
  type Hieroglyph,
  type RoundName,
  type TeamId,
  type WallPlay,
} from '../../types.js';
import { allowedActions, applyAction, canStartRound, createGame } from '../game.js';
import { projectPublic } from '../project.js';
import { findQuestion, isClueVisible, maxCluesFor, roundOpener } from '../questions.js';
import { computeAwarded } from '../wall.js';
import { currentVowelClue } from '../vowels.js';
import { demoPack, groupTileIds, TEAM_NAMES, NOW } from './fixtures.js';

const ALL_ADMIN_TYPES: AdminAction['type'][] = [
  'game:new', 'game:setTeamName', 'game:adjustScore', 'game:removePlayer', 'game:lobby', 'game:undo', 'round:start',
  'q:select', 'q:reveal', 'q:correct', 'q:incorrect', 'q:stealCorrect', 'q:stealIncorrect', 'q:void', 'q:next',
  'wall:assign', 'wall:show', 'wall:start', 'wall:timeUp', 'wall:abort', 'wall:resolve', 'wall:connectionCorrect',
  'wall:connectionIncorrect', 'wall:finish', 'wall:clear', 'vowels:showClue', 'vowels:correct', 'vowels:incorrect',
  'vowels:otherCorrect', 'vowels:nobody', 'vowels:reopen', 'vowels:next', 'vowels:skipCategory', 'round:final',
  'media:play', 'media:stop',
];
const ROUNDS: RoundName[] = ['connections', 'sequences', 'wall', 'vowels'];

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as object)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

function makeFrozenCtx(now: number): ActionContext {
  let n = 0;
  return deepFreeze({ now, seed: 4242, newId: () => `vid-${++n}` });
}

/** Expected change of each team's score caused by `action` applied to `prev` (SPEC §3). */
function expectedScoreDelta(prev: GameState, action: GameAction): Record<TeamId, number> {
  const d: Record<TeamId, number> = { pink: 0, blue: 0 };
  const qs = prev.question;
  const vs = prev.vowels;
  switch (action.type) {
    case 'game:adjustScore':
      d[action.team] += action.delta;
      break;
    case 'q:correct':
      if (qs) d[qs.team] += qs.pointsOnOffer;
      break;
    case 'q:stealCorrect':
      if (qs) d[otherTeam(qs.team)] += STEAL_POINTS;
      break;
    case 'vowels:correct':
      if (vs?.buzz) d[vs.buzz.team] += 1;
      break;
    case 'vowels:incorrect':
      if (vs?.buzz) d[vs.buzz.team] -= 1;
      break;
    case 'vowels:otherCorrect':
      if (vs?.buzz) d[otherTeam(vs.buzz.team)] += 1;
      break;
    case 'wall:finish': {
      const play = prev.wall?.current;
      if (play) d[play.team] += computeAwarded(play).total;
      break;
    }
    default:
      break;
  }
  return d;
}

class Trace {
  readonly states: GameState[] = [];
  readonly actions: GameAction[] = [];
  state: GameState;
  clock = NOW;

  constructor(state: GameState) {
    this.state = deepFreeze(state);
    this.states.push(state);
  }

  apply(action: GameAction, advanceMs = 1000): GameState {
    this.clock += advanceMs;
    const ctx = makeFrozenCtx(this.clock);
    deepFreeze(action);
    const prev = this.state;
    const snapshot = JSON.stringify(prev);
    const next = applyAction(prev, action, ctx);
    expect(JSON.stringify(prev), `${action.type} mutated its input state`).toBe(snapshot);
    expect(next, `${action.type} returned the same object`).not.toBe(prev);
    expect(next.version, `${action.type} must bump version by exactly 1`).toBe(prev.version + 1);
    expect(next.updatedAt, `${action.type} must stamp updatedAt = ctx.now`).toBe(ctx.now);
    expect(next.pack).toBe(prev.pack); // the pack is never copied or changed
    expect(next.createdAt).toBe(prev.createdAt);
    expect(next.id).toBe(prev.id);
    const want = expectedScoreDelta(prev, action);
    for (const t of TEAM_IDS) {
      expect(next.teams[t].score, `${action.type}: ${t} score delta`).toBe(prev.teams[t].score + want[t]);
    }
    this.state = deepFreeze(next);
    this.states.push(next);
    this.actions.push(action);
    return next;
  }

  run(actions: GameAction[]): GameState {
    for (const a of actions) this.apply(a);
    return this.state;
  }

  /** Four tiles from four different (unsolved) groups: a guaranteed wrong guess. */
  wrongGuess(): number[] {
    const play = this.state.wall?.current;
    if (!play) throw new Error('no wall');
    const unsolved = play.groups.filter((g) => g.solvedOrder === null).map((g) => g.index);
    const ids: number[] = [];
    // Pick 2 tiles from the first unsolved group and 2 from the second so it is always wrong.
    for (const gi of unsolved.slice(0, 2)) ids.push(...groupTileIds(this.state, gi).slice(0, 2));
    return ids;
  }

  selectTiles(ids: number[]): GameState {
    for (const tileId of ids) this.apply({ type: 'wall:select', tileId });
    return this.state;
  }

  selectGroup(groupIndex: number): GameState {
    return this.selectTiles(groupTileIds(this.state, groupIndex));
  }
}

/**
 * Plays a full game with a varied mix of outcomes:
 *  - Connections (pink first): correct@1, 3 reveals + correct, incorrect -> steal correct, incorrect -> steal
 *    incorrect, 2 reveals + correct, reveal + incorrect + steal incorrect.
 *  - Sequences (blue first): similar, including max 3 reveals.
 *  - Wall: pink loses all lives after 2 groups (mixed verdicts), blue completes the wall (perfect 10).
 *  - Vowels: every clue of every category with correct / incorrect+other / incorrect+nobody / nobody / reopen.
 *  - Final, then back to lobby.
 */
function playFullGame(): Trace {
  const pack = deepFreeze(demoPack());
  const t = new Trace(createGame(pack, deepFreeze({ ...TEAM_NAMES }), 'pink', makeFrozenCtx(NOW)));
  t.run([
    { type: 'player:join', playerId: 'p-ann', name: 'Ann', team: 'pink' },
    { type: 'player:join', playerId: 'p-bob', name: 'Bob', team: 'blue' },
    { type: 'player:join', playerId: 'p-cat', name: 'Cat', team: 'pink' },
    { type: 'player:join', playerId: 'p-dan', name: 'Dan', team: 'blue' },
    { type: 'player:connected', playerId: 'p-dan', connected: false },
    { type: 'game:setTeamName', team: 'blue', name: 'Blue Whales' },
  ]);

  const H = HIEROGLYPHS;
  const questionScripts: GameAction[][] = [
    [{ type: 'q:select', hieroglyph: H[0] }, { type: 'q:correct' }, { type: 'q:next' }],
    [{ type: 'q:select', hieroglyph: H[3] }, { type: 'q:reveal' }, { type: 'media:play' }, { type: 'q:reveal' }, { type: 'q:reveal' }, { type: 'q:correct' }, { type: 'q:next' }],
    [{ type: 'q:select', hieroglyph: H[2] }, { type: 'q:incorrect' }, { type: 'q:stealCorrect' }, { type: 'q:next' }],
    [{ type: 'q:select', hieroglyph: H[5] }, { type: 'q:reveal' }, { type: 'q:incorrect' }, { type: 'q:stealIncorrect' }, { type: 'q:next' }],
    [{ type: 'q:select', hieroglyph: H[1] }, { type: 'q:reveal' }, { type: 'q:reveal' }, { type: 'q:correct' }, { type: 'game:adjustScore', team: 'pink', delta: -1 }, { type: 'q:next' }],
    [{ type: 'q:select', hieroglyph: H[4] }, { type: 'q:reveal' }, { type: 'q:incorrect' }, { type: 'q:stealIncorrect' }, { type: 'q:next' }],
  ];

  // Round 1
  t.apply({ type: 'round:start', round: 'connections' });
  for (const script of questionScripts) t.run(script);
  // Round 2 (max 3 reveals; the 3-reveal script is valid for sequences too)
  t.apply({ type: 'round:start', round: 'sequences' });
  const seqScripts: GameAction[][] = [
    [{ type: 'q:select', hieroglyph: H[5] }, { type: 'q:reveal' }, { type: 'q:reveal' }, { type: 'media:play' }, { type: 'media:stop' }, { type: 'q:correct' }, { type: 'q:next' }],
    [{ type: 'q:select', hieroglyph: H[3] }, { type: 'q:reveal' }, { type: 'q:incorrect' }, { type: 'q:stealCorrect' }, { type: 'q:next' }],
    [{ type: 'q:select', hieroglyph: H[2] }, { type: 'q:correct' }, { type: 'q:next' }],
    [{ type: 'q:select', hieroglyph: H[0] }, { type: 'q:reveal' }, { type: 'q:reveal' }, { type: 'q:incorrect' }, { type: 'q:stealIncorrect' }, { type: 'q:next' }],
    [{ type: 'q:select', hieroglyph: H[4] }, { type: 'q:reveal' }, { type: 'q:correct' }, { type: 'q:next' }],
    [{ type: 'q:select', hieroglyph: H[1] }, { type: 'q:incorrect' }, { type: 'q:stealIncorrect' }, { type: 'q:next' }],
  ];
  for (const script of seqScripts) t.run(script);

  // Round 3 — pink: 2 groups then out of lives; blue: complete.
  t.apply({ type: 'round:start', round: 'wall' });
  const [w1, w2] = t.state.pack.walls.map((w) => w.id);
  t.run([
    { type: 'wall:assign', team: 'pink', wallId: w2 },
    { type: 'wall:assign', team: 'blue', wallId: w1 },
    { type: 'wall:show', team: 'pink' },
    { type: 'wall:start' },
  ]);
  t.selectTiles(t.wrongGuess()); // wrong before any group: no lives lost
  t.selectTiles([0]);
  t.selectTiles([0]); // deselect
  t.selectGroup(2);
  t.selectTiles(t.wrongGuess());
  t.selectGroup(0);
  for (let i = 0; i < WALL_LIVES; i++) t.selectTiles(t.wrongGuess());
  t.run([
    { type: 'wall:resolve' },
    { type: 'wall:connectionCorrect' },
    { type: 'wall:connectionIncorrect' },
    { type: 'wall:connectionCorrect' },
    { type: 'wall:connectionIncorrect' },
    { type: 'wall:finish' },
    { type: 'wall:clear' },
    { type: 'wall:show', team: 'blue' },
    { type: 'wall:start' },
  ]);
  t.selectGroup(3);
  t.selectGroup(1);
  t.selectGroup(0); // 3rd found -> 4th auto-solves -> complete
  t.run([
    { type: 'wall:resolve' },
    { type: 'wall:connectionCorrect' },
    { type: 'wall:connectionCorrect' },
    { type: 'wall:connectionCorrect' },
    { type: 'wall:connectionCorrect' },
    { type: 'wall:finish' },
    { type: 'wall:clear' },
  ]);

  // Round 4
  t.apply({ type: 'round:start', round: 'vowels' });
  const variants: GameAction[][] = [
    [{ type: 'player:buzz', playerId: 'p-ann' }, { type: 'vowels:correct' }],
    [{ type: 'player:buzz', playerId: 'p-bob' }, { type: 'vowels:incorrect' }, { type: 'vowels:otherCorrect' }],
    [{ type: 'player:buzz', playerId: 'p-cat' }, { type: 'vowels:incorrect' }, { type: 'vowels:nobody' }],
    [{ type: 'vowels:nobody' }],
    [{ type: 'player:buzz', playerId: 'p-dan' }, { type: 'vowels:reopen' }, { type: 'player:buzz', playerId: 'p-ann' }, { type: 'vowels:reopen' }, { type: 'player:buzz', playerId: 'p-bob' }, { type: 'vowels:correct' }],
  ];
  let k = 0;
  const groups = t.state.pack.vowelGroups;
  for (let gi = 0; gi < groups.length; gi++) {
    t.apply({ type: 'vowels:showClue' });
    for (let ci = 0; ci < groups[gi].clues.length; ci++) {
      t.run(variants[k++ % variants.length]);
      const last = gi === groups.length - 1 && ci === groups[gi].clues.length - 1;
      if (!last) t.apply({ type: 'vowels:next' });
    }
  }
  t.apply({ type: 'round:final' });
  t.apply({ type: 'game:lobby' });
  return t;
}

const trace = playFullGame();

describe('engine verification — full game with frozen inputs', () => {
  it('reaches the expected end state', () => {
    const s = trace.state;
    expect(s.phase).toBe('lobby');
    expect(s.finishedRounds).toEqual(['connections', 'sequences', 'wall', 'vowels']);
    expect(trace.states.length).toBeGreaterThan(150);
    expect(s.version).toBe(trace.states.length - 1);
    for (const r of ROUNDS) expect(canStartRound(s, r), `${r} must not be restartable`).toBe(false);
    for (const r of ROUNDS) expect(() => applyAction(s, { type: 'round:start', round: r }, makeFrozenCtx(NOW))).toThrow(GameError);
  });

  it('alternates teams strictly and opens each question round with the right team', () => {
    for (const round of ['connections', 'sequences'] as const) {
      const picks = trace.states.filter((s) => s.phase === round && s.question?.stage === 'selecting');
      const opener = roundOpener(trace.states[0], round);
      const order = picks.map((s) => s.question?.team);
      expect(order.length).toBe(QUESTIONS_PER_ROUND);
      expect(order).toEqual(order.map((_, i) => (i % 2 === 0 ? opener : otherTeam(opener))));
      // The answering team never changes between pick and answer (even through a steal).
      for (const s of trace.states.filter((x) => x.phase === round && x.question?.stage !== 'selecting')) {
        const qs = s.question;
        if (!qs) throw new Error('no question');
        const expected = qs.questionsDone % 2 === 0 ? opener : otherTeam(opener);
        if (qs.questionsDone < QUESTIONS_PER_ROUND) expect(qs.team).toBe(expected);
      }
    }
  });

  it('keeps question-round invariants in every state (points, reveal caps, used list)', () => {
    for (const s of trace.states) {
      const qs = s.question;
      if (!qs) continue;
      expect(s.phase).toBe(qs.round);
      expect(qs.used.length).toBe(qs.questionsDone + (qs.questionId !== null && qs.questionsDone < QUESTIONS_PER_ROUND ? 1 : 0));
      expect(new Set(qs.used).size).toBe(qs.used.length);
      switch (qs.stage) {
        case 'selecting':
          expect(qs).toMatchObject({ questionId: null, revealed: 0, pointsOnOffer: 0, result: null });
          break;
        case 'question':
          expect(qs.revealed).toBeGreaterThanOrEqual(1);
          expect(qs.revealed).toBeLessThanOrEqual(maxCluesFor(qs.round));
          expect(qs.pointsOnOffer).toBe(CLUE_POINTS[qs.revealed]);
          expect(qs.result).toBeNull();
          break;
        case 'steal':
          expect(qs.revealed).toBe(4);
          expect(qs.pointsOnOffer).toBe(STEAL_POINTS);
          expect(qs.result).toBeNull();
          break;
        case 'answer':
          expect(qs.revealed).toBe(4);
          expect(qs.result).not.toBeNull();
          if (qs.result?.viaSteal) expect(qs.result.points).toBe(qs.result.winner ? STEAL_POINTS : 0);
          else expect(qs.result?.winner).toBe(qs.team);
          break;
        default:
          throw new Error(`unexpected stage ${String(qs.stage)}`);
      }
      // Sequences never shows the 4th clue before the answer.
      if (qs.round === 'sequences' && qs.stage !== 'answer') expect(isClueVisible(qs, 3)).toBe(false);
    }
  });

  it('keeps wall invariants in every state (layout, lives, selection, resolution order, awarded)', () => {
    let sawFrozenByLives = false;
    let sawComplete = false;
    for (const s of trace.states) {
      const play = s.wall?.current;
      if (!play) continue;
      expect(s.phase).toBe('wall');
      // 16 tiles, ids are a permutation of 0..15, every group has exactly 4 tiles.
      expect(play.tiles).toHaveLength(16);
      expect([...play.tiles.map((t) => t.id)].sort((a, b) => a - b)).toEqual(Array.from({ length: 16 }, (_, i) => i));
      for (let g = 0; g < 4; g++) expect(play.tiles.filter((t) => t.group === g)).toHaveLength(4);
      // Solved groups occupy the top rows in solve order.
      const solved = play.groups.filter((g) => g.solvedOrder !== null).sort((a, b) => (a.solvedOrder ?? 0) - (b.solvedOrder ?? 0));
      expect(solved.map((g) => g.solvedOrder)).toEqual(solved.map((_, i) => i));
      solved.forEach((g, row) => {
        expect(play.tiles.slice(row * 4, row * 4 + 4).every((t) => t.group === g.index), `row ${row} must hold group ${g.index}`).toBe(true);
      });
      // Lives: null until 2 groups are found by the team, then 0..3.
      const foundByTeam = play.groups.filter((g) => g.foundByTeam).length;
      if (foundByTeam < 2) expect(play.lives).toBeNull();
      else {
        expect(play.lives).not.toBeNull();
        expect(play.lives).toBeGreaterThanOrEqual(0);
        expect(play.lives).toBeLessThanOrEqual(WALL_LIVES);
      }
      // Selection never reaches 4, has no duplicates and never touches solved tiles.
      expect(play.selected.length).toBeLessThanOrEqual(3);
      expect(new Set(play.selected).size).toBe(play.selected.length);
      for (const id of play.selected) {
        const tile = play.tiles.find((t) => t.id === id);
        expect(tile && play.groups[tile.group].solvedOrder).toBeNull();
      }
      if (play.lastWrong) expect(play.lastWrong).toHaveLength(4);
      // Stage / endReason / timer coherence.
      if (play.stage === 'ready') expect(play).toMatchObject({ startedAt: null, endsAt: null, endReason: null, lives: null, selected: [] });
      if (play.stage === 'live') {
        expect(play.endReason).toBeNull();
        expect(play.endsAt).toBe((play.startedAt ?? 0) + WALL_SECONDS * 1000);
      }
      if (play.stage === 'frozen' || play.stage === 'resolving' || play.stage === 'done') {
        expect(play.endReason).not.toBeNull();
        expect(play.selected).toEqual([]);
        if (play.endReason === 'lives') {
          sawFrozenByLives = true;
          expect(play.lives).toBe(0);
          expect(foundByTeam).toBeGreaterThanOrEqual(2);
          expect(foundByTeam).toBeLessThan(4);
        }
        if (play.endReason === 'complete') {
          sawComplete = true;
          expect(foundByTeam).toBe(4);
          expect(play.groups.every((g) => g.solvedOrder !== null)).toBe(true);
        }
      }
      if (play.stage === 'live' || play.stage === 'frozen') {
        expect(play.groups.every((g) => !g.connectionRevealed && g.connectionCorrect === null)).toBe(true);
        expect(play.groups.filter((g) => g.solvedOrder !== null).every((g) => g.foundByTeam)).toBe(true);
        expect(play.resolvingGroup).toBeNull();
        expect(play.awarded).toBeNull();
      }
      if (play.stage === 'resolving' || play.stage === 'done') {
        expect(play.groups.every((g) => g.solvedOrder !== null)).toBe(true);
        const cut = play.resolvingGroup === null ? 4 : play.resolvingGroup;
        for (const g of play.groups) {
          const revealed = (g.solvedOrder ?? 0) < cut;
          expect(g.connectionRevealed, `group ${g.index} (order ${g.solvedOrder}) revealed while asking ${cut}`).toBe(revealed);
          if (!revealed) expect(g.connectionCorrect).toBeNull();
          else expect(typeof g.connectionCorrect).toBe('boolean');
        }
      }
      if (play.stage === 'done') {
        expect(play.resolvingGroup).toBeNull();
        expect(play.awarded).toEqual(computeAwarded(play));
        const a = play.awarded;
        if (!a) throw new Error('awarded missing');
        expect(a.total).toBe(a.groups + a.connections + a.bonus);
        expect(a.total).toBeLessThanOrEqual(10);
        expect(a.bonus).toBe(a.groups === 4 && a.connections === 4 ? 2 : 0);
      } else {
        expect(play.awarded).toBeNull();
      }
    }
    expect(sawFrozenByLives).toBe(true);
    expect(sawComplete).toBe(true);
    // Concrete scores from this run.
    const pinkDone = trace.states.find((s) => s.wall?.current?.stage === 'done' && s.wall.current.team === 'pink');
    expect(pinkDone?.wall?.current?.awarded).toEqual({ groups: 2, connections: 2, bonus: 0, total: 4 });
    const blueDone = trace.states.find((s) => s.wall?.current?.stage === 'done' && s.wall.current.team === 'blue');
    expect(blueDone?.wall?.current?.awarded).toEqual({ groups: 4, connections: 4, bonus: 2, total: 10 });
    // Each team played the wall it was (re)assigned.
    const [w1, w2] = trace.states[0].pack.walls.map((w) => w.id);
    expect(pinkDone?.wall?.current?.wallId).toBe(w2);
    expect(blueDone?.wall?.current?.wallId).toBe(w1);
  });

  it('keeps vowels invariants in every state (buzz presence, locks, indices)', () => {
    for (const s of trace.states) {
      const vs = s.vowels;
      if (!vs) continue;
      expect(s.phase).toBe('vowels');
      expect(vs.groupIndex).toBeLessThan(s.pack.vowelGroups.length);
      expect(vs.clueIndex).toBeLessThan(s.pack.vowelGroups[vs.groupIndex].clues.length);
      if (vs.stage === 'category' || vs.stage === 'clue') {
        expect(vs.buzz).toBeNull();
        expect(vs.result).toBeNull();
      }
      if (vs.stage === 'buzzed' || vs.stage === 'other') expect(vs.buzz).not.toBeNull();
      if (vs.stage === 'category') expect(vs.lockedPlayers).toEqual([]);
      if (vs.stage === 'buzzed') expect(vs.lockedPlayers).not.toContain(vs.buzz?.playerId);
      if (vs.stage === 'answer') {
        expect(vs.result).not.toBeNull();
        const delta = vs.result?.delta ?? { pink: 0, blue: 0 };
        const sum = delta.pink + delta.blue;
        expect([-1, 0, 1]).toContain(sum);
        if (vs.result?.team) expect(delta[vs.result.team]).toBe(1);
      }
      if (vs.stage === 'other') {
        const delta = vs.result?.delta ?? { pink: 0, blue: 0 };
        expect(vs.buzz && delta[vs.buzz.team]).toBe(-1);
      }
      for (const id of vs.lockedPlayers) expect(s.players.some((p) => p.id === id)).toBe(true);
    }
    // The reopen variant locked two players and the third buzz won.
    const reopened = trace.states.find((s) => s.vowels?.lockedPlayers.length === 2 && s.vowels.stage === 'buzzed');
    expect(reopened?.vowels).toMatchObject({ lockedPlayers: ['p-dan', 'p-ann'], buzz: { playerId: 'p-bob', team: 'blue' } });
    // A second buzz while someone holds the buzzer is rejected with buzz_lost (for both teams).
    for (const s of trace.states.filter((x) => x.vowels?.stage === 'buzzed')) {
      for (const pid of ['p-ann', 'p-bob']) {
        let code: string | null = null;
        try {
          applyAction(s, { type: 'player:buzz', playerId: pid }, makeFrozenCtx(NOW));
        } catch (e) {
          code = e instanceof GameError ? e.code : 'not-a-GameError';
        }
        expect(code).toBe('buzz_lost');
      }
    }
  });

  it('projects no secret in any state before it is revealed', () => {
    for (const s of trace.states) {
      const pub = projectPublic(s, s.updatedAt + 1);
      expect(pub.serverNow).toBe(s.updatedAt + 1);
      expect(pub.version).toBe(s.version);
      const text = JSON.stringify(pub);
      const visible = new Set<string>();
      const qs = s.question;
      const q = qs ? findQuestion(s, qs.questionId) : null;
      if (qs && q) {
        q.clues.forEach((c, i) => {
          if (isClueVisible(qs, i) && (c.kind === 'text' || qs.stage === 'answer')) visible.add(c.text);
        });
        if (qs.stage === 'answer') visible.add(q.answer);
      }
      for (const g of s.wall?.current?.groups ?? []) if (g.connectionRevealed) visible.add(g.connection);
      const vc = currentVowelClue(s);
      if (s.vowels?.stage === 'answer' && vc) visible.add(vc.answer);

      const secrets: string[] = [];
      for (const question of s.pack.questions) {
        secrets.push(question.answer);
        if (question.note) secrets.push(question.note);
        for (const c of question.clues) secrets.push(c.text);
      }
      for (const w of s.pack.walls) for (const g of w.groups) secrets.push(g.connection);
      for (const g of s.pack.vowelGroups) for (const c of g.clues) secrets.push(c.answer);
      for (const secret of secrets) {
        if (visible.has(secret)) continue;
        const needle = JSON.stringify(secret);
        // Short clue words (e.g. "Do", "Re") are checked as whole JSON string values to avoid false matches.
        if (secret.length >= 5) expect(text, `v${s.version} ${s.phase}: leaked "${secret}"`).not.toContain(needle.slice(1, -1));
        else expect(text, `v${s.version} ${s.phase}: leaked "${secret}"`).not.toContain(needle);
      }
      // Internal fields never appear.
      for (const key of ['"pack"', 'finishedRounds', '"seed"', 'wallId', 'connectionRevealed', '"note"', 'packId', 'questionId']) {
        expect(text, `v${s.version}: leaked ${key}`).not.toContain(key);
      }
      // Wall tile group membership only for solved groups.
      const play = s.wall?.current;
      if (play && pub.wall?.current) {
        for (const t of pub.wall.current.tiles) {
          const full = play.tiles.find((x) => x.id === t.id);
          const order = full ? play.groups[full.group].solvedOrder : null;
          if (order === null) expect(t).toMatchObject({ group: null, colour: null });
          else expect(t).toMatchObject({ group: full?.group, colour: order });
        }
        expect(pub.wall.current.tiles.map((t) => t.id)).toEqual(play.tiles.map((t) => t.id)); // same display order
      }
    }
  });

  it('allowedActions matches applyAction for every admin action, with payloads, in every recorded state', () => {
    const ctx = makeFrozenCtx(NOW + 1);
    const applies = (s: GameState, a: GameAction): boolean => {
      try {
        applyAction(s, a, ctx);
        return true;
      } catch (e) {
        if (!(e instanceof GameError)) throw e;
        return false;
      }
    };
    const checked = new Set<string>();
    for (const s of trace.states) {
      const list = allowedActions(s);
      const allowed = new Set(list);
      expect(list.length, 'duplicates in allowedActions').toBe(allowed.size);
      for (const t of list) expect(ALL_ADMIN_TYPES).toContain(t);
      const label = `v${s.version} ${s.phase}/${s.question?.stage ?? s.wall?.current?.stage ?? s.vowels?.stage ?? '-'}`;
      checked.add(label.replace(/^v\d+ /, ''));

      for (const type of ALL_ADMIN_TYPES) {
        switch (type) {
          case 'game:new':
            // Handled by the host via createGame; listed for the console but never applied by the engine.
            expect(allowed.has(type)).toBe(true);
            expect(applies(s, { type, packId: s.packId, teams: TEAM_NAMES, firstTeam: 'pink' })).toBe(false);
            break;
          case 'game:undo':
            // Handled by the host (store history); the engine neither offers nor applies it.
            expect(allowed.has(type)).toBe(false);
            expect(applies(s, { type })).toBe(false);
            break;
          case 'game:setTeamName':
            expect(allowed.has(type)).toBe(true);
            expect(applies(s, { type, team: 'pink', name: 'Renamed' })).toBe(true);
            expect(applies(s, { type, team: 'pink', name: '   ' })).toBe(false);
            break;
          case 'game:adjustScore':
            expect(allowed.has(type)).toBe(true);
            expect(applies(s, { type, team: 'blue', delta: -1 })).toBe(true);
            expect(applies(s, { type, team: 'blue', delta: 1.5 })).toBe(false);
            break;
          case 'game:removePlayer':
            expect(allowed.has(type)).toBe(s.players.length > 0);
            for (const p of s.players) expect(applies(s, { type, playerId: p.id })).toBe(true);
            expect(applies(s, { type, playerId: 'ghost' })).toBe(false);
            break;
          case 'round:start': {
            const startable = ROUNDS.filter((r) => applies(s, { type, round: r }));
            expect(startable, label).toEqual(ROUNDS.filter((r) => canStartRound(s, r)));
            expect(allowed.has(type), label).toBe(startable.length > 0);
            break;
          }
          case 'q:select': {
            for (const h of HIEROGLYPHS) {
              const should = allowed.has(type) && !(s.question?.used ?? []).includes(h);
              expect(applies(s, { type, hieroglyph: h }), `${label}: q:select ${h}`).toBe(should);
            }
            expect(applies(s, { type, hieroglyph: 'sphinx' as Hieroglyph })).toBe(false);
            break;
          }
          case 'wall:assign': {
            // Allowed for any team that has not played yet and whose wall is not the one on screen.
            const round = s.phase === 'wall' ? s.wall : null;
            const assignable = (team: TeamId) => !!round && !round.completed.includes(team) && round.current?.team !== team;
            expect(allowed.has(type), `${label}: wall:assign listed`).toBe(TEAM_IDS.some(assignable));
            for (const team of TEAM_IDS) {
              for (const w of s.pack.walls) {
                expect(applies(s, { type, team, wallId: w.id }), `${label}: wall:assign ${team}`).toBe(assignable(team));
              }
              expect(applies(s, { type, team, wallId: 'nope' })).toBe(false);
            }
            break;
          }
          case 'wall:show': {
            for (const team of TEAM_IDS) {
              const round = s.wall;
              const should = allowed.has(type) && !!round && !round.completed.includes(team) && round.assignment[team] !== null;
              expect(applies(s, { type, team }), `${label}: wall:show ${team}`).toBe(should);
            }
            break;
          }
          case 'wall:timeUp': {
            const stage = s.wall?.current?.stage;
            const noop = s.phase === 'wall' && (stage === 'frozen' || stage === 'resolving' || stage === 'done');
            if (noop) {
              // SPEC §10: a no-op (not an error) once the wall has ended; the admin button is not offered.
              expect(allowed.has(type)).toBe(false);
              const next = applyAction(s, { type }, ctx);
              expect(next.wall).toEqual(s.wall);
              expect(next.teams).toEqual(s.teams);
            } else {
              expect(applies(s, { type }), `${label}: ${type}`).toBe(allowed.has(type));
            }
            break;
          }
          default:
            expect(applies(s, { type } as AdminAction), `${label}: ${type}`).toBe(allowed.has(type));
        }
      }
    }
    // Make sure the run actually covered every stage of every round.
    for (const stage of ['lobby/-', 'connections/selecting', 'connections/question', 'connections/steal', 'connections/answer', 'sequences/question', 'sequences/steal', 'wall/-', 'wall/ready', 'wall/live', 'wall/frozen', 'wall/resolving', 'wall/done', 'vowels/category', 'vowels/clue', 'vowels/buzzed', 'vowels/other', 'vowels/answer', 'final/-']) {
      expect([...checked], `stage ${stage} was never visited`).toContain(stage);
    }
  });

  it('player actions are rejected outside their stage and never listed as admin actions', () => {
    for (const s of trace.states) {
      const list = allowedActions(s);
      expect(list.some((t) => t.startsWith('player:') || t === ('wall:select' as string))).toBe(false);
      const play = s.wall?.current;
      const canSelect = s.phase === 'wall' && play?.stage === 'live';
      let ok = true;
      try {
        applyAction(s, { type: 'wall:select', tileId: play?.selected[0] ?? 0 }, makeFrozenCtx(s.updatedAt + 1));
      } catch (e) {
        if (!(e instanceof GameError)) throw e;
        ok = false;
      }
      // While live, tile 0 may be inside a solved group (then it throws), so only assert the negative direction.
      if (!canSelect) expect(ok, `v${s.version}: wall:select must throw when no wall is live`).toBe(false);
      const canBuzz = s.phase === 'vowels' && s.vowels?.stage === 'clue';
      let buzzed = true;
      try {
        applyAction(s, { type: 'player:buzz', playerId: 'p-bob' }, makeFrozenCtx(s.updatedAt + 1));
      } catch (e) {
        if (!(e instanceof GameError)) throw e;
        buzzed = false;
      }
      expect(buzzed, `v${s.version}: buzz accepted=${buzzed}`).toBe(canBuzz && !(s.vowels?.lockedPlayers ?? []).includes('p-bob'));
    }
  });
});

describe('engine verification — targeted rules', () => {
  const ctx = makeFrozenCtx(NOW);
  const fresh = () => deepFreeze(createGame(deepFreeze(demoPack()), TEAM_NAMES, 'blue', ctx));

  it('wall: a wrong guess with 1 life left freezes at 0 and later selections are rejected', () => {
    const t = new Trace(fresh());
    t.run([{ type: 'round:start', round: 'wall' }, { type: 'wall:show', team: 'blue' }, { type: 'wall:start' }]);
    t.selectGroup(1);
    t.selectGroup(2);
    expect(t.state.wall?.current?.lives).toBe(3);
    t.selectTiles(t.wrongGuess());
    t.selectTiles(t.wrongGuess());
    expect(t.state.wall?.current?.lives).toBe(1);
    t.selectTiles(t.wrongGuess());
    const play = t.state.wall?.current as WallPlay;
    expect(play).toMatchObject({ lives: 0, stage: 'frozen', endReason: 'lives', selected: [] });
    expect(play.lastWrong).toHaveLength(4);
    expect(() => applyAction(t.state, { type: 'wall:select', tileId: groupTileIds(t.state, 0)[0] }, ctx)).toThrow(GameError);
    // Resolution reveals the two unfound groups in pack order after the found ones.
    t.apply({ type: 'wall:resolve' });
    expect(t.state.wall?.current?.groups.map((g) => [g.solvedOrder, g.foundByTeam])).toEqual([[2, false], [0, true], [1, true], [3, false]]);
    expect(t.state.wall?.current?.tiles.map((x) => x.group)).toEqual([1, 1, 1, 1, 2, 2, 2, 2, 0, 0, 0, 0, 3, 3, 3, 3]);
  });

  it('wall: time-up at exactly endsAt rejects selection; the admin may force time-up early', () => {
    const t = new Trace(fresh());
    t.run([{ type: 'round:start', round: 'wall' }, { type: 'wall:show', team: 'pink' }, { type: 'wall:start' }]);
    const play = t.state.wall?.current as WallPlay;
    const endsAt = play.endsAt as number;
    expect(() => applyAction(t.state, { type: 'wall:select', tileId: 0 }, makeFrozenCtx(endsAt))).toThrow(GameError);
    expect(() => applyAction(t.state, { type: 'wall:select', tileId: 0 }, makeFrozenCtx(endsAt - 1))).not.toThrow();
    const early = applyAction(t.state, { type: 'wall:timeUp' }, makeFrozenCtx(endsAt - 100_000));
    expect(early.wall?.current).toMatchObject({ stage: 'frozen', endReason: 'time' });
  });

  it('sequences: scoring after each clue is 5/3/2 and reveal is capped at 3', () => {
    const t = new Trace(fresh());
    t.run([{ type: 'round:start', round: 'sequences' }]);
    expect(t.state.question?.team).toBe('pink'); // blue started the game, so pink opens sequences
    t.apply({ type: 'q:select', hieroglyph: 'lion' });
    const seen = [t.state.question?.pointsOnOffer];
    t.apply({ type: 'q:reveal' });
    seen.push(t.state.question?.pointsOnOffer);
    t.apply({ type: 'q:reveal' });
    seen.push(t.state.question?.pointsOnOffer);
    expect(seen).toEqual([5, 3, 2]);
    expect(() => applyAction(t.state, { type: 'q:reveal' }, ctx)).toThrow(GameError);
    expect(allowedActions(t.state)).not.toContain('q:reveal');
    t.apply({ type: 'q:correct' });
    expect(t.state.teams.pink.score).toBe(2);
  });

  it('media nonce changes on every (re)play so the monitor re-triggers audio', () => {
    const t = new Trace(fresh());
    t.run([{ type: 'round:start', round: 'connections' }, { type: 'q:select', hieroglyph: 'hornedViper' }]);
    const nonces = [t.state.playMedia?.nonce];
    t.apply({ type: 'media:play' });
    nonces.push(t.state.playMedia?.nonce);
    t.apply({ type: 'media:play' });
    nonces.push(t.state.playMedia?.nonce);
    expect(new Set(nonces).size).toBe(3);
    expect(nonces.every((n, i) => i === 0 || (n as number) > (nonces[i - 1] as number))).toBe(true);
  });

  it('createGame never mutates its inputs and rejects a bad firstTeam', () => {
    const pack = deepFreeze(demoPack());
    const teams = deepFreeze({ pink: { name: ' Rosé ' }, blue: { name: 'Azul' } });
    const s = createGame(pack, teams, 'pink', ctx);
    expect(s.teams.pink.name).toBe('Rosé');
    expect(s.pack).toBe(pack);
    expect(() => createGame(pack, teams, 'green' as TeamId, ctx)).toThrow(GameError);
  });
});
