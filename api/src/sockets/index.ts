/**
 * socket.io wiring (SPEC §4).
 *
 *  namespace "/"       monitor / wall / button. Sends `state` (PublicGameState | NoGameState) on connect and
 *                      after every change. Handles player:join / player:leave / player:buzz / wall:select with
 *                      acks. A socket's player is marked disconnected when its last socket goes away.
 *  namespace "/admin"  requires a valid JWT in `handshake.auth.token`; receives the full GameState.
 *
 * Identity: a socket acts only as the player it joined as. `player:join` creates a player (fresh id + a
 * secret, both returned in the ack) or rejoins an existing id when the secret matches; `player:buzz` and
 * `player:leave` ignore any id in the payload and use the socket's own player. Player ids are public (they
 * are in the projection) but the secret never leaves the ack / the full state.
 *
 * The handler functions are exported on their own (they only need the store) so they can be unit-tested
 * without opening sockets.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { Namespace, Server, Socket } from 'socket.io';

/** Structurally identical to socket.io's DefaultEventsMap (which is not part of its public exports). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DefaultEventsMap = Record<string, (...args: any[]) => void>;
import {
  GameError,
  projectPublic,
  type Ack,
  type AdminServerToClientEvents,
  type ClientToServerEvents,
  type GameAction,
  type GameState,
  type ServerToClientEvents,
  type TeamId,
} from '@only-connect/shared';
import { verifySocketAuth } from '../auth.js';
import { joinPayloadSchema, wallSelectPayloadSchema } from '../game/schema.js';
import type { GameStore, StoreLogger } from '../game/store.js';
import { socketLimits } from '../ratelimit.js';

export interface SocketData {
  playerId: string | null;
  secret: string | null;
  name: string | null;
  team: TeamId | null;
}

export type PublicServer = Server<ClientToServerEvents, ServerToClientEvents, DefaultEventsMap, SocketData>;
export type PublicSocket = Socket<ClientToServerEvents, ServerToClientEvents, DefaultEventsMap, SocketData>;
export type AdminNamespace = Namespace<DefaultEventsMap, AdminServerToClientEvents, DefaultEventsMap, SocketData>;

const silent: StoreLogger = { info() {}, warn() {}, error() {}, debug() {} };

/** Presence-only changes are coalesced into one broadcast (see `attachSockets`). */
const PRESENCE_COALESCE_MS = 40;

function failAck<T>(err: unknown, log: StoreLogger, extra?: T): Ack<T> {
  if (err instanceof GameError) {
    return extra === undefined
      ? { ok: false, error: err.message, code: err.code }
      : { ok: false, error: err.message, code: err.code, data: extra };
  }
  log.error(`[socket] handler failed: ${(err as Error).message}`);
  return extra === undefined
    ? { ok: false, error: 'internal error', code: 'internal' }
    : { ok: false, error: 'internal error', code: 'internal', data: extra };
}

export function newSecret(): string {
  return randomBytes(18).toString('base64url');
}

// ---------------------------------------------------------------------------
// Handlers (pure functions of store + payload)
// ---------------------------------------------------------------------------

export interface JoinResult {
  ack: Ack<{ playerId: string; secret: string }>;
  player: { id: string; secret: string; name: string; team: TeamId } | null;
}

/**
 * player:join — `playerId: null` creates a player with a fresh uuid and secret. A supplied id is kept as
 * is: when it exists the engine checks the secret (`not_owner` otherwise), when it does not the player is
 * created with that id (a phone keeps its identity across games). The decision happens inside the engine,
 * i.e. on the store queue, so two concurrent joins for the same id converge on one player.
 */
export async function handleJoin(
  store: GameStore,
  payload: unknown,
  who: string,
  log: StoreLogger = silent,
  newId: () => string = randomUUID,
  makeSecret: () => string = newSecret,
): Promise<JoinResult> {
  const parsed = joinPayloadSchema.safeParse(payload);
  if (!parsed.success) return { ack: { ok: false, error: 'name and team (pink/blue) are required' }, player: null };
  const { name, team } = parsed.data;
  if (!store.getState()) return { ack: { ok: false, error: 'no game in progress', code: 'no_game' }, player: null };
  const requested = parsed.data.playerId ?? null;
  const playerId = requested ?? newId();
  const secret = requested && parsed.data.secret ? parsed.data.secret : makeSecret();
  try {
    await store.dispatch({ type: 'player:join', playerId, secret, name, team }, { who });
    return { ack: { ok: true, data: { playerId, secret } }, player: { id: playerId, secret, name, team } };
  } catch (err) {
    return { ack: failAck(err, log), player: null };
  }
}

