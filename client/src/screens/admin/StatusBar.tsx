import { useState, type KeyboardEvent } from 'react';
import { describeState } from '@only-connect/shared';
import type { AdminAction, GameState, Player, TeamId } from '@only-connect/shared';
import { Button, Chip, Input, Panel } from './ui';

export interface StatusBarProps {
  state: GameState;
  dispatch: (action: AdminAction) => Promise<GameState | null>;
  busy: boolean;
  allowed: ReadonlySet<AdminAction['type']>;
}

const PHASE_LABEL: Record<GameState['phase'], string> = {
  lobby: 'Lobby',
  connections: 'Round 1 · Connections',
  sequences: 'Round 2 · Sequences',
  wall: 'Round 3 · Connecting Wall',
  vowels: 'Round 4 · Missing Vowels',
  final: 'Final scores',
};

function TeamNameInput({ team, name, disabled, onCommit }: { team: TeamId; name: string; disabled: boolean; onCommit: (name: string) => void }) {
  const [value, setValue] = useState(name);
  const commit = () => {
    const trimmed = value.trim();
    if (trimmed === '' ) {
      setValue(name);
      return;
    }
    if (trimmed !== name) onCommit(trimmed);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      (e.target as HTMLInputElement).blur();
    } else if (e.key === 'Escape') {
      setValue(name);
      (e.target as HTMLInputElement).blur();
    }
  };
  return (
    <Input
      aria-label={`${team} team name`}
      value={value}
      disabled={disabled}
      maxLength={40}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={onKey}
    />
  );
}

export function StatusBar({ state, dispatch, busy, allowed }: StatusBarProps) {
  // Which team the current moment belongs to, with a short label for its score card.
  let inControl: TeamId | null = null;
  let controlLabel = '';
  const qs = state.phase === 'connections' || state.phase === 'sequences' ? state.question : null;
  const play = state.phase === 'wall' ? state.wall?.current ?? null : null;
  const vs = state.phase === 'vowels' ? state.vowels : null;
  if (qs) {
    if (qs.stage === 'steal') {
      inControl = qs.team === 'pink' ? 'blue' : 'pink';
      controlLabel = 'stealing';
    } else if (qs.stage === 'answer') {
      // Once judged, highlight whoever actually scored (the stealing team after a successful steal).
      if (qs.result?.winner) {
        inControl = qs.result.winner;
        controlLabel = qs.result.viaSteal ? `stole ${qs.result.points}` : `scored ${qs.result.points}`;
      }
    } else {
      inControl = qs.team;
      controlLabel = qs.stage === 'selecting' ? 'picking' : 'answering';
    }
  } else if (play) {
    inControl = play.team;
    controlLabel = 'on the wall';
  } else if (vs?.buzz) {
    inControl = vs.stage === 'other' ? (vs.buzz.team === 'pink' ? 'blue' : 'pink') : vs.buzz.team;
    controlLabel = vs.stage === 'other' ? 'may answer' : 'buzzed';
  }
  const byTeam = (team: TeamId): Player[] => state.players.filter((p) => p.team === team);
  const online = state.players.filter((p) => p.connected).length;

  return (
    <Panel
      title={
        <>
          Status <Chip tone="muted">{PHASE_LABEL[state.phase]}</Chip>
        </>
      }
      tools={
        <span className="adm-small adm-muted">
          v{state.version} · {online}/{state.players.length} players online
        </span>
      }
    >
      <div className="adm-status">
        <div>
          <div className="adm-status__describe">{describeState(state)}</div>
          <div className="adm-status__meta">
            <Chip tone="muted">Pack: {state.pack.name}</Chip>
            <Chip tone="muted">First pick: {state.teams[state.firstTeam].name}</Chip>
            {(state.finishedRounds ?? []).length > 0 && <Chip tone="good">Played: {(state.finishedRounds ?? []).join(', ')}</Chip>}
            {state.playMedia && <Chip tone="warn">♪ audio playing</Chip>}
          </div>
        </div>
        <div className="adm-scores">
          {(['pink', 'blue'] as const).map((team) => (
            <div key={team} className={`adm-score adm-score--${team}${inControl === team ? ' is-active' : ''}`}>
              <div className="adm-score__name">
                <TeamNameInput
                  key={state.teams[team].name}
                  team={team}
                  name={state.teams[team].name}
                  disabled={busy || !allowed.has('game:setTeamName')}
                  onCommit={(name) => void dispatch({ type: 'game:setTeamName', team, name })}
                />
                {inControl === team && <Chip tone={team}>{controlLabel}</Chip>}
              </div>
              <div className="adm-score__value" aria-label={`${state.teams[team].name} score`}>
                {state.teams[team].score}
              </div>
              <div className="adm-score__controls">
                <Button
                  size="sm"
                  aria-label={`${state.teams[team].name} minus five`}
                  title="−5"
                  disabled={busy || !allowed.has('game:adjustScore')}
                  onClick={() => void dispatch({ type: 'game:adjustScore', team, delta: -5 })}
                >
                  −5
                </Button>
                <Button
                  size="sm"
                  aria-label={`${state.teams[team].name} minus one`}
                  disabled={busy || !allowed.has('game:adjustScore')}
                  onClick={() => void dispatch({ type: 'game:adjustScore', team, delta: -1 })}
                >
                  −
                </Button>
                <Button
                  size="sm"
                  aria-label={`${state.teams[team].name} plus one`}
                  disabled={busy || !allowed.has('game:adjustScore')}
                  onClick={() => void dispatch({ type: 'game:adjustScore', team, delta: 1 })}
                >
                  +
                </Button>
                <Button
                  size="sm"
                  aria-label={`${state.teams[team].name} plus five`}
                  title="+5"
                  disabled={busy || !allowed.has('game:adjustScore')}
                  onClick={() => void dispatch({ type: 'game:adjustScore', team, delta: 5 })}
                >
                  +5
                </Button>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="adm-players">
        {(['pink', 'blue'] as const).map((team) => {
          const players = byTeam(team);
          return (
            <div key={team}>
              <div className="adm-players__team">
                {state.teams[team].name} · {players.length} player{players.length === 1 ? '' : 's'}
              </div>
              <div className="adm-players__list">
                {players.length === 0 && <span className="adm-small adm-faint">Nobody has joined on /button yet.</span>}
                {players.map((p) => (
                  <span key={p.id} className={`adm-player${p.connected ? '' : ' is-offline'}`} title={p.connected ? 'connected' : 'disconnected'}>
                    <span className="adm-player__dot" />
                    {p.name}
                    <button
                      type="button"
                      className="adm-player__remove"
                      aria-label={`remove ${p.name}`}
                      title="Remove player"
                      disabled={busy || !allowed.has('game:removePlayer')}
                      onClick={() => void dispatch({ type: 'game:removePlayer', playerId: p.id })}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </Panel>
  );
}

export default StatusBar;
