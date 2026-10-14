import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { allowedActions, type AdminAction, type GameState } from '@only-connect/shared';
import { HOTKEYS } from './actions';
import { ActionLog } from './ActionLog';
import { HostView } from './HostView';
import { NewGamePanel } from './NewGamePanel';
import { RoundControls } from './RoundControls';
import { ShowCues } from './ShowCues';
import { StatusBar } from './StatusBar';
import type { AdminStateHook, PacksApi } from './types';
import { Notice, Toast } from './ui';

export interface GameControlProps {
  game: AdminStateHook;
  packs: PacksApi;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

export function GameControl({ game, packs }: GameControlProps) {
  const { state, loaded, error, lastError, clearLastError, dispatch, log } = game;
  const [pending, setPending] = useState(0);
  const busy = pending > 0;
  const stateRef = useRef<GameState | null>(state);
  stateRef.current = state;

  // `game:undo` is decided by the server's history (state.undoable), not by the engine's allowedActions.
  const allowed = useMemo<ReadonlySet<AdminAction['type']>>(() => {
    if (!state) return new Set<AdminAction['type']>(['game:new']);
    const set = new Set<AdminAction['type']>(allowedActions(state));
    if (state.undoable) set.add('game:undo');
    return set;
  }, [state]);
  const allowedRef = useRef(allowed);
  allowedRef.current = allowed;

  const send = useCallback(
    async (action: AdminAction) => {
      setPending((n) => n + 1);
      try {
        return await dispatch(action);
      } finally {
        setPending((n) => n - 1);
      }
    },
    [dispatch],
  );
  const sendRef = useRef(send);
  sendRef.current = send;
  const busyRef = useRef(busy);
  busyRef.current = busy;

  // Keyboard shortcuts for the common judging actions.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.repeat) return;
      if (isEditableTarget(e.target)) return;
      const hot = HOTKEYS.find((h) => h.key === e.key.toLowerCase());
      if (!hot) return;
      if (busyRef.current) {
        e.preventDefault();
        return;
      }
      const type = hot.candidates.find((c) => allowedRef.current.has(c));
      if (!type) return;
      e.preventDefault();
      void sendRef.current({ type } as AdminAction);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="adm-page">
      <Toast message={lastError ? lastError.message : null} onClose={clearLastError} />
      {error && <Notice tone="bad">{error}</Notice>}
      {!loaded && !error && <Notice>Loading game state…</Notice>}
      <div className="adm-grid" style={{ marginTop: error || !loaded ? 12 : 0 }}>
        <div className="adm-col">
          {/* Mounted only once the state is known so the panel's collapsed default reflects whether a game exists. */}
          {loaded && <NewGamePanel state={state} packs={packs} dispatch={send} busy={busy} allowed={allowed} />}
          {loaded && !state && <Notice>No game yet. Pick a pack and start one above; the monitor shows the lobby once it exists.</Notice>}
          {state && <StatusBar state={state} dispatch={send} busy={busy} allowed={allowed} />}
          {state && <ShowCues state={state} dispatch={send} busy={busy} allowed={allowed} />}
          {state && <RoundControls state={state} dispatch={send} busy={busy} allowed={allowed} />}
        </div>
        <div className="adm-col">
          {state && <HostView state={state} />}
          <ActionLog log={log} />
        </div>
      </div>
    </div>
  );
}

export default GameControl;
