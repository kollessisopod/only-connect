/**
 * Canned GameStates / packs for the /dev/admin fixture pages, built with the real engine so they are always
 * valid, plus in-memory stand-ins for the admin state hook and the packs API (no network).
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  GameError,
  HIEROGLYPHS,
  activeTeams,
  applyAction,
  buildDemoPack,
  createGame,
  nextWallHieroglyph,
  validatePack,
  type ActionContext,
  type AdminAction,
  type GameState,
  type Hieroglyph,
  type MediaRef,
  type Pack,
  type PackSummary,
  type Question,
  type TeamId,
  type Wall,
} from '@only-connect/shared';
import { describeAction } from './actions';
import { LOG_LIMIT, type ActionLogEntry, type AdminStateHook, type LastError, type PacksApi } from './types';

export const FIXTURE_IDS = [
  'lobby',
  'connections-question',
  'connections-timeup',
  'wall-ready',
  'wall-live',
  'wall-4',
  'vowels-buzzed',
  'final',
  'teams4-steal',
  'teams4-vowels',
  'packs-list',
  'pack-editor',
  'pack-editor-12',
  'all',
] as const;
export type FixtureId = (typeof FIXTURE_IDS)[number];
export const GAME_FIXTURE_IDS = [
  'lobby',
  'connections-question',
  'connections-timeup',
  'wall-ready',
  'wall-live',
  'wall-4',
  'vowels-buzzed',
  'final',
  'teams4-steal',
  'teams4-vowels',
] as const;
export type GameFixtureId = (typeof GAME_FIXTURE_IDS)[number];

export const MARATHON_PACK_NAME = 'Marathon pack (12 + 12 questions, 4 walls)';

let seq = 0;
const idFactory = () => `fx-${(++seq).toString(36).padStart(4, '0')}`;

const PLACEHOLDER_IMAGE =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 100"><rect width="160" height="100" fill="#bee5fb"/><circle cx="80" cy="50" r="28" fill="#d02ac8"/></svg>',
  );

/** Demo pack with image urls pointing at an inline SVG so previews render without the bucket. */
export function fixturePack(): Pack {
  const pack = buildDemoPack(idFactory, { name: 'Demo pack' });
  return {
    ...pack,
    questions: pack.questions.map((q) => ({
      ...q,
      clues: q.clues.map((c) => (c.media && c.kind === 'image' ? { ...c, media: { ...c.media, url: PLACEHOLDER_IMAGE } } : c)),
    })),
  };
}

/**
 * The largest pack the contract allows: 12 questions in each round (every hieroglyph once) and 4 walls. Built
 * from the demo pack by appending six text questions per round and two more walls.
 */
