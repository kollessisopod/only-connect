import { useEffect, useState } from 'react';
import { isBusy, roundProgress, type AdminAction, type GameState, type PackSummary, type TeamId } from '@only-connect/shared';
import type { PacksApi } from './types';
import { Button, Field, InlineConfirm, Input, Notice, Panel, Select } from './ui';

export interface NewGamePanelProps {
  state: GameState | null;
  packs: PacksApi;
  dispatch: (action: AdminAction) => Promise<GameState | null>;
  busy: boolean;
  /** Allowed action types right now. */
  allowed: ReadonlySet<AdminAction['type']>;
}

function gameInProgress(state: GameState | null): boolean {
  if (!state) return false;
  return state.phase !== 'lobby' || (state.finishedRounds?.length ?? 0) > 0;
}

export function NewGamePanel({ state, packs, dispatch, busy, allowed }: NewGamePanelProps) {
  const [list, setList] = useState<PackSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [packId, setPackId] = useState('');
  const [pinkName, setPinkName] = useState('Pink Team');
  const [blueName, setBlueName] = useState('Blue Team');
  const [firstTeam, setFirstTeam] = useState<TeamId>('pink');
  const [confirming, setConfirming] = useState(false);
  const [confirmLobby, setConfirmLobby] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => setConfirmLobby(false), [state?.phase]);
  // Leaving a live wall / an unjudged buzz / a half-played round is one click: ask first.
  const lobbyNeedsConfirm = state !== null && (isBusy(state) || roundProgress(state) !== null);
  const lobbyReason = state === null ? '' : isBusy(state) ? 'something is being played right now' : roundProgress(state) ?? '';

  useEffect(() => {
    let alive = true;
    setLoadError(null);
    packs
      .list()
      .then((l) => {
        if (!alive) return;
        setList(l);
        setPackId((current) => {
          if (current && l.some((p) => p.id === current && p.playable)) return current;
          const firstPlayable = l.find((p) => p.playable);
          return firstPlayable ? firstPlayable.id : '';
        });
      })
      .catch((err: unknown) => {
        if (alive) setLoadError(err instanceof Error ? err.message : 'failed to load packs');
      });
    return () => {
      alive = false;
    };
  }, [packs, reloadKey]);

  const selected = list?.find((p) => p.id === packId) ?? null;
  const unplayable = (list ?? []).filter((p) => !p.playable);
  const canStart = Boolean(selected && selected.playable) && !busy && pinkName.trim() !== '' && blueName.trim() !== '';

  const start = async () => {
    setConfirming(false);
    await dispatch({
      type: 'game:new',
      packId,
      teams: { pink: { name: pinkName.trim() || 'Pink Team' }, blue: { name: blueName.trim() || 'Blue Team' } },
      firstTeam,
    });
  };

  const onStartClick = () => {
    if (gameInProgress(state)) setConfirming(true);
    else void start();
  };

  return (
    <Panel
      title="New game"
      collapsible
      defaultCollapsed={state !== null}
      tools={
        confirmLobby ? (
          // Rendered in the header so it is visible even while the panel is collapsed.
          <InlineConfirm
            text={`Back to the lobby? ${lobbyReason}. The round is paused and can be resumed from the Rounds buttons.`}
            confirmLabel="Back to lobby"
            busy={busy}
            onConfirm={() => {
              setConfirmLobby(false);
              void dispatch({ type: 'game:lobby' });
            }}
            onCancel={() => setConfirmLobby(false)}
          />
        ) : (
          <Button
            size="sm"
            tone="ghost"
            disabled={busy || !allowed.has('game:lobby')}
            onClick={() => (lobbyNeedsConfirm ? setConfirmLobby(true) : void dispatch({ type: 'game:lobby' }))}
          >
            Back to lobby
          </Button>
        )
      }
    >
      <div className="adm-stack">
        <div className="adm-form-row">
          <Field
            label="Question pack"
            htmlFor="adm-new-pack"
            hint={list === null && !loadError ? 'Loading packs…' : list && list.length === 0 ? 'No packs yet — create one on the Packs page.' : undefined}
            error={loadError ? `${loadError} ` : undefined}
          >
            <div className="adm-row" style={{ flexWrap: 'nowrap' }}>
              <Select id="adm-new-pack" value={packId} onChange={(e) => setPackId(e.target.value)} disabled={!list || list.length === 0}>
                {(!list || list.length === 0) && <option value="">—</option>}
                {list?.map((p) => (
                  <option key={p.id} value={p.id} disabled={!p.playable} title={p.problems.join('\n')}>
                    {p.name}
                    {p.playable ? '' : ` — unplayable (${p.problems.length} problem${p.problems.length === 1 ? '' : 's'})`}
                  </option>
                ))}
              </Select>
              <Button size="sm" tone="ghost" title="Reload packs" onClick={() => setReloadKey((k) => k + 1)}>
                ↻
              </Button>
            </div>
          </Field>
          <Field label="Pink team" htmlFor="adm-new-pink">
            <Input id="adm-new-pink" value={pinkName} onChange={(e) => setPinkName(e.target.value)} maxLength={40} />
          </Field>
          <Field label="Blue team" htmlFor="adm-new-blue">
            <Input id="adm-new-blue" value={blueName} onChange={(e) => setBlueName(e.target.value)} maxLength={40} />
          </Field>
          <Field label="Picks first">
            <div className="adm-row">
              {(['pink', 'blue'] as const).map((t) => (
                <label key={t} className={`adm-radio is-${t}${firstTeam === t ? ' is-checked' : ''}`}>
                  <input type="radio" name="adm-first-team" value={t} checked={firstTeam === t} onChange={() => setFirstTeam(t)} />
                  {t === 'pink' ? pinkName.trim() || 'Pink' : blueName.trim() || 'Blue'}
                </label>
              ))}
            </div>
          </Field>
        </div>

        {unplayable.length > 0 && (
          <Notice tone="warn">
            {unplayable.length === 1 ? '1 pack is' : `${unplayable.length} packs are`} not playable yet:
            <ul>
              {unplayable.map((p) => (
                <li key={p.id}>
                  <strong>{p.name}</strong>: {p.problems.slice(0, 3).join('; ')}
                  {p.problems.length > 3 ? ` (+${p.problems.length - 3} more)` : ''}
                </li>
              ))}
            </ul>
          </Notice>
        )}

        {confirming ? (
          <InlineConfirm
            text={`A game is in progress (${state?.teams.pink.name} ${state?.teams.pink.score} – ${state?.teams.blue.score} ${state?.teams.blue.name}). Starting a new game abandons it.`}
            confirmLabel="Start new game"
            onConfirm={() => void start()}
            onCancel={() => setConfirming(false)}
            busy={busy}
          />
        ) : (
          <div className="adm-row">
            <Button tone={gameInProgress(state) ? 'warn' : 'primary'} size="lg" disabled={!canStart} onClick={onStartClick}>
              {gameInProgress(state) ? 'Start a new game…' : 'Start game'}
            </Button>
            {selected && !selected.playable && <span className="adm-small adm-muted">The selected pack is not playable.</span>}
          </div>
        )}
      </div>
    </Panel>
  );
}

export default NewGamePanel;
