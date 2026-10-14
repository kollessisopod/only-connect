/**
 * Admin-side game state: a dedicated socket.io connection to the "/admin" namespace (JWT in the handshake)
 * that receives the full GameState, plus `dispatch` which POSTs AdminActions through the REST API.
 *
 * The admin feed carries no server clock sample (`GameState` has no `serverNow`), but the console renders
 * countdowns (the 40 s chip, the wall clock) from `endsAt` through `useServerNow()`, which needs the clock
 * offset `recordServerNow` keeps. So the console also listens on the public namespace — the same `state`
 * broadcast the monitor gets, `serverNow` included — purely to sample the clock, so the host sees the same
 * seconds as the audience even when the laptop's clock is off from the API host.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import type { AdminAction, AdminServerToClientEvents, GameState, PublicStateMessage } from '@only-connect/shared';
import { ApiError, UNAUTHORIZED_EVENT, clearToken, getAdminState, sendAction } from '../../lib/api';
import { recordServerNow } from '../../lib/clock';
import { getSocket } from '../../lib/socket';
import { describeAction } from './actions';
import { LOG_LIMIT, type ActionLogEntry, type AdminStateHook, type LastError } from './types';

export type AdminSocket = Socket<AdminServerToClientEvents, Record<string, never>>;

/** Creates the admin namespace socket; a fresh instance per token so a re-login re-authenticates. */
export function createAdminSocket(token: string): AdminSocket {
  return io('/admin', {
    path: '/socket.io',
    auth: { token },
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 500,
    reconnectionDelayMax: 5_000,
    randomizationFactor: 0.3,
    timeout: 10_000,
    autoConnect: true,
  });
}

function isStale(current: GameState | null, incoming: GameState | null): boolean {
  if (!current || !incoming) return false;
  if (current.id !== incoming.id) return false;
  return incoming.version < current.version;
}

function looksUnauthorized(message: string): boolean {
  return /unauthori[sz]ed|forbidden|invalid token|jwt|expired|\b401\b/i.test(message);
}

let logSeq = 0;

export function useAdminState(token: string | null): AdminStateHook {
  const [state, setState] = useState<GameState | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastError, setLastError] = useState<LastError | null>(null);
  const [log, setLog] = useState<ActionLogEntry[]>([]);
  const stateRef = useRef<GameState | null>(null);

  const accept = useCallback((incoming: GameState | null) => {
    if (isStale(stateRef.current, incoming)) return;
    stateRef.current = incoming;
    setState(incoming);
    setLoaded(true);
    setError(null);
  }, []);

  useEffect(() => {
    if (!token) {
      stateRef.current = null;
      setState(null);
      setLoaded(false);
      setConnected(false);
      return;
    }
    let alive = true;
    const socket = createAdminSocket(token);

    const onState = (incoming: GameState | null) => {
      if (alive) accept(incoming);
    };
    const load = () => {
      getAdminState()
        .then((s) => {
          if (alive) accept(s ?? null);
        })
        .catch((err: unknown) => {
          if (!alive) return;
          // 401 already dispatched UNAUTHORIZED_EVENT inside the api helper.
          setError(err instanceof Error ? err.message : 'failed to load state');
        });
    };
    const onConnect = () => {
      if (!alive) return;
      setConnected(true);
      setError(null);
      load();
    };
    const onDisconnect = () => {
      if (alive) setConnected(false);
    };
    const onConnectError = (err: Error) => {
      if (!alive) return;
      const message = err.message || 'socket error';
      setError(message);
      if (looksUnauthorized(message)) {
        clearToken();
        window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
      }
    };

    socket.on('state', onState);
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('connect_error', onConnectError);
    load();

    // Clock sampling only (see the file comment): the public projection itself is not used here.
    const pub = getSocket();
    const onPublicState = (incoming: PublicStateMessage) => {
      if (alive && typeof incoming.serverNow === 'number') recordServerNow(incoming.serverNow);
    };
    pub.on('state', onPublicState);

    return () => {
      alive = false;
      pub.off('state', onPublicState);
      socket.off('state', onState);
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('connect_error', onConnectError);
      socket.disconnect();
    };
  }, [token, accept]);

  const dispatch = useCallback(
    async (action: AdminAction): Promise<GameState | null> => {
      const started = Date.now();
      const label = describeAction(action, stateRef.current);
      const id = ++logSeq;
      try {
        const next = await sendAction(action);
        accept(next);
        setLog((l) => [{ id, at: started, action, label, ok: true, tookMs: Date.now() - started }, ...l].slice(0, LOG_LIMIT));
        return next;
      } catch (err: unknown) {
        const message = err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'request failed';
        setLog((l) => [{ id, at: started, action, label, ok: false, error: message, tookMs: Date.now() - started }, ...l].slice(0, LOG_LIMIT));
        setLastError({ id, message: `${label}: ${message}` });
        return null;
      }
    },
    [accept],
  );

  const clearLastError = useCallback(() => setLastError(null), []);

  return useMemo(
    () => ({ state, loaded, connected, error, lastError, clearLastError, dispatch, log }),
    [state, loaded, connected, error, lastError, clearLastError, dispatch, log],
  );
}