export function marathonPack(): Pack {
  const base = fixturePack();
  const extra: Record<Hieroglyph, { clues: string[]; answer: string }> = {
    twoReeds: { clues: [], answer: '' },
    lion: { clues: [], answer: '' },
    twistedFlax: { clues: [], answer: '' },
    hornedViper: { clues: [], answer: '' },
    water: { clues: [], answer: '' },
    eyeOfHorus: { clues: [], answer: '' },
    ankh: { clues: ['Bass', 'Lead', 'Rhythm', 'Air'], answer: '___ guitar' },
    scarab: { clues: ['Zeus', 'Odin', 'Ra', 'Jupiter'], answer: 'Chief gods' },
    feather: { clues: ['Oxford', 'Brogue', 'Loafer', 'Monk'], answer: 'Styles of shoe' },
    owl: { clues: ['Euston', 'Paddington', 'Waterloo', 'Victoria'], answer: 'London railway termini' },
    cobra: { clues: ['Ruby', 'Python', 'Perl', 'Rust'], answer: 'Programming languages' },
    sun: { clues: ['Minim', 'Crotchet', 'Quaver', 'Breve'], answer: 'Note lengths' },
  };
  const sequences: Record<Hieroglyph, { clues: string[]; answer: string }> = {
    ...extra,
    ankh: { clues: ['Monday', 'Tuesday', 'Wednesday', 'Thursday'], answer: 'Thursday (days of the week)' },
    scarab: { clues: ['I', 'V', 'X', 'L'], answer: 'L (Roman numeral symbols in order)' },
    feather: { clues: ['Spring', 'Summer', 'Autumn', 'Winter'], answer: 'Winter (seasons)' },
    owl: { clues: ['Alpha', 'Beta', 'Gamma', 'Delta'], answer: 'Delta (Greek alphabet)' },
    cobra: { clues: ['2', '3', '5', '7'], answer: '7 (prime numbers)' },
    sun: { clues: ['Red', 'Orange', 'Yellow', 'Green'], answer: 'Green (colours of the rainbow)' },
  };
  const questions: Question[] = [...base.questions];
  for (const round of ['connections', 'sequences'] as const) {
    const source = round === 'connections' ? extra : sequences;
    let position = questions.filter((q) => q.round === round).length;
    for (const h of HIEROGLYPHS) {
      if (questions.some((q) => q.round === round && q.hieroglyph === h)) continue;
      const spec = source[h];
      questions.push({ id: idFactory(), round, hieroglyph: h, position: position++, clues: spec.clues.map((text) => ({ kind: 'text', text })), answer: spec.answer });
    }
  }
  const moreWalls: Wall['groups'][] = [
    [
      { connection: 'Beatles', clues: ['John', 'Paul', 'George', 'Ringo'] },
      { connection: 'Tudor monarchs', clues: ['Henry', 'Edward', 'Mary', 'Elizabeth'] },
      { connection: 'Card suits', clues: ['Hearts', 'Spades', 'Clubs', 'Diamonds'] },
      { connection: 'Oceans', clues: ['Pacific', 'Atlantic', 'Indian', 'Arctic'] },
    ],
    [
      { connection: 'Primary colours', clues: ['Red', 'Blue', 'Yellow', 'Green'] },
      { connection: 'Bond actors', clues: ['Connery', 'Moore', 'Craig', 'Dalton'] },
      { connection: 'Noble gases', clues: ['Neon', 'Argon', 'Xenon', 'Radon'] },
      { connection: 'Cheeses', clues: ['Brie', 'Edam', 'Feta', 'Gouda'] },
    ],
  ];
  const walls: Wall[] = [...base.walls];
  for (const groups of moreWalls) {
    walls.push({ id: idFactory(), position: walls.length, hieroglyph: nextWallHieroglyph(walls) ?? 'sun', groups });
  }
  return { ...base, name: MARATHON_PACK_NAME, questions, walls };
}

function ctxAt(now: number): ActionContext {
  return { now, seed: 20240601, newId: idFactory };
}

/** The show's two teams, and the two more a four-team game adds (V3.2). */
const TEAMS: Array<{ id: TeamId; name: string }> = [
  { id: 'pink', name: 'Nightwearers' },
  { id: 'blue', name: 'Frenemies' },
  { id: 'green', name: 'Lapsed Psychologists' },
  { id: 'orange', name: 'Board Gamers' },
];
const TWO_TEAMS = TEAMS.slice(0, 2);

/** Joins a few players — only to the teams that play (a join to an idle team fails with `team_inactive`). */
function withPlayers(state: GameState, now: number): GameState {
  const ctx = ctxAt(now);
  let s = state;
  const playing = activeTeams(state);
  const players: Array<[string, TeamId, boolean]> = [
    ['Mia', 'pink', true],
    ['Tom', 'pink', true],
    ['Priya', 'blue', true],
    ['Jonas', 'blue', false],
    ['Ada', 'green', true],
    ['Kofi', 'orange', true],
  ];
  for (const [name, team, connected] of players) {
    if (!playing.includes(team)) continue;
    const id = idFactory();
    s = applyAction(s, { type: 'player:join', playerId: id, name, team }, ctx);
    if (!connected) s = applyAction(s, { type: 'player:connected', playerId: id, connected: false }, ctx);
  }
  return s;
}

/** Plays one wall from `selecting` to `done` with every connection judged correct, then clears it. */
function playWallThrough(state: GameState, hieroglyph: Hieroglyph, now: number): GameState {
  let s = applyAction(state, { type: 'wall:select', hieroglyph }, ctxAt(now - 400_000));
  s = applyAction(s, { type: 'wall:start' }, ctxAt(now - 400_000));
  const play = s.wall?.current;
  if (play) {
    // The team finds two groups, then runs out of time.
    for (const group of [0, 1]) {
      for (const t of play.tiles.filter((x) => x.group === group)) s = applyAction(s, { type: 'wall:select', tileId: t.id }, ctxAt(now - 390_000));
    }
  }
  s = applyAction(s, { type: 'wall:timeUp' }, ctxAt(now - 200_000));
  s = applyAction(s, { type: 'wall:resolve' }, ctxAt(now - 190_000));
  for (let i = 0; i < 4; i++) s = applyAction(s, { type: i % 2 === 0 ? 'wall:connectionCorrect' : 'wall:connectionIncorrect' }, ctxAt(now - 180_000));
  s = applyAction(s, { type: 'wall:finish' }, ctxAt(now - 170_000));
  return applyAction(s, { type: 'wall:clear' }, ctxAt(now - 160_000));
}