/** player:leave for the socket's own player (`playerId` is the one the socket joined as). */
export async function handleLeave(store: GameStore, playerId: string | null, who: string, log: StoreLogger = silent): Promise<Ack> {
  if (!playerId) return { ok: false, error: 'join the game first', code: 'not_joined' };
  try {
    await store.dispatch({ type: 'player:leave', playerId }, { who });
    return { ok: true };
  } catch (err) {
    if (err instanceof GameError && err.code === 'unknown_player') return { ok: true }; // already gone
    return failAck(err, log);
  }
}

/**
 * player:buzz for the socket's own player — `won` is true only for the first buzz applied on this clue. A
 * buzz that arrives after the clue was taken is acknowledged as `{ ok: true, data: { won: false } }`;
 * buzzing when the buzzers are closed, before joining, or as a locked-out player, is an error.
 */
export async function handleBuzz(store: GameStore, playerId: string | null, who: string, log: StoreLogger = silent): Promise<Ack<{ won: boolean }>> {
  if (!playerId) return { ok: false, error: 'join the game first', code: 'not_joined', data: { won: false } };
  try {
    await store.dispatch({ type: 'player:buzz', playerId }, { who });
    return { ok: true, data: { won: true } };
  } catch (err) {
    if (err instanceof GameError && err.code === 'buzz_lost') return { ok: true, data: { won: false }, error: err.message, code: err.code };
    return failAck(err, log, { won: false });
  }
}

export async function handleSelect(store: GameStore, payload: unknown, who: string, log: StoreLogger = silent): Promise<Ack> {
  const parsed = wallSelectPayloadSchema.safeParse(payload);
  if (!parsed.success) return { ok: false, error: 'tileId (0..15) is required' };
  try {
    await store.dispatch({ type: 'wall:select', tileId: parsed.data.tileId }, { who });
    return { ok: true };
  } catch (err) {
    return failAck(err, log);
  }
}

function tooMany<T = undefined>(data?: T): Ack<T> {
  return data === undefined
    ? { ok: false, error: 'too many requests, slow down', code: 'rate_limited' }
    : { ok: false, error: 'too many requests, slow down', code: 'rate_limited', data };
}

/** Client address for rate limiting: the proxy's X-Forwarded-For when present (nginx sets it), else the peer. */
export function clientAddress(socket: Pick<PublicSocket, 'handshake'>): string {
  const fwd = socket.handshake.headers['x-forwarded-for'];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim();
  return first || socket.handshake.address || 'unknown';
}

/** True when the change only concerns who is connected (coalesced into one broadcast). */
export function isPresenceChange(action: GameAction | undefined): boolean {
  return action?.type === 'player:join' || action?.type === 'player:connected';
}

// ---------------------------------------------------------------------------
// Attachment
// ---------------------------------------------------------------------------

export interface AttachedSockets {
  publicNs: PublicServer;
  adminNs: AdminNamespace;
  /** Stop forwarding store changes (sockets stay open; `io.close()` handles those). */
  detach(): void;
}

