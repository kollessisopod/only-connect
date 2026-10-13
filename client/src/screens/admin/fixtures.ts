/**
 * Canned GameStates / packs for the /dev/admin fixture pages, built with the real engine so they are always
 * valid, plus in-memory stand-ins for the admin state hook and the packs API (no network).
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  GameError,
  applyAction,
  buildDemoPack,
  createGame,
  validatePack,
  type ActionContext,
  type AdminAction,
  type GameState,
  type MediaRef,
  type Pack,
  type PackSummary,
} from '@only-connect/shared';
import { describeAction } from './actions';
import { LOG_LIMIT, type ActionLogEntry, type AdminStateHook, type LastError, type PacksApi } from './types';

export const FIXTURE_IDS = ['lobby', 'connections-question', 'wall-live', 'vowels-buzzed', 'final', 'packs-list', 'pack-editor', 'all'] as const;
export type FixtureId = (typeof FIXTURE_IDS)[number];

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

function ctxAt(now: number): ActionContext {
  return { now, seed: 20240601, newId: idFactory };
}

const TEAMS = { pink: { name: 'Nightwearers' }, blue: { name: 'Frenemies' } };

function withPlayers(state: GameState, now: number): GameState {
  const ctx = ctxAt(now);
  let s = state;
  const players: Array<[string, 'pink' | 'blue', boolean]> = [
    ['Mia', 'pink', true],
    ['Tom', 'pink', true],
    ['Priya', 'blue', true],
    ['Jonas', 'blue', false],
  ];
  for (const [name, team, connected] of players) {
    const id = idFactory();
    s = applyAction(s, { type: 'player:join', playerId: id, name, team }, ctx);
    if (!connected) s = applyAction(s, { type: 'player:connected', playerId: id, connected: false }, ctx);
  }
  return s;
}

export function fixtureState(id: Exclude<FixtureId, 'packs-list' | 'pack-editor' | 'all'>, now = Date.now()): GameState {
  const pack = fixturePack();
  const ctx = ctxAt(now);
  let s = withPlayers(createGame(pack, TEAMS, 'pink', ctx), now);
  switch (id) {
    case 'lobby':
      return s;
    case 'connections-question': {
      s = applyAction(s, { type: 'game:adjustScore', team: 'blue', delta: 3 }, ctx);
      s = applyAction(s, { type: 'round:start', round: 'connections' }, ctx);
      s = applyAction(s, { type: 'q:select', hieroglyph: 'water' }, ctx);
      s = applyAction(s, { type: 'q:correct' }, ctx);
      s = applyAction(s, { type: 'q:next' }, ctx);
      s = applyAction(s, { type: 'q:select', hieroglyph: 'hornedViper' }, ctx);
      s = applyAction(s, { type: 'q:reveal' }, ctx);
      return s;
    }
    case 'wall-live': {
      s = applyAction(s, { type: 'game:adjustScore', team: 'pink', delta: 8 }, ctx);
      s = applyAction(s, { type: 'game:adjustScore', team: 'blue', delta: 11 }, ctx);
      s = applyAction(s, { type: 'round:start', round: 'wall' }, ctx);
      s = applyAction(s, { type: 'wall:show', team: 'pink' }, ctx);
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
          next = createGame(pack, action.teams, action.firstTeam, ctxAt(Date.now()));
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