export function fixtureState(id: GameFixtureId, now = Date.now()): GameState {
  const fourTeams = id.startsWith('teams4');
  // A four-team game needs a wall per team: the marathon pack has four.
  const pack = id === 'wall-4' || fourTeams ? marathonPack() : fixturePack();
  const ctx = ctxAt(now);
  let s = withPlayers(createGame(pack, fourTeams ? TEAMS : TWO_TEAMS, ctx), now);
  switch (id) {
    case 'lobby':
      return s;
    case 'connections-question':
    case 'connections-timeup': {
      s = applyAction(s, { type: 'game:adjustScore', team: 'blue', delta: 3 }, ctx);
      s = applyAction(s, { type: 'round:start', round: 'connections' }, ctx);
      s = applyAction(s, { type: 'q:select', hieroglyph: 'water' }, ctx);
      s = applyAction(s, { type: 'q:correct' }, ctx);
      s = applyAction(s, { type: 'q:next' }, ctx);
      // The 40 s clock starts on the pick: 'connections-question' shows it running from page load (picked 5 s
      // ago), 'connections-timeup' shows it run out (time up, two clues shown, team must answer).
      s = applyAction(s, { type: 'q:select', hieroglyph: 'hornedViper' }, ctxAt(now - 5_000));
      s = applyAction(s, { type: 'q:reveal' }, ctxAt(now - 3_000));
      if (id === 'connections-timeup') {
        s = applyAction(s, { type: 'q:reveal' }, ctxAt(now - 1_000));
        s = applyAction(s, { type: 'q:timeUp' }, ctxAt(now));
      }
      return s;
    }
    case 'wall-ready': {
      // A wall chosen but not started: tiles hidden from the monitor and the panel until wall:start.
      s = applyAction(s, { type: 'game:adjustScore', team: 'pink', delta: 8 }, ctx);
      s = applyAction(s, { type: 'game:adjustScore', team: 'blue', delta: 11 }, ctx);
      s = applyAction(s, { type: 'round:start', round: 'wall' }, ctx);
      s = applyAction(s, { type: 'wall:select', hieroglyph: s.wall?.available[0] ?? 'lion' }, ctx);
      return s;
    }
    case 'wall-live': {
      s = applyAction(s, { type: 'game:adjustScore', team: 'pink', delta: 8 }, ctx);
      s = applyAction(s, { type: 'game:adjustScore', team: 'blue', delta: 11 }, ctx);
      s = applyAction(s, { type: 'round:start', round: 'wall' }, ctx);
      // round:start lets the team that is behind (pink here) choose; it picks the first wall glyph (Lion).
      s = applyAction(s, { type: 'wall:select', hieroglyph: s.wall?.available[0] ?? 'lion' }, ctx);
      const started = ctxAt(now - 70_000);
      s = applyAction(s, { type: 'wall:start' }, started);
      // Solve the first group so the host view shows a found group and a colour.
      const play = s.wall?.current;
      if (play) {
        const groupTiles = play.tiles.filter((t) => t.group === 2).map((t) => t.id);
        for (const tileId of groupTiles) s = applyAction(s, { type: 'wall:select', tileId }, ctxAt(now - 30_000));
        // One wrong guess for the lastWrong flash.
        const rest = play.tiles.filter((t) => t.group !== 2).slice(0, 4);
        for (const t of rest) s = applyAction(s, { type: 'wall:select', tileId: t.id }, ctxAt(now - 10_000));
      }
      return s;
    }
    case 'wall-4': {
      // Four walls: pink (behind) chose and played the Lion wall; now blue chooses from the three left.
      s = applyAction(s, { type: 'game:adjustScore', team: 'pink', delta: 8 }, ctx);
      s = applyAction(s, { type: 'game:adjustScore', team: 'blue', delta: 11 }, ctx);
      s = applyAction(s, { type: 'round:start', round: 'wall' }, ctxAt(now - 500_000));
      return playWallThrough(s, 'lion', now);
    }
    case 'vowels-buzzed': {
      s = applyAction(s, { type: 'game:adjustScore', team: 'pink', delta: 17 }, ctx);
      s = applyAction(s, { type: 'game:adjustScore', team: 'blue', delta: 20 }, ctx);
      s = applyAction(s, { type: 'round:start', round: 'vowels' }, ctx);
      s = applyAction(s, { type: 'vowels:showClue' }, ctx);
      s = applyAction(s, { type: 'vowels:nobody' }, ctx);
      s = applyAction(s, { type: 'vowels:next' }, ctx);
      const buzzer = s.players.find((p) => p.team === 'pink' && p.connected);
      if (buzzer) s = applyAction(s, { type: 'player:buzz', playerId: buzzer.id }, ctx);
      return s;
    }
    case 'final': {
      s = applyAction(s, { type: 'game:adjustScore', team: 'pink', delta: 24 }, ctx);
      s = applyAction(s, { type: 'game:adjustScore', team: 'blue', delta: 21 }, ctx);
      s = applyAction(s, { type: 'round:start', round: 'vowels' }, ctx);
      s = applyAction(s, { type: 'round:final' }, ctx);
      return s;
    }
    case 'teams4-steal': {
      // Four teams in Connections, host-chosen order (orange, green, pink, blue); the first question is at the
      // steal stage, so the console shows one "stole it" button per other team.
      s = applyAction(s, { type: 'game:adjustScore', team: 'pink', delta: 4 }, ctx);
      s = applyAction(s, { type: 'game:adjustScore', team: 'blue', delta: 2 }, ctx);
      s = applyAction(s, { type: 'game:adjustScore', team: 'green', delta: 1 }, ctx);
      s = applyAction(s, { type: 'round:start', round: 'connections', order: ['orange', 'green', 'pink', 'blue'] }, ctx);
      s = applyAction(s, { type: 'q:select', hieroglyph: 'twoReeds' }, ctxAt(now - 60_000));
      for (let i = 0; i < 3; i++) s = applyAction(s, { type: 'q:reveal' }, ctxAt(now - 50_000 + i * 5_000));
      s = applyAction(s, { type: 'q:incorrect' }, ctxAt(now - 30_000));
      return s;
    }
    case 'teams4-vowels': {
      // Four teams in Missing Vowels: a green player buzzed and was wrong, so three teams may answer.
      s = applyAction(s, { type: 'game:adjustScore', team: 'pink', delta: 12 }, ctx);
      s = applyAction(s, { type: 'game:adjustScore', team: 'blue', delta: 9 }, ctx);
      s = applyAction(s, { type: 'game:adjustScore', team: 'green', delta: 15 }, ctx);
      s = applyAction(s, { type: 'game:adjustScore', team: 'orange', delta: 9 }, ctx);
      s = applyAction(s, { type: 'round:start', round: 'vowels' }, ctx);
      s = applyAction(s, { type: 'vowels:showClue' }, ctx);
      const buzzer = s.players.find((p) => p.team === 'green' && p.connected);
      if (buzzer) s = applyAction(s, { type: 'player:buzz', playerId: buzzer.id }, ctx);
      s = applyAction(s, { type: 'vowels:incorrect' }, ctx);
      return s;
    }
    default:
      return s;
  }
}

