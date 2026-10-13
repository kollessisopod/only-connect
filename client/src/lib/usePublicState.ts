import { useEffect, useRef, useState } from 'react';
import type { PublicStateMessage } from '@only-connect/shared';
import { getPublicState } from './api';
import { getClockOffset, recordServerNow, subscribeClockOffset } from './clock';
import { getSocket } from './socket';

export interface PublicStateHook {
  /** Latest public projection, or null until the first load succeeds. */
  state: PublicStateMessage | null;
  /** `serverNow - Date.now()` in ms. Add it to Date.now() to get server time. */
  clockOffset: number;
  /** Whether the socket is currently connected. */
  connected: boolean;
  /** Last load/socket error message (cleared on success). */
  error: string | null;
}

function isStale(current: PublicStateMessage | null, incoming: PublicStateMessage): boolean {
  if (!current || current.id === null || incoming.id === null) return false;
  if (current.id !== incoming.id) return false;
  return incoming.version < current.version;
}

/**
 * Loads `/api/state` once, then follows the socket `state` broadcasts on namespace "/".
 * Re-fetches on every (re)connect so nothing is missed while offline.
 */
export function usePublicState(): PublicStateHook {
  const [state, setState] = useState<PublicStateMessage | null>(null);
  const [clockOffset, setClockOffset] = useState<number>(() => getClockOffset());
  const [connected, setConnected] = useState<boolean>(() => getSocket().connected);
  const [error, setError] = useState<string | null>(null);
  const stateRef = useRef<PublicStateMessage | null>(null);

  useEffect(() => {
    let alive = true;
    const socket = getSocket();
    // Socket frames are ordered; a REST reply is not. Count socket frames so a /api/state response that was
    // computed before a later broadcast (e.g. one for a brand new game) is dropped instead of winning.
    let socketFrames = 0;

    const accept = (incoming: PublicStateMessage) => {
      if (!alive) return;
      recordServerNow(incoming.serverNow);
      if (isStale(stateRef.current, incoming)) return;
      stateRef.current = incoming;
      setState(incoming);
      setError(null);
    };
    const onFrame = (incoming: PublicStateMessage) => {
      socketFrames += 1;
      accept(incoming);
    };

    const load = () => {
      const framesAtRequest = socketFrames;
      getPublicState()
        .then((incoming) => {
          if (socketFrames !== framesAtRequest) return; // the socket delivered something newer meanwhile
          accept(incoming);
        })
        .catch((err: unknown) => {
          if (!alive) return;
          setError(err instanceof Error ? err.message : 'failed to load state');
        });
    };

    const onConnect = () => {
      if (!alive) return;
      setConnected(true);
      load();
    };
    const onDisconnect = () => {
      if (alive) setConnected(false);
    };
    const onConnectError = (err: Error) => {
      if (alive) setError(err.message || 'socket error');
    };

    socket.on('state', onFrame);
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('connect_error', onConnectError);
    const unsubClock = subscribeClockOffset((o) => {
      if (alive) setClockOffset(o);
    });

    load();
    if (!socket.connected) socket.connect();

    return () => {
      alive = false;
      socket.off('state', onFrame);
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('connect_error', onConnectError);
      unsubClock();
    };
  }, []);

  return { state, clockOffset, connected, error };
}
