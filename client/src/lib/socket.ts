import { io, type Socket } from 'socket.io-client';
import type { Ack, ClientToServerEvents, ServerToClientEvents, TeamId } from '@only-connect/shared';

export type PublicSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

let socket: PublicSocket | null = null;

/**
 * Lazily-created singleton for the public namespace "/". Reconnects forever with backoff.
 * The URL is relative so the same build works behind nginx (prod) and the Vite proxy (dev).
 */
export function getSocket(): PublicSocket {
  if (!socket) {
    socket = io('/', {
      path: '/socket.io',
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 500,
      reconnectionDelayMax: 5_000,
      randomizationFactor: 0.3,
      timeout: 10_000,
      autoConnect: true,
    });
  }
  return socket;
}

const ACK_TIMEOUT_MS = 6_000;

function unwrap<T>(err: Error | null, res: Ack<T> | undefined): Ack<T> {
  if (err) return { ok: false, error: err.message || 'timeout' };
  if (!res) return { ok: false, error: 'no response' };
  return res;
}

/**
 * Join (or re-join with a stored id + secret) the player lobby. Resolves with the server-assigned playerId
 * and the secret that proves ownership of it on later joins.
 */
export function joinPlayer(payload: {
  playerId: string | null;
  secret?: string | null;
  name: string;
  team: TeamId;
}): Promise<Ack<{ playerId: string; secret: string }>> {
  return new Promise((resolve) => {
    getSocket()
      .timeout(ACK_TIMEOUT_MS)
      .emit('player:join', payload, (err, res) => resolve(unwrap(err, res)));
  });
}

export function leavePlayer(playerId: string): Promise<Ack> {
  return new Promise((resolve) => {
    getSocket()
      .timeout(ACK_TIMEOUT_MS)
      .emit('player:leave', { playerId }, (err, res) => resolve(unwrap(err, res)));
  });
}

/** Missing Vowels buzzer. `data.won` tells whether this buzz was the first the server received. */
export function buzz(playerId: string): Promise<Ack<{ won: boolean }>> {
  return new Promise((resolve) => {
    getSocket()
      .timeout(ACK_TIMEOUT_MS)
      .emit('player:buzz', { playerId }, (err, res) => resolve(unwrap(err, res)));
  });
}

/** Connecting Wall tile tap from the /wall panel. */
export function selectWallTile(tileId: number): Promise<Ack> {
  return new Promise((resolve) => {
    getSocket()
      .timeout(ACK_TIMEOUT_MS)
      .emit('wall:select', { tileId }, (err, res) => resolve(unwrap(err, res)));
  });
}