function summarise(p: Pack): PackSummary {
  const problems = validatePack(p);
  return { id: p.id, name: p.name, playable: problems.length === 0, problems, createdAt: p.createdAt, updatedAt: p.updatedAt };
}

/** In-memory packs API: a playable demo pack and a broken one. */
export function createFixturePacksApi(): PacksApi & { packs: Map<string, Pack> } {
  const packs = new Map<string, Pack>();
  const demo = fixturePack();
  packs.set(demo.id, demo);
  const draft = fixturePack();
  const broken: Pack = {
    ...draft,
    name: 'Quiz night (draft)',
    questions: draft.questions.filter((q) => !(q.round === 'sequences' && q.hieroglyph === 'lion')),
    walls: draft.walls.slice(0, 1),
  };
  packs.set(broken.id, broken);
  const marathon = marathonPack();
  packs.set(marathon.id, marathon);
  const delay = <T>(v: T) => new Promise<T>((r) => setTimeout(() => r(v), 60));
  return {
    packs,
    list: () => delay([...packs.values()].map(summarise)),
    get: (id) => {
      const p = packs.get(id);
      return p ? delay(p) : Promise.reject(new Error('pack not found'));
    },
    create: (name) => {
      const now = new Date().toISOString();
      const p: Pack = { id: idFactory(), name, questions: [], walls: [], vowelGroups: [], createdAt: now, updatedAt: now };
      packs.set(p.id, p);
      return delay(p);
    },
    save: (pack) => {
      const saved = { ...pack, updatedAt: new Date().toISOString() };
      packs.set(saved.id, saved);
      return delay(saved);
    },
    remove: (id) => {
      packs.delete(id);
      return delay(undefined);
    },
    duplicate: (id) => {
      const src = packs.get(id);
      if (!src) return Promise.reject(new Error('pack not found'));
      const copy: Pack = { ...src, id: idFactory(), name: `${src.name} (copy)`, updatedAt: new Date().toISOString() };
      packs.set(copy.id, copy);
      return delay(copy);
    },
    upload: (file) => {
      const ref: MediaRef = { key: `uploads/${idFactory()}`, url: URL.createObjectURL(file), mime: file.type || 'application/octet-stream', name: file.name };
      return delay(ref);
    },
    exportJson: (id) => {
      const src = packs.get(id);
      return src ? delay(JSON.stringify(src, null, 2)) : Promise.reject(new Error('pack not found'));
    },
    importJson: (json) => {
      const parsed = JSON.parse(json) as Pack;
      const pack: Pack = { ...parsed, id: idFactory(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      packs.set(pack.id, pack);
      return delay(pack);
    },
    // No zip writer in the browser fixtures: the "bundle" is the JSON document under a .json name.
    exportBundle: (id) => {
      const src = packs.get(id);
      if (!src) return Promise.reject(new Error('pack not found'));
      const blob = new Blob([JSON.stringify(src, null, 2)], { type: 'application/json' });
      return delay({ blob, filename: `${src.name.replace(/[^\w.-]+/g, '_').slice(0, 60) || 'pack'}.only-connect.json` });
    },
    importBundle: async (file) => {
      const text = await file.text();
      if (text.startsWith('PK')) throw new Error('zip bundles need the server (fixtures accept .json only)');
      const parsed = JSON.parse(text) as Pack;
      const pack: Pack = { ...parsed, id: idFactory(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      packs.set(pack.id, pack);
      return delay({ pack, imported: 0, skipped: 0, warnings: [] });
    },
  };
}

let logSeq = 0;

/** Stand-in for `useAdminState`: applies actions locally with the engine (no network). */
export function useFixtureGame(initial: GameState | null, packsApi: PacksApi & { packs: Map<string, Pack> }): AdminStateHook {
  const [state, setState] = useState<GameState | null>(initial);
  const [lastError, setLastError] = useState<LastError | null>(null);
  const [log, setLog] = useState<ActionLogEntry[]>([]);
  const stateRef = useRef(state);
  stateRef.current = state;

  const dispatch = useCallback(
    async (action: AdminAction): Promise<GameState | null> => {
      const at = Date.now();
      const label = describeAction(action, stateRef.current);
      const id = ++logSeq;
      await new Promise((r) => setTimeout(r, 40));
      try {
        let next: GameState;
        if (action.type === 'game:new') {
          const pack = packsApi.packs.get(action.packId);
          if (!pack) throw new GameError('unknown pack', 'unknown_pack');
          next = createGame(pack, action.teams, ctxAt(Date.now()));
        } else {
          if (!stateRef.current) throw new GameError('no game');
          next = applyAction(stateRef.current, action, ctxAt(Date.now()));
        }
        stateRef.current = next;
        setState(next);
        setLog((l) => [{ id, at, action, label, ok: true, tookMs: Date.now() - at }, ...l].slice(0, LOG_LIMIT));
        return next;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'failed';
        setLog((l) => [{ id, at, action, label, ok: false, error: message, tookMs: Date.now() - at }, ...l].slice(0, LOG_LIMIT));
        setLastError({ id, message: `${label}: ${message}` });
        return null;
      }
    },
    [packsApi],
  );
  const clearLastError = useCallback(() => setLastError(null), []);

  return useMemo(
    () => ({ state, loaded: true, connected: true, error: null, lastError, clearLastError, dispatch, log }),
    [state, lastError, clearLastError, dispatch, log],
  );
}