export function attachSockets(rawIo: Server, store: GameStore, log: StoreLogger = silent): AttachedSockets {
  const io = rawIo as unknown as PublicServer;
  const adminNs = io.of('/admin') as unknown as AdminNamespace;

  /** playerId -> live socket ids, so a player with two tabs is only "disconnected" when the last one goes. */
  const socketsByPlayer = new Map<string, Set<string>>();

  const track = (playerId: string, socketId: string) => {
    let set = socketsByPlayer.get(playerId);
    if (!set) {
      set = new Set();
      socketsByPlayer.set(playerId, set);
    }
    set.add(socketId);
  };
  const untrack = (playerId: string, socketId: string): boolean => {
    const set = socketsByPlayer.get(playerId);
    if (!set) return true;
    set.delete(socketId);
    if (set.size === 0) {
      socketsByPlayer.delete(playerId);
      return true;
    }
    return false;
  };

  const broadcast = (state: GameState) => {
    io.emit('state', projectPublic(state, Date.now()));
    adminNs.emit('state', state);
  };

  // A burst of joins / reconnects (N phones after an API restart) would otherwise broadcast the full state
  // N times to every socket; presence-only changes are batched for a few ms, any other change flushes at once.
  let pendingPresence: ReturnType<typeof setTimeout> | null = null;
  const flushPresence = () => {
    if (pendingPresence !== null) {
      clearTimeout(pendingPresence);
      pendingPresence = null;
    }
  };
  const announce = (state: GameState, action?: GameAction) => {
    if (isPresenceChange(action)) {
      if (pendingPresence !== null) return; // the trailing broadcast will carry the latest state
      pendingPresence = setTimeout(() => {
        pendingPresence = null;
        const latest = store.getState();
        if (latest) broadcast(latest);
      }, PRESENCE_COALESCE_MS);
      return;
    }
    flushPresence();
    broadcast(state);
  };

  const markDisconnected = (playerId: string, who: string) => {
    const state = store.getState();
    if (!state || !state.players.some((p) => p.id === playerId && p.connected)) return;
    store.dispatch({ type: 'player:connected', playerId, connected: false }, { who }).catch((err: unknown) => {
      if (!(err instanceof GameError)) log.error(`[socket] disconnect update failed: ${(err as Error).message}`);
    });
  };

  // When a new game replaces the old one, players who are still connected are re-joined automatically so the
  // phones don't have to re-enter their names (the phone itself only joins on connect).
  const rejoinAll = (state: GameState) => {
    for (const socket of io.sockets.sockets.values()) {
      const d = socket.data;
      if (!d.playerId || !d.name || !d.team || !d.secret) continue;
      if (state.players.some((p) => p.id === d.playerId)) continue;
      store
        .dispatch({ type: 'player:join', playerId: d.playerId, secret: d.secret, name: d.name, team: d.team }, { who: `socket ${socket.id} (rejoin)` })
        .catch((err: unknown) => log.warn(`[socket] auto-rejoin failed: ${(err as Error).message}`));
    }
  };

  const unsubscribe = store.subscribe((state, previous, action) => {
    announce(state, action);
    if (!previous || previous.id !== state.id) rejoinAll(state);
  });

  io.on('connection', (socket: PublicSocket) => {
    socket.data.playerId = socket.data.playerId ?? null;
    socket.data.secret = socket.data.secret ?? null;
    socket.data.name = socket.data.name ?? null;
    socket.data.team = socket.data.team ?? null;
    const who = `socket ${socket.id}`;
    const address = clientAddress(socket);
    log.debug(`[socket] ${who} connected (${io.engine.clientsCount} clients)`);
    socket.emit('state', store.getPublic());

    socket.on('player:join', (payload, ack) => {
      if (!socketLimits.presence.tryTake(socket.id) || !socketLimits.joinsPerAddress.tryTake(address)) {
        if (typeof ack === 'function') ack(tooMany());
        return;
      }
      void handleJoin(store, payload, who, log).then((result) => {
        if (result.player) {
          const { id, secret, name, team } = result.player;
          if (socket.data.playerId && socket.data.playerId !== id) untrack(socket.data.playerId, socket.id);
          socket.data.playerId = id;
          socket.data.secret = secret;
          socket.data.name = name;
          socket.data.team = team;
          if (socket.connected) track(id, socket.id);
          // The socket went away while the join was queued: the disconnect handler ran before it knew the
          // player, so finish the bookkeeping here instead of leaving the player online forever.
          else if (untrack(id, socket.id)) markDisconnected(id, who);
        }
        if (typeof ack === 'function') ack(result.ack);
      });
    });

    socket.on('player:leave', (_payload, ack) => {
      if (!socketLimits.presence.tryTake(socket.id)) {
        if (typeof ack === 'function') ack(tooMany());
        return;
      }
      const id = socket.data.playerId;
      void handleLeave(store, id, who, log).then((res) => {
        if (id) {
          untrack(id, socket.id);
          socket.data.playerId = null;
          socket.data.secret = null;
          socket.data.name = null;
          socket.data.team = null;
        }
        if (typeof ack === 'function') ack(res);
      });
    });

    socket.on('player:buzz', (_payload, ack) => {
      if (!socketLimits.play.tryTake(socket.id)) {
        if (typeof ack === 'function') ack(tooMany({ won: false }));
        return;
      }
      void handleBuzz(store, socket.data.playerId, who, log).then((res) => {
        if (typeof ack === 'function') ack(res);
      });
    });

    socket.on('wall:select', (payload, ack) => {
      if (!socketLimits.play.tryTake(socket.id)) {
        if (typeof ack === 'function') ack(tooMany());
        return;
      }
      void handleSelect(store, payload, who, log).then((res) => {
        if (typeof ack === 'function') ack(res);
      });
    });

    socket.on('disconnect', (reason) => {
      log.debug(`[socket] ${who} disconnected (${reason})`);
      const playerId = socket.data.playerId;
      if (!playerId) return;
      if (!untrack(playerId, socket.id)) return;
      markDisconnected(playerId, who);
    });
  });

  adminNs.use((socket, next) => {
    const claims = verifySocketAuth(socket.handshake.auth);
    if (!claims) {
      log.warn(`[socket] admin handshake rejected (${socket.id})`);
      next(new Error('unauthorized'));
      return;
    }
    next();
  });

  adminNs.on('connection', (socket) => {
    log.debug(`[socket] admin ${socket.id} connected`);
    socket.emit('state', store.getState());
  });

  return {
    publicNs: io,
    adminNs,
    detach: () => {
      unsubscribe();
      flushPresence();
    },
  };
}
