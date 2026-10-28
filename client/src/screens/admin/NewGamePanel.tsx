import { useEffect, useState } from 'react';
import {
  DEFAULT_TEAM_NAMES,
  MAX_TEAMS,
  MIN_TEAMS,
  TEAM_COLOUR_LABELS,
  TEAM_IDS,
  activeTeams,
  isBusy,
  roundProgress,
  type AdminAction,
  type GameState,
  type PackSummary,
  type TeamId,
} from '@only-connect/shared';
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

/** 2, 3, 4: how many teams a game can have (MIN_TEAMS..MAX_TEAMS). */
const TEAM_COUNTS = Array.from({ length: MAX_TEAMS - MIN_TEAMS + 1 }, (_, i) => MIN_TEAMS + i);

function gameInProgress(state: GameState | null): boolean {
  if (!state) return false;
  return state.phase !== 'lobby' || (state.finishedRounds?.length ?? 0) > 0;
}

/** "Nightwearers 5 · Frenemies 3 · Board Gamers 0" — the running game's scores, for the abandon warning. */
function scoreline(state: GameState): string {
  return activeTeams(state)
    .map((t) => `${state.teams[t].name} ${state.teams[t].score}`)
    .join(' · ');
}

export function NewGamePanel({ state, packs, dispatch, busy, allowed }: NewGamePanelProps) {
  const [list, setList] = useState<PackSummary[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [packId, setPackId] = useState('');
  /**
   * How many walls the selected pack holds (`null` until fetched): the pack list does not say, and a game
   * needs at least one wall per team (`game:new` fails with `not_enough_walls` otherwise). Keyed by pack id
   * so a stale fetch for the previous pack never gates the current one.
   */
  const [walls, setWalls] = useState<{ packId: string; count: number } | null>(null);
  const [teamCount, setTeamCount] = useState(MIN_TEAMS);
  const [names, setNames] = useState<Record<TeamId, string>>({ ...DEFAULT_TEAM_NAMES });
  const [confirming, setConfirming] = useState(false);
  const [confirmLobby, setConfirmLobby] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => setConfirmLobby(false), [state?.phase]);
  // Leaving a half-played round is one click: ask first. While a question / wall / buzz is live the engine
  // does not offer game:lobby at all (SPEC §3.6) — the button is disabled and its title says why.
  const lobbyNeedsConfirm = state !== null && roundProgress(state) !== null;
  const lobbyReason = state === null ? '' : roundProgress(state) ?? '';
  const lobbyBlocked = state !== null && state.phase !== 'lobby' && isBusy(state);

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

  useEffect(() => {
    if (!packId) return;
    let alive = true;
    packs
      .get(packId)
      .then((p) => {
        if (alive) setWalls({ packId, count: p.walls.length });
      })
      .catch(() => {
        // Unknown wall count: the server still refuses a game with too few walls, with a clear error.
        if (alive) setWalls(null);
      });
    return () => {
      alive = false;
    };
  }, [packs, packId]);

  const selected = list?.find((p) => p.id === packId) ?? null;
  const unplayable = (list ?? []).filter((p) => !p.playable);
  const teamIds = TEAM_IDS.slice(0, teamCount);
  const wallCount = walls && walls.packId === packId ? walls.count : null;
  const tooFewWalls = wallCount !== null && wallCount < teamCount;
  const canStart = Boolean(selected && selected.playable) && !busy && !tooFewWalls;

  const start = async () => {
    setConfirming(false);
    await dispatch({
      type: 'game:new',
      packId,
      teams: teamIds.map((id) => ({ id, name: names[id].trim() })),
    });
  };

  const onStartClick = () => {
    if (gameInProgress(state)) setConfirming(true);
    else void start();
  };

  const wallsHint =
    wallCount === null
      ? undefined
      : tooFewWalls
        ? `This pack has ${wallCount} wall${wallCount === 1 ? '' : 's'}: at most ${wallCount} teams can play it.`
        : `${wallCount} wall${wallCount === 1 ? '' : 's'} in this pack, ${Math.floor(wallCount / teamCount)} per team.`;

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
            title={lobbyBlocked ? 'finish, void or abort what is being played first' : undefined}
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
          <Field label="Teams" hint={wallsHint} error={tooFewWalls ? wallsHint : undefined}>
            <div className="adm-row" role="radiogroup" aria-label="number of teams" data-testid="team-count">
              {TEAM_COUNTS.map((n) => (
                <label key={n} className={`adm-radio${teamCount === n ? ' is-checked' : ''}`} data-testid={`team-count-${n}`}>
                  <input type="radio" name="adm-team-count" value={n} checked={teamCount === n} onChange={() => setTeamCount(n)} />
                  {n} teams
                </label>
              ))}
            </div>
          </Field>
        </div>
        <div className="adm-form-row" data-testid="team-names">
          {teamIds.map((id) => (
            <Field
              key={id}
              label={
                <>
                  <span className={`adm-swatch is-${id}`} aria-hidden="true" />
                  {TEAM_COLOUR_LABELS[id]} team
                </>
              }
              htmlFor={`adm-new-${id}`}
            >
              <Input
                id={`adm-new-${id}`}
                value={names[id]}
                placeholder={DEFAULT_TEAM_NAMES[id]}
                onChange={(e) => setNames((n) => ({ ...n, [id]: e.target.value }))}
                maxLength={40}
              />
            </Field>
          ))}
        </div>
        <div className="adm-small adm-muted">
          The teams take turns in an order you choose when you start each round (the team furthest behind first, by default). An empty name
          falls back to the colour's default.
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

        {confirming && state ? (
          <InlineConfirm
            text={`A game is in progress (${scoreline(state)}). Starting a new game abandons it.`}
            confirmLabel="Start new game"
            onConfirm={() => void start()}
            onCancel={() => setConfirming(false)}
            busy={busy}
          />
        ) : (
          <div className="adm-row">
            <Button
              tone={gameInProgress(state) ? 'warn' : 'primary'}
              size="lg"
              disabled={!canStart}
              title={tooFewWalls ? wallsHint : undefined}
              onClick={onStartClick}
            >
              {gameInProgress(state) ? 'Start a new game…' : 'Start game'}
            </Button>
            {selected && !selected.playable && <span className="adm-small adm-muted">The selected pack is not playable.</span>}
            {tooFewWalls && <span className="adm-small adm-muted">Fewer teams, or a pack with more walls.</span>}
          </div>
        )}
      </div>
    </Panel>
  );
}

export default NewGamePanel;
