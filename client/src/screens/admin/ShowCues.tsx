/**
 * "Show cues" panel: fires the opening titles music / opening clip on the monitor (`cue:play`) and stops
 * them (`cue:stop`). The monitor does the playing (see MonitorScreen); the admin console only shows which
 * cue is *set*. Nothing reports back when the clip or the music ends on the monitor (the end is local to it),
 * so the chip must not claim a cue is "playing": it names the last cue fired and when.
 */
import { useEffect, useRef, useState } from 'react';
import { CUE_LABELS, CUE_NAMES, type AdminAction, type GameState } from '@only-connect/shared';
import { Button, Chip, Panel } from './ui';

export interface ShowCuesProps {
  state: GameState;
  dispatch: (action: AdminAction) => Promise<GameState | null>;
  busy: boolean;
  allowed: ReadonlySet<AdminAction['type']>;
}

function clockLabel(at: number): string {
  const d = new Date(at);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;
}

export function ShowCues({ state, dispatch, busy, allowed }: ShowCuesProps) {
  const can = (t: AdminAction['type']) => allowed.has(t) && !busy;
  const cue = state.cue ?? null;
  // When the cue was fired, seen from this console: a new nonce is a new press (a reload shows the time it
  // was first seen, which is honest — nobody knows how long ago the host pressed it).
  const seen = useRef<{ nonce: number; at: number } | null>(null);
  const [firedAt, setFiredAt] = useState<number | null>(null);
  useEffect(() => {
    if (!cue) {
      seen.current = null;
      setFiredAt(null);
      return;
    }
    if (seen.current?.nonce !== cue.nonce) {
      seen.current = { nonce: cue.nonce, at: Date.now() };
      setFiredAt(seen.current.at);
    }
  }, [cue]);
  return (
    <Panel
      title="Show cues"
      tools={
        cue ? (
          <Chip tone="good" title={`cue #${cue.nonce} — the monitor stops by itself when the clip or music ends`}>
            cue set: {CUE_LABELS[cue.name]}
            {firedAt !== null ? ` (fired ${clockLabel(firedAt)})` : ''}
          </Chip>
        ) : (
          <Chip tone="muted">no cue</Chip>
        )
      }
    >
      <div className="adm-btngroup" data-testid="show-cues">
        {CUE_NAMES.map((name) => (
          <Button
            key={name}
            tone={cue?.name === name ? 'primary' : 'default'}
            disabled={!can('cue:play')}
            onClick={() => void dispatch({ type: 'cue:play', cue: name })}
            title={cue?.name === name ? 'last cue fired · press again to restart it' : `play ${CUE_LABELS[name].toLowerCase()} on the monitor`}
          >
            ▶ {CUE_LABELS[name]}
          </Button>
        ))}
        <Button tone="ghost" disabled={!can('cue:stop')} onClick={() => void dispatch({ type: 'cue:stop' })} title={cue ? 'stop the cue on the monitor and clear it' : 'no cue set'}>
          ■ Stop
        </Button>
      </div>
      <div className="adm-small adm-muted" style={{ marginTop: 8 }}>
        Plays on the monitor (sound must be enabled there); the monitor stops by itself when the clip or music ends.
      </div>
    </Panel>
  );
}

export default ShowCues;
