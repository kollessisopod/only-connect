/**
 * The public monitor, purely presentational: `PublicGameState` + server `now` in, pixels out.
 * Every phase and stage from SPEC §8 is rendered here; MonitorScreen only adds the socket and audio plumbing.
 */
import { memo, useMemo, type CSSProperties, type ReactNode } from 'react';
import {
  QUESTION_MS,
  WALL_SECONDS,
  otherTeam,
  questionSecondsRemaining,
  wallSecondsRemaining,
  type PublicClue,
  type PublicGameState,
  type PublicQuestionRoundState,
  type PublicVowelsRoundState,
  type PublicWallPlay,
  type PublicWallRoundState,
  type TeamId,
} from '@only-connect/shared';
import {
  AnswerBar,
  BACKGROUND_IMAGE,
  Background,
  BigPicture,
  BuzzBanner,
  ClueRow,
  FinalScores,
  HieroglyphGrid,
  ScoreStrip,
  TeamBar,
  VowelBars,
  WallGrid,
  WallLives,
  WallTimer,
  computeWinner,
  wallGroupColour,
  wallProgress,
  type ClueRowClue,
} from '../../components';
import './MonitorView.css';

export interface MonitorViewProps {
  state: PublicGameState;
  /** Server time in ms (from useServerNow) — drives the wall countdown and the 40 s question clock. */
  now: number;
  /** False until the viewer has tapped the "enable sound" overlay; shows a small "sound off" hint. */
  soundEnabled: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The team the screen is "about" right now (controls the background colour and the score highlight). */
function controllingTeam(q: PublicQuestionRoundState): TeamId {
  if (q.stage === 'steal') return otherTeam(q.team);
  if (q.stage === 'answer' && q.result?.winner) return q.result.winner;
  return q.team;
}

function activeTeam(state: PublicGameState): TeamId | null {
  switch (state.phase) {
    case 'connections':
    case 'sequences':
      return state.question ? controllingTeam(state.question) : null;
    case 'wall':
      // The team choosing a wall, then the team playing it; nobody once every wall has been played.
      return state.wall && !wallRoundOver(state.wall) ? state.wall.team : null;
    case 'vowels':
      return state.vowels?.buzz?.team ?? null;
    default:
      return null;
  }
}

function backgroundVariant(state: PublicGameState): 'blue' | 'purple' {
  if ((state.phase === 'connections' || state.phase === 'sequences') && state.question) {
    return controllingTeam(state.question) === 'pink' ? 'purple' : 'blue';
  }
  return 'blue';
}

function layerKey(state: PublicGameState): string {
  switch (state.phase) {
    case 'connections':
    case 'sequences':
      return `${state.phase}:${state.question?.stage ?? ''}:${state.question?.questionsDone ?? 0}`;
    case 'wall': {
      const w = state.wall;
      const play = w?.current;
      return `wall:${w?.used.length ?? 0}:${play ? `${play.team}:${play.stage}` : 'selecting'}`;
    }
    case 'vowels': {
      const v = state.vowels;
      return `vowels:${v ? `${v.groupNumber}:${v.clueNumber}:${v.stage === 'category' ? 'category' : 'clue'}` : ''}`;
    }
    default:
      return state.phase;
  }
}

function roundTag(state: PublicGameState): string | null {
  switch (state.phase) {
    case 'connections':
    case 'sequences': {
      const q = state.question;
      const title = state.phase === 'connections' ? 'Round 1 · Connections' : 'Round 2 · Sequences';
      if (!q) return title;
      // questionsDone counts judged questions; the one on screen (or about to be picked) is the next.
      return `${title} · Question ${Math.min(q.questionsTotal, q.questionsDone + 1)} of ${q.questionsTotal}`;
    }
    case 'wall': {
      const w = state.wall;
      if (!w || wallRoundOver(w)) return 'Round 3 · Connecting Wall';
      return `Round 3 · Connecting Wall · ${wallCaption(w)}`;
    }
    case 'vowels': {
      const v = state.vowels;
      if (!v) return 'Round 4 · Missing Vowels';
      const clue = v.stage === 'category' ? '' : ` · Clue ${v.clueNumber} of ${v.clueCount}`;
      return `Round 4 · Missing Vowels · Category ${v.groupNumber} of ${v.groupCount}${clue}`;
    }
    default:
      return null;
  }
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** True once every wall of the pack has been chosen, played and cleared (stage `selecting`, nothing left). */
export function wallRoundOver(w: PublicWallRoundState): boolean {
  return w.current === null && w.wallsDone >= w.wallsTotal;
}

/** "Wall 2 of 4": the wall on screen, or the one about to be chosen. */
export function wallCaption(w: PublicWallRoundState): string {
  return `Wall ${Math.min(w.wallsTotal, w.wallsDone + 1)} of ${w.wallsTotal}`;
}

function clock(seconds: number): string {
  const s = Math.max(0, seconds);
  return `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Lobby / idle
// ---------------------------------------------------------------------------

function TitleBlock({ children }: { children?: ReactNode }) {
  // With the owner's backdrop image the "Only Connect" logo is already on screen, so the text title is dropped
  // and the content sits in the lower part of the frame, under the logo.
  const hasImage = Boolean(BACKGROUND_IMAGE);
  return (
    <div className={`oc-monitor__lobby${hasImage ? ' oc-monitor__lobby--image' : ''}`}>
      {!hasImage && <h1 className="oc-monitor__title">Only Connect</h1>}
      {children}
    </div>
  );
}

/** Font step for the lobby team chips so a long single word is never broken mid-word. */
export function teamChipFit(name: string): number {
  const longest = name.split(/\s+/).reduce((m, w) => Math.max(m, w.length), 0);
  if (longest <= 12) return 1;
  return Math.max(0.5, 12 / longest);
}

function Lobby({ state }: { state: PublicGameState }) {
  const connected = state.players.filter((p) => p.connected).length;
  const chipStyle = (name: string): CSSProperties | undefined => {
    const fit = teamChipFit(name);
    return fit === 1 ? undefined : ({ '--oc-fit': fit } as CSSProperties);
  };
  return (
    <TitleBlock>
      <div className="oc-monitor__vs">
        <div className="oc-monitor__teamchip oc-monitor__teamchip--pink" style={chipStyle(state.teams.pink.name)}>
          {state.teams.pink.name}
        </div>
        <span className="oc-monitor__vs-sep" aria-label="versus">
          v
        </span>
        <div className="oc-monitor__teamchip oc-monitor__teamchip--blue" style={chipStyle(state.teams.blue.name)}>
          {state.teams.blue.name}
        </div>
      </div>
      <div className="oc-monitor__caption">
        {connected === 0 ? 'No players connected yet' : `${plural(connected, 'player')} connected`}
      </div>
    </TitleBlock>
  );
}

export interface MonitorIdleProps {
  caption: string;
  /** Pulses the caption (e.g. while connecting). Default true. */
  pulse?: boolean;
}

/** Blue "no game" screen: used for `phase: 'none'` and while the first state loads. */
export function MonitorIdle({ caption, pulse = true }: MonitorIdleProps) {
  return (
    <div className="oc-monitor">
      <div className="oc-monitor__bg is-active">
        <Background variant="blue" />
      </div>
      <div className="oc-monitor__layer">
        <TitleBlock>
          <div className={`oc-monitor__caption${pulse ? ' oc-monitor__caption--pulse' : ''}`}>{caption}</div>
        </TitleBlock>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Connections / Sequences
// ---------------------------------------------------------------------------

function withQuestionMark(q: PublicQuestionRoundState): ClueRowClue[] {
  return q.clues.map((c: PublicClue, i): ClueRowClue =>
    q.round === 'sequences' && i === 3 && q.stage !== 'answer' ? { ...c, isQuestionMark: true } : { ...c },
  );
}

/** Who scored, for the host preview and screen readers (the show's frame carries no caption: it is said aloud). */
export function outcomeText(q: PublicQuestionRoundState, state: PublicGameState): string {
  const r = q.result;
  if (!r || !r.winner) return 'No points';
  const name = state.teams[r.winner].name;
  return r.viaSteal ? `Stolen by ${name} · ${plural(r.points, 'point')}` : `${name} · ${plural(r.points, 'point')}`;
}

/**
 * The most recently revealed picture clue (highest revealed index of kind `image` with a url), shown large
 * above the clue row while the question is played (V3, SPEC §3.1). The public state carries no caption before
 * the answer stage, so the alt text is positional. Sequences' hidden 4th tile is never revealed before the
 * answer, so it can never be picked here.
 */
export function latestPicture(q: PublicQuestionRoundState): { url: string; alt: string } | null {
  for (let i = q.clues.length - 1; i >= 0; i -= 1) {
    const c = q.clues[i];
    if (c.revealed && c.kind === 'image' && c.mediaUrl) return { url: c.mediaUrl, alt: c.text ?? `Picture clue ${i + 1}` };
  }
  return null;
}

function BigPictureSlot({ q }: { q: PublicQuestionRoundState }) {
  const picture = latestPicture(q);
  if (!picture) return null;
  return (
    <div className="oc-monitor__bigpic" data-testid="big-image">
      <BigPicture url={picture.url} alt={picture.alt} />
    </div>
  );
}

/**
 * The 40 s question clock under the clue tiles: the show's timer bar (WallTimer, right-anchored, shrinking)
 * with the seconds left at its right end; once the time is up the bar is empty and the label says so.
 * Renders nothing for a question without a clock (states persisted before V3).
 */
function QuestionClockBar({ q, now }: { q: PublicQuestionRoundState; now: number }) {
  if (q.endsAt === null && !q.timeUp) return null;
  const progress = q.timeUp ? 1 : wallProgress(q, now, QUESTION_MS);
  const seconds = questionSecondsRemaining(q, now);
  return (
    <div className={`oc-monitor__qclock${q.timeUp ? ' is-up' : ''}`} data-testid="question-timer" data-time-up={q.timeUp ? 'true' : 'false'}>
      <WallTimer progress={progress} secondsLeft={seconds} className="oc-monitor__qclock-bar" />
      <span className="oc-monitor__qclock-label" aria-hidden="true">
        {q.timeUp ? "Time's up" : clock(seconds)}
      </span>
    </div>
  );
}

/**
 * Stage `question`: the one question screen that depends on the clock, so it is rendered outside StaticPhase.
 * The clue objects are memoised on the question state and ClueTile is memoised, so a 250 ms tick re-renders
 * just the timer bar and its label, never the four tiles or the big picture.
 */
function QuestionLivePhase({ state, q, now }: { state: PublicGameState; q: PublicQuestionRoundState; now: number }) {
  const name = state.teams[controllingTeam(q)].name;
  const clues = useMemo(() => withQuestionMark(q), [q]);
  return (
    <>
      <BigPictureSlot q={q} />
      <div className="oc-monitor__clues">
        <ClueRow
          clues={clues}
          points={q.pointsOnOffer}
          footer={
            <div className="oc-monitor__qfoot">
              <QuestionClockBar q={q} now={now} />
              <TeamBar>{name}</TeamBar>
            </div>
          }
        />
      </div>
    </>
  );
}

/** Stages `selecting`, `steal` and `answer` (no clock): rendered by StaticPhase. */
function QuestionPhase({ state, q }: { state: PublicGameState; q: PublicQuestionRoundState }) {
  const team = controllingTeam(q);
  const name = state.teams[team].name;

  if (q.stage === 'selecting') {
    return (
      <div className="oc-monitor__select">
        <HieroglyphGrid hieroglyphs={q.available} used={q.used} />
        <TeamBar size="sm" className="oc-monitor__choose">
          {name} to choose
        </TeamBar>
      </div>
    );
  }

  if (q.stage === 'answer') {
    const points = q.result?.winner ? q.result.points : null;
    return (
      <>
        <div className="oc-monitor__panel" aria-hidden="true" />
        <div className="oc-monitor__answer">
          <ClueRow clues={withQuestionMark(q)} captions points={points} footer={<TeamBar>{q.answer ?? ''}</TeamBar>} />
          <span className="oc-visually-hidden">{outcomeText(q, state)}</span>
        </div>
      </>
    );
  }

  // steal (and `question` for a state without a clock, which PhaseContent never routes here)
  return (
    <>
      <BigPictureSlot q={q} />
      <div className="oc-monitor__clues">
        <ClueRow
          clues={withQuestionMark(q)}
          points={q.pointsOnOffer}
          footer={<TeamBar>{q.stage === 'steal' ? `${name} to steal` : name}</TeamBar>}
        />
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Connecting Wall
// ---------------------------------------------------------------------------

function wallStatus(play: PublicWallPlay, now: number): { text: string; time: string | null } {
  const found = play.groups.filter((g) => g.foundByTeam).length;
  const groups = `${found} of 4 groups`;
  switch (play.stage) {
    case 'ready':
      return { text: 'Ready', time: clock(WALL_SECONDS) };
    case 'live':
      return { text: groups, time: clock(wallSecondsRemaining(play, now)) };
    case 'frozen':
      return {
        text: `${play.endReason === 'complete' ? 'Wall complete' : play.endReason === 'lives' ? 'No lives left' : "Time's up"} · ${groups}`,
        time: play.endReason === 'time' ? '0:00' : null,
      };
    case 'resolving':
      return { text: `${groups} · what connects them?`, time: null };
    case 'done':
      return { text: groups, time: null };
    default:
      return { text: '', time: null };
  }
}

const WallConnections = memo(function WallConnections({ play }: { play: PublicWallPlay }) {
  const ordered = play.groups
    .filter((g) => g.solvedOrder !== null)
    .sort((a, b) => (a.solvedOrder as number) - (b.solvedOrder as number));
  return (
    <ol className="oc-monitor__conns" aria-label="connections">
      {ordered.map((g) => {
        const order = g.solvedOrder as number;
        const revealed = g.connection !== null;
        const current = !revealed && play.stage === 'resolving' && play.resolvingGroup === order;
        const cls = `oc-monitor__conn ${revealed ? 'is-revealed' : current ? 'is-current' : 'is-pending'}`;
        return (
          <li key={g.index} className={cls} style={{ '--oc-conn': wallGroupColour(order) } as CSSProperties}>
            <span key={revealed ? 'r' : 'p'} className="oc-monitor__conn-text">
              {revealed ? g.connection : current ? 'Connection?' : ''}
            </span>
            {revealed && (
              <span
                className={`oc-monitor__conn-mark ${g.connectionCorrect ? 'is-correct' : 'is-wrong'}`}
                role="img"
                aria-label={g.connectionCorrect ? 'correct' : 'incorrect'}
              >
                {g.connectionCorrect ? '✓' : '✗'}
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
});

/**
 * Elapsed fraction for the timer bar. A frozen wall stays where it stopped: `endedAt` is the server time of
 * the freeze (states persisted before that field existed fall back to the broadcast time).
 */
function timerProgress(play: PublicWallPlay, now: number, serverNow: number): number {
  switch (play.stage) {
    case 'ready':
      return 0;
    case 'live':
      return wallProgress(play, now);
    default:
      return play.endReason === 'time' ? 1 : wallProgress(play, play.endedAt ?? Math.min(now, serverNow));
  }
}

/**
 * Stage `selecting`: the pack's wall glyphs (two or four large tiles, chosen ones dark) and who is choosing.
 * Also a chosen wall that has not started (`current.stage === 'ready'`, V3): nobody may see the tiles before
 * the host starts the clock (the public state sends none), so the board stays up with the chosen glyph dark
 * and a "get ready" bar; `wall:start` puts the tiles on this screen and the /wall panel in the same broadcast.
 * Once every wall has been played the board stays up, all dark, under an "all walls played" bar. Rendered by
 * StaticPhase (memoised), so the 250 ms clock never touches it.
 */
function WallSelecting({ state, w }: { state: PublicGameState; w: PublicWallRoundState }) {
  const ready = w.current?.stage === 'ready' ? w.current : null;
  const caption = ready
    ? `${state.teams[ready.team].name} · get ready`
    : wallRoundOver(w)
      ? 'All walls played'
      : `${state.teams[w.team].name} to choose a wall`;
  return (
    <div className="oc-monitor__select oc-monitor__select--wall">
      <HieroglyphGrid hieroglyphs={w.available} used={w.used} columns={2} className="oc-monitor__wallgrid" />
      <TeamBar size="sm" className={`oc-monitor__choose${ready ? ' oc-monitor__choose--ready' : ''}`}>
        {caption}
      </TeamBar>
    </div>
  );
}

/**
 * A wall in play (`live` onwards; `ready` is drawn by WallSelecting): depends on the clock. The grid (16 tiles)
 * and the connections list are memoised on the play state, so a 250 ms tick re-renders just the status row
 * and the timer bar. `tiles` is empty for a `ready` play; WallGrid simply draws nothing then.
 */
function WallPhase({ state, now }: { state: PublicGameState; now: number }) {
  const w = state.wall;
  const play = w?.current ?? null;
  if (!w || !play) return null;

  const progress = timerProgress(play, now, state.serverNow);
  const status = wallStatus(play, now);
  const resolving = play.stage === 'resolving' || play.stage === 'done';
  const wrongKey = play.lastWrong ? play.lastWrong.join('-') : '';

  return (
    <div className={`oc-monitor__wall oc-monitor__wall--${play.stage}`}>
      <div className="oc-monitor__wall-side">
        <TeamBar size="sm">{state.teams[play.team].name}</TeamBar>
        <div className="oc-monitor__wall-caption">{wallCaption(w)}</div>
        <div className="oc-monitor__wall-status">
          <WallLives lives={play.lives} />
          <span className="oc-monitor__wall-text">{status.text}</span>
          {status.time !== null && <span className="oc-monitor__wall-clock">{status.time}</span>}
        </div>
        {resolving && <WallConnections play={play} />}
        {play.stage === 'done' && play.awarded && (
          <div className="oc-monitor__wall-total">
            +{play.awarded.total}
            <small>{plural(play.awarded.total, 'point')} to {state.teams[play.team].name}</small>
          </div>
        )}
      </div>
      <div className="oc-monitor__wall-main">
        <WallGrid tiles={play.tiles} selected={play.selected} lastWrong={play.lastWrong} wrongKey={wrongKey} />
        <WallTimer progress={progress} secondsLeft={wallSecondsRemaining(play, now)} />
        {play.stage === 'done' && play.awarded && (
          <div className="oc-monitor__award">
            <AnswerBar spaced={false}>
              Groups {play.awarded.groups} · Connections {play.awarded.connections} · Bonus {play.awarded.bonus} ={' '}
              {play.awarded.total}
            </AnswerBar>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Missing Vowels
// ---------------------------------------------------------------------------

function VowelsPhase({ state, v }: { state: PublicGameState; v: PublicVowelsRoundState }) {
  let banner: ReactNode = null;
  if (v.stage === 'buzzed' && v.buzz) {
    banner = (
      <BuzzBanner key={`buzz-${v.buzz.at}`} team={v.buzz.team} playerName={v.buzz.playerName} teamName={state.teams[v.buzz.team].name} />
    );
  } else if (v.stage === 'other' && v.buzz) {
    const other = otherTeam(v.buzz.team);
    banner = (
      <>
        <BuzzBanner key="other" team={other} playerName={state.teams[other].name} caption="to answer" />
        <div className="oc-monitor__vowels-note">
          {v.buzz.playerName} · {state.teams[v.buzz.team].name} · incorrect (−1)
        </div>
      </>
    );
  } else if (v.stage === 'answer') {
    const team = v.result?.team ?? null;
    if (team) {
      const name = v.buzz && v.buzz.team === team ? v.buzz.playerName : state.teams[team].name;
      banner = <BuzzBanner key="answer" team={team} playerName={name} teamName={state.teams[team].name} caption="correct · +1" />;
    } else {
      banner = (
        <TeamBar size="sm" className="oc-monitor__nobody">
          No points
        </TeamBar>
      );
    }
  }

  return (
    <>
      {banner && <div className="oc-monitor__banner">{banner}</div>}
      <VowelBars category={v.category} display={v.display} answer={v.answer} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Final
// ---------------------------------------------------------------------------

function FinalPhase({ state }: { state: PublicGameState }) {
  const winner = computeWinner(state.teams);
  return (
    <>
      <div className="oc-monitor__final-top">
        <h1 className="oc-monitor__title oc-monitor__title--sm">Final scores</h1>
        <div className={`oc-monitor__winner oc-monitor__winner--${winner}`}>
          {winner === 'tie' ? "It's a draw!" : `${state.teams[winner].name} win!`}
        </div>
      </div>
      <div className="oc-monitor__panel" aria-hidden="true" />
      <div className="oc-monitor__final">
        <FinalScores teams={state.teams} winner={winner} />
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------

/**
 * Every screen except a wall in play and a question with its clock running: a pure function of the public
 * state, memoised so the 250 ms clock ticks that drive the countdowns never re-render these trees (hieroglyph
 * grids, clue tiles, vowel bars, final scores).
 */
const StaticPhase = memo(function StaticPhase({ state }: { state: PublicGameState }) {
  switch (state.phase) {
    case 'lobby':
      return <Lobby state={state} />;
    case 'connections':
    case 'sequences':
      return state.question ? <QuestionPhase state={state} q={state.question} /> : <Lobby state={state} />;
    case 'wall':
      return state.wall ? <WallSelecting state={state} w={state.wall} /> : <Lobby state={state} />;
    case 'vowels':
      return state.vowels ? <VowelsPhase state={state} v={state.vowels} /> : <Lobby state={state} />;
    case 'final':
      return <FinalPhase state={state} />;
    default:
      return <Lobby state={state} />;
  }
});

/** Routes the two clock-driven screens (a wall in play, a question with its 40 s clock) around StaticPhase. */
function PhaseContent({ state, now }: { state: PublicGameState; now: number }) {
  if (state.phase === 'wall' && state.wall?.current && state.wall.current.stage !== 'ready') {
    return <WallPhase state={state} now={now} />;
  }
  if ((state.phase === 'connections' || state.phase === 'sequences') && state.question?.stage === 'question') {
    return <QuestionLivePhase state={state} q={state.question} now={now} />;
  }
  return <StaticPhase state={state} />;
}

/** Both backgrounds stay mounted and cross-fade; memoised on the variant so ticks leave the big image alone. */
const MonitorBackground = memo(function MonitorBackground({ variant }: { variant: 'blue' | 'purple' }) {
  return (
    <>
      <div className={`oc-monitor__bg${variant === 'blue' ? ' is-active' : ''}`} aria-hidden="true">
        <Background variant="blue" />
      </div>
      <div className={`oc-monitor__bg${variant === 'purple' ? ' is-active' : ''}`} aria-hidden="true">
        <Background variant="purple" />
      </div>
    </>
  );
});

export function MonitorView({ state, now, soundEnabled }: MonitorViewProps) {
  const variant = backgroundVariant(state);
  const showScores = state.phase !== 'lobby' && state.phase !== 'final';
  const tag = roundTag(state);

  return (
    <div className={`oc-monitor oc-monitor--${state.phase}`} data-version={state.version}>
      <MonitorBackground variant={variant} />

      <div key={layerKey(state)} className="oc-monitor__layer">
        <PhaseContent state={state} now={now} />
      </div>

      {tag && <div className="oc-monitor__tag">{tag}</div>}
      {showScores && (
        <div className="oc-monitor__scores">
          <ScoreStrip teams={state.teams} active={activeTeam(state)} />
        </div>
      )}
      {!soundEnabled && (
        <div className="oc-monitor__muted" role="status">
          Sound off
        </div>
      )}
    </div>
  );
}

export default MonitorView;
