import { useEffect, useState, type FormEvent } from 'react';
import { DEFAULT_TEAM_IDS, DEFAULT_TEAM_NAMES, TEAM_COLOUR_LABELS, type TeamId } from '@only-connect/shared';
import { Background, teamToneStyle } from '../../components';
import './Button.css';

export interface JoinFormProps {
  initialName?: string;
  initialTeam?: TeamId | null;
  /**
   * The teams playing this game (`PublicGameState.activeTeams`, 2..4, creation order): only these get a
   * button. Defaults to pink and blue while no game is loaded.
   */
  teams?: readonly TeamId[];
  /** Team display names from the game state (defaults while no game is loaded). */
  teamNames?: Partial<Record<TeamId, string>>;
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
  teams = DEFAULT_TEAM_IDS,
  teamNames = {},
  busy = false,
  error = null,
  connected = true,
  onJoin,
}: JoinFormProps) {
  const [name, setName] = useState(initialName);
  const [team, setTeam] = useState<TeamId | null>(initialTeam !== null && teams.includes(initialTeam) ? initialTeam : null);
  const [touched, setTouched] = useState(false);

  // The game can change under the form (a new game with other teams): a pick that is no longer playing is
  // dropped rather than submitted into a `team_inactive` error.
  useEffect(() => {
    if (team !== null && !teams.includes(team)) setTeam(null);
  }, [team, teams]);

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
            <div className="join__teams" role="radiogroup" aria-label="team" data-count={teams.length}>
              {teams.map((id) => (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={team === id}
                  className={`join__team join__team--${id}${team === id ? ' is-selected' : ''}`}
                  style={teamToneStyle(id)}
                  onClick={() => setTeam(id)}
                  disabled={busy}
                >
                  <span className="join__team-colour">{TEAM_COLOUR_LABELS[id]}</span>
                  <span className="join__team-name">{teamNames[id] ?? DEFAULT_TEAM_NAMES[id]}</span>
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
