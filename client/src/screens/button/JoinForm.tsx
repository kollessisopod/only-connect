import { useState, type FormEvent } from 'react';
import type { TeamId } from '@only-connect/shared';
import { Background } from '../../components';
import './Button.css';

export interface JoinFormProps {
  initialName?: string;
  initialTeam?: TeamId | null;
  /** Team display names from the game state (defaults while no game is loaded). */
  teamNames?: Record<TeamId, string>;
  busy?: boolean;
  error?: string | null;
  connected?: boolean;
  onJoin: (name: string, team: TeamId) => void;
}

const MAX_NAME = 24;

/** Name + team picker shown until the player has joined. */
export function JoinForm({
  initialName = '',
  initialTeam = null,
  teamNames = { pink: 'Pink team', blue: 'Blue team' },
  busy = false,
  error = null,
  connected = true,
  onJoin,
}: JoinFormProps) {
  const [name, setName] = useState(initialName);
  const [team, setTeam] = useState<TeamId | null>(initialTeam);
  const [touched, setTouched] = useState(false);

  const trimmed = name.trim();
  const canSubmit = trimmed.length > 0 && team !== null && !busy;
  const localError = touched && trimmed.length === 0 ? 'Enter your name' : touched && team === null ? 'Pick a team' : null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setTouched(true);
    if (!canSubmit || team === null) return;
    onJoin(trimmed.slice(0, MAX_NAME), team);
  };

  return (
    <div className="screen buzzer buzzer--join">
      <Background variant="blue">
        <form className="join" onSubmit={submit} noValidate>
          <div className="join__brand">
            <span className="join__kicker">Only Connect</span>
            <h1 className="join__title">Missing Vowels</h1>
            <p className="join__sub">Enter your name and pick your team to get a buzzer.</p>
          </div>

          <label className="join__field">
            <span className="join__label">Your name</span>
            <input
              className="join__input"
              type="text"
              inputMode="text"
              autoComplete="given-name"
              autoCapitalize="words"
              enterKeyHint="go"
              maxLength={MAX_NAME}
              placeholder="e.g. Mia"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => setTouched(true)}
              disabled={busy}
            />
          </label>

          <div className="join__field">
            <span className="join__label">Your team</span>
            <div className="join__teams" role="radiogroup" aria-label="team">
              {(['pink', 'blue'] as const).map((id) => (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={team === id}
                  className={`join__team join__team--${id}${team === id ? ' is-selected' : ''}`}
                  onClick={() => setTeam(id)}
                  disabled={busy}
                >
                  <span className="join__team-colour">{id === 'pink' ? 'Pink' : 'Blue'}</span>
                  <span className="join__team-name">{teamNames[id]}</span>
                </button>
              ))}
            </div>
          </div>

          <button type="submit" className="join__submit" disabled={!canSubmit}>
            {busy ? 'Joining…' : 'Join'}
          </button>

          <div className="join__status" role="status" aria-live="polite">
            {error ?? localError ?? (connected ? '' : 'Connecting to the game…')}
          </div>
        </form>
      </Background>
    </div>
  );
}

export default JoinForm;
