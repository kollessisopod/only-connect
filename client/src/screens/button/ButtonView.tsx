import { useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { otherTeam, type PublicGameState, type PublicStateMessage, type TeamId } from '@only-connect/shared';
import { AnswerBar, Background, TeamBar } from '../../components';
import './Button.css';

export interface ButtonPlayer {
  playerId: string;
  name: string;
  team: TeamId;
}

export type BuzzFeedback = { kind: 'won' | 'late' | 'error'; text: string };

export interface ButtonViewProps {
  state: PublicStateMessage | null;
  player: ButtonPlayer;
  connected?: boolean;
  /** True while the join handshake is in flight (after a reload / reconnect). */
  joining?: boolean;
  /** True while a buzz ack is pending or during the 300 ms post-press cooldown. */
  buzzing?: boolean;
  /** Outcome of the player's last press, shown until the clue moves on. */
  feedback?: BuzzFeedback | null;
  onBuzz: () => void;
  onLeave: () => void;
  /** Shown when the server no longer lists this player (e.g. removed by the host). */
  onRejoin?: () => void;
}

type Tone = 'neutral' | 'live' | 'good' | 'bad' | 'pink' | 'blue';

export interface BuzzerStatus {
  /** Whether this player may buzz right now. */
  enabled: boolean;
  title: string;
  detail: string | null;
  tone: Tone;
}

/** Short description of what the monitor is showing when Missing Vowels is not on. */
export function describePublicPhase(game: PublicGameState): string {
  const name = (t: TeamId) => game.teams[t].name;
  switch (game.phase) {
    case 'lobby':
      return 'Everyone is in the lobby';
    case 'connections':
    case 'sequences': {
      const round = game.phase === 'connections' ? 'Round 1 — Connections' : 'Round 2 — Sequences';
      const q = game.question;
      if (!q) return round;
      if (q.stage === 'selecting') return `${round}: ${name(q.team)} to pick`;
      if (q.stage === 'steal') return `${round}: ${name(otherTeam(q.team))} may steal`;
      if (q.stage === 'answer') return `${round}: answer shown`;
      return `${round}: ${name(q.team)} answering`;
    }
    case 'wall': {
      const play = game.wall?.current;
      if (!play) return 'Round 3 — Connecting Wall';
      return `Round 3 — Connecting Wall: ${name(play.team)}`;
    }
    case 'vowels':
      return 'Round 4 — Missing Vowels';
    case 'final':
      return 'Final scores are up';
    default:
      return '';
  }
}

/** Derives the buzzer's enabled state and status line from the public state. Exported for the fixtures. */
export function buzzerStatus(state: PublicStateMessage | null, player: ButtonPlayer, connected = true): BuzzerStatus {
  if (!connected) return { enabled: false, title: 'Reconnecting…', detail: 'Hold on, the buzzer will come back', tone: 'neutral' };
  if (state === null) return { enabled: false, title: 'Connecting…', detail: null, tone: 'neutral' };
  if (state.phase === 'none') {
    return { enabled: false, title: "Missing Vowels hasn't started yet", detail: 'No game is running', tone: 'neutral' };
  }
  const game = state;
  const vowels = game.phase === 'vowels' ? game.vowels : null;
  if (!vowels) {
    if (game.phase === 'final') {
      const pink = game.teams.pink.score;
      const blue = game.teams.blue.score;
      const mine = game.teams[player.team].score;
      const theirs = game.teams[otherTeam(player.team)].score;
      const outcome = pink === blue ? "It's a draw" : mine > theirs ? 'Your team won!' : `${game.teams[otherTeam(player.team)].name} won`;
      return { enabled: false, title: 'Game over — thanks for playing', detail: outcome, tone: pink === blue ? 'neutral' : mine > theirs ? 'good' : 'neutral' };
    }
    // The clue area already names the current round (describePublicPhase); keep the status line distinct.
    return { enabled: false, title: "Missing Vowels hasn't started yet", detail: 'Keep this page open — the buzzer wakes up in Round 4', tone: 'neutral' };
  }
  const teamName = (t: TeamId) => game.teams[t].name;
  const buzz = vowels.buzz;
  const mine = buzz !== null && buzz.playerId === player.playerId;
  const buzzerLine = buzz ? `${buzz.playerName} (${teamName(buzz.team)}) buzzed first` : null;

  switch (vowels.stage) {
    case 'category':
      return { enabled: false, title: 'Waiting for the next clue', detail: 'Get your finger ready', tone: 'neutral' };
    case 'clue':
      if (vowels.lockedPlayers.includes(player.playerId)) {
        return { enabled: false, title: 'You already buzzed on this clue', detail: 'Buzzers are open for everyone else', tone: 'bad' };
      }
      return { enabled: true, title: 'Buzzers are open', detail: 'First buzz wins', tone: 'live' };
    case 'buzzed':
      if (mine) return { enabled: false, title: 'You buzzed first!', detail: 'Give your answer', tone: 'good' };
      return {
        enabled: false,
        title: buzz ? `${buzz.playerName} buzzed first` : 'Someone buzzed first',
        detail: buzz ? teamName(buzz.team) : null,
        tone: buzz ? buzz.team : 'neutral',
      };
    case 'other': {
      const other = buzz ? otherTeam(buzz.team) : null;
      const mayAnswer = other !== null && other === player.team ? 'Your team may answer — no buzz needed' : other ? `${teamName(other)} may answer` : null;
      if (mine) return { enabled: false, title: 'Wrong', detail: mayAnswer, tone: 'bad' };
      return { enabled: false, title: 'Buzzers are closed', detail: buzzerLine ? `${buzzerLine} — wrong. ${mayAnswer ?? ''}`.trim() : mayAnswer, tone: 'neutral' };
    }
    case 'answer': {
      const result = vowels.result;
      const winner = result?.team ?? null;
      if (mine) {
        const correct = winner !== null && winner === player.team;
        return { enabled: false, title: correct ? 'Correct!' : 'Wrong', detail: correct ? `+1 for ${teamName(player.team)}` : buzz ? `${teamName(otherTeam(buzz.team))} ${winner ? 'got it' : 'missed it too'}` : null, tone: correct ? 'good' : 'bad' };
      }
      if (winner !== null) {
        return { enabled: false, title: `${teamName(winner)} got it`, detail: buzzerLine, tone: winner === player.team ? 'good' : 'neutral' };
      }
      return { enabled: false, title: buzz ? 'Nobody got it' : 'Nobody buzzed', detail: buzzerLine, tone: 'neutral' };
    }
    default:
      return { enabled: false, title: 'Buzzers are closed', detail: null, tone: 'neutral' };
  }
}

/** Phone buzzer: team + player header, the clue, a giant round button and a status line. */
export function ButtonView({
  state,
  player,
  connected = true,
  joining = false,
  buzzing = false,
  feedback = null,
  onBuzz,
  onLeave,
  onRejoin,
}: ButtonViewProps) {
  const game: PublicGameState | null = state && state.phase !== 'none' ? state : null;
  const team = game?.teams[player.team] ?? null;
  const vowels = game?.phase === 'vowels' ? game.vowels : null;
  const status = joining
    ? ({ enabled: false, title: 'Joining…', detail: null, tone: 'neutral' } satisfies BuzzerStatus)
    : buzzerStatus(state, player, connected);
  const enabled = status.enabled && !buzzing && !joining;
  const missing = game !== null && !joining && !game.players.some((p) => p.id === player.playerId);
  const toneClass = feedback ? (feedback.kind === 'won' ? 'good' : feedback.kind === 'late' ? 'bad' : 'neutral') : status.tone;

  // Buzz on pointer-down (a click would wait for the finger to lift, and first buzz wins). The click path
  // remains for keyboards; it is suppressed right after a pointer press so one tap never buzzes twice.
  const suppressClickUntil = useRef(0);
  const onPointerDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (!enabled) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    suppressClickUntil.current = performance.now() + 700;
    onBuzz();
  };
  const onClick = () => {
    if (!enabled || performance.now() < suppressClickUntil.current) return;
    onBuzz();
  };

  return (
    <div className={`screen buzzer buzzer--${player.team}`} data-enabled={enabled || undefined}>
      <Background variant={player.team === 'pink' ? 'purple' : 'blue'}>
        <div className="buzzer__layout">
          <header className="buzzer__top">
            <div className={`buzzer__teamchip buzzer__teamchip--${player.team}`}>
              <span className="buzzer__teamname">{team?.name ?? (player.team === 'pink' ? 'Pink team' : 'Blue team')}</span>
              <span className="buzzer__score" aria-label="score">
                {team ? team.score : '–'}
              </span>
            </div>
            <div className="buzzer__player">
              <span className="buzzer__playername">{player.name}</span>
              <button type="button" className="buzzer__leave" onClick={onLeave}>
                Leave
              </button>
            </div>
          </header>

          {missing && onRejoin && (
            <div className="buzzer__missing" role="status">
              You are not in the game.{' '}
              <button type="button" className="buzzer__rejoin" onClick={onRejoin}>
                Rejoin
              </button>
            </div>
          )}

          <section className="buzzer__clue" aria-live="polite">
            {vowels ? (
              <>
                <TeamBar size="sm" className="buzzer__category">
                  {vowels.category || 'Missing Vowels'}
                  <span className="buzzer__counter">
                    {' '}
                    {vowels.groupNumber}/{vowels.groupCount}
                  </span>
                </TeamBar>
                {(vowels.answer ?? vowels.display) !== null ? (
                  <AnswerBar className={`buzzer__answer${vowels.answer !== null ? ' is-answer' : ''}`} spaced={vowels.answer === null}>
                    {vowels.answer ?? vowels.display}
                  </AnswerBar>
                ) : (
                  <div className="buzzer__answer-empty">
                    clue {vowels.clueNumber} of {vowels.clueCount} coming up
                  </div>
                )}
              </>
            ) : (
              <div className="buzzer__clue-placeholder">{game ? describePublicPhase(game) : ''}</div>
            )}
          </section>

          <main className="buzzer__main">
            <button
              type="button"
              className={`buzzer__button buzzer__button--${player.team}${enabled ? ' is-live' : ''}`}
              disabled={!enabled}
              aria-disabled={!enabled}
              onPointerDown={enabled ? onPointerDown : undefined}
              onClick={enabled ? onClick : undefined}
            >
              <span className="buzzer__button-label">Buzz</span>
            </button>
          </main>

          <footer className={`buzzer__status buzzer__status--${toneClass}`} role="status" aria-live="assertive">
            {feedback ? (
              <>
                <div className="buzzer__status-title">{feedback.text}</div>
                <div className="buzzer__status-detail">{status.title !== feedback.text ? status.title : status.detail}</div>
              </>
            ) : (
              <>
                <div className="buzzer__status-title">{status.title}</div>
                <div className="buzzer__status-detail">{status.detail ?? ' '}</div>
              </>
            )}
          </footer>
        </div>
      </Background>
    </div>
  );
}

export default ButtonView;
