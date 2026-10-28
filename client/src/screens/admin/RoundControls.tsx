import { useEffect, useState, type ReactNode } from 'react';
import {
  CLUE_POINTS,
  HIEROGLYPH_LABELS,
  QUESTION_SECONDS,
  WALL_GROUP_COLOURS,
  WALL_SECONDS,
  canGoFinal,
  canStartRound,
  currentVowelClue,
  currentVowelGroup,
  isLastVowelClue,
  isRoundSuspended,
  maxCluesFor,
  activeTeams,
  otherAnswerCandidates,
  questionClockRunning,
  questionClockStarted,
  questionOrder,
  questionSecondsRemaining,
  roundProgress,
  selectableWallHieroglyphs,
  stealCandidates,
  suggestedRoundOrder,
  visibleAudioClues,
  vowelsOrder,
  wallOrder,
  wallSecondsRemaining,
  type AdminAction,
  type GameState,
  type QuestionRoundState,
  type RoundName,
  type TeamId,
  type VowelsRoundState,
  type WallRoundState,
} from '@only-connect/shared';
import { HieroglyphGrid } from '../../components/HieroglyphGrid';
import { useServerNow } from '../../lib/useServerNow';
import { ACTION_LABELS, HOTKEYS, describeOrder, hotkeyFor } from './actions';
import { Button, Chip, InlineConfirm, Panel, formatSeconds, type ButtonTone } from './ui';

export interface RoundControlsProps {
  state: GameState;
  dispatch: (action: AdminAction) => Promise<GameState | null>;
  busy: boolean;
  allowed: ReadonlySet<AdminAction['type']>;
}

const ROUND_TITLES: Record<RoundName, string> = {
  connections: 'Connections',
  sequences: 'Sequences',
  wall: 'Connecting Wall',
  vowels: 'Missing Vowels',
};

function questionById(state: GameState, id: string | null) {
  if (id === null) return null;
  return state.pack.questions.find((q) => q.id === id) ?? null;
}

/** The (resolved) order a saved round state was started with — for a suspended round the host is resuming. */
function savedRoundOrder(state: GameState, round: RoundName, saved: QuestionRoundState | WallRoundState | VowelsRoundState): TeamId[] {
  switch (round) {
    case 'connections':
    case 'sequences':
      return questionOrder(state, saved as QuestionRoundState);
    case 'wall':
      return wallOrder(state, saved as WallRoundState);
    default:
      return vowelsOrder(state, saved as VowelsRoundState);
  }
}

/** "Order: A → B → C" with the team whose turn it is in bold. */
function OrderChip({ state, order, current, display = false }: { state: GameState; order: readonly TeamId[]; current?: TeamId; display?: boolean }) {
  return (
    <Chip tone="muted" title={display ? 'display order of the teams (the buzzers decide who answers)' : 'turn order of this round'}>
      Order:{' '}
      {order.map((t, i) => (
        <span key={t}>
          {i > 0 ? ' → ' : ''}
          {t === current ? <strong>{state.teams[t].name}</strong> : state.teams[t].name}
        </span>
      ))}
    </Chip>
  );
}

// ---------------------------------------------------------------------------
// Round order picker (V3.2): opened by a round button; the host queues the teams, then starts the round
// ---------------------------------------------------------------------------

function OrderPicker({
  state,
  round,
  busy,
  onStart,
  onCancel,
}: {
  state: GameState;
  round: RoundName;
  busy: boolean;
  /** Sends `round:start` (with the chosen order unless the round is resumed). */
  onStart: (order: TeamId[] | undefined) => void;
  onCancel: () => void;
}) {
  const paused = isRoundSuspended(state, round);
  const saved = state.suspended?.[round];
  // The engine's default: lowest score first, ties keeping the previous round's order. The host edits a copy;
  // "Suggested" puts it back (useful after an undo changed the scores while the picker was open).
  const suggested = suggestedRoundOrder(state);
  const [order, setOrder] = useState<TeamId[]>(suggested);
  const name = (t: TeamId) => state.teams[t].name;
  const score = (t: TeamId) => state.teams[t].score;
  const title = ROUND_TITLES[round];
  const verb = paused ? 'Resume' : 'Start';
  const isSuggested = order.length === suggested.length && order.every((t, i) => t === suggested[i]);
  const progress = roundProgress(state);

  const move = (index: number, by: -1 | 1) => {
    setOrder((o) => {
      const next = [...o];
      const target = index + by;
      if (target < 0 || target >= next.length) return o;
      [next[index], next[target]] = [next[target] as TeamId, next[index] as TeamId];
      return next;
    });
  };

  const start = () => onStart(paused ? undefined : order);
  const note =
    round === 'vowels'
      ? 'Missing Vowels is a buzzer round: this only sets the order the teams are shown in. Whoever buzzes answers.'
      : round === 'wall'
        ? 'The first team chooses and plays the first wall, then the next in the order; every team plays the same number of walls.'
        : 'Question 1 goes to the first team, question 2 to the next, and so on round the order.';

  return (
    <div className="adm-order" role="group" aria-label={`${verb} ${title}`} data-testid="round-order-picker" data-round={round}>
      <div className="adm-order__head">
        <h4>{paused ? `Resume ${title}` : `Order for ${title}`}</h4>
        {!paused && (
          <Button size="sm" tone="ghost" disabled={isSuggested || busy} onClick={() => setOrder(suggested)} title="lowest score first; ties keep the previous round's order">
            Suggested order
          </Button>
        )}
      </div>
      {paused && saved ? (
        <div className="adm-small adm-muted" data-testid="order-resume">
          Resumes where it was left, with its order: <strong>{describeOrder(savedRoundOrder(state, round, saved), name)}</strong>.
        </div>
      ) : (
        <>
          <ol className="adm-order__list" aria-label="team order">
            {order.map((t, i) => (
              <li key={t} className={`adm-order__row is-${t}`} data-team={t} data-testid={`order-row-${t}`}>
                <span className="adm-order__n" aria-label={`position ${i + 1}`}>
                  {i + 1}
                </span>
                <span className="adm-order__name">
                  <Chip tone={t}>{name(t)}</Chip>
                </span>
                <span className="adm-order__score">
                  {score(t)} pt{score(t) === 1 ? '' : 's'}
                </span>
                <span className="adm-order__moves">
                  <Button size="sm" aria-label={`move ${name(t)} up`} data-testid={`order-up-${t}`} title="earlier" disabled={i === 0 || busy} onClick={() => move(i, -1)}>
                    ▲
                  </Button>
                  <Button size="sm" aria-label={`move ${name(t)} down`} data-testid={`order-down-${t}`} title="later" disabled={i === order.length - 1 || busy} onClick={() => move(i, 1)}>
                    ▼
                  </Button>
                </span>
              </li>
            ))}
          </ol>
          <div className="adm-small adm-muted">
            Default: the team with the lowest score goes first (ties keep the previous round's order). {note}
          </div>
        </>
      )}
      {progress !== null ? (
        // Another round is under way: starting this one leaves it (it can be resumed later), so ask first.
        <InlineConfirm
          text={`${ROUND_TITLES[state.phase as RoundName] ?? 'This round'} is under way (${progress}). Leave it and ${verb.toLowerCase()} ${title}? You can come back to it later.`}
          confirmLabel={`${verb} ${title}`}
          confirmTestId="order-start"
          busy={busy}
          onConfirm={start}
          onCancel={onCancel}
        />
      ) : (
        <div className="adm-order__foot">
          <Button tone="primary" disabled={busy} onClick={start} data-testid="order-start">
            {verb} {title}
          </Button>
          <Button tone="ghost" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
          {!paused && <span className="adm-small adm-faint">{describeOrder(order, name)}</span>}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section wrapper: expanded when active, collapsed (but openable) otherwise
// ---------------------------------------------------------------------------

function Section({
  title,
  active,
  status,
  children,
}: {
  title: string;
  active: boolean;
  status?: ReactNode;
  children: ReactNode;
}) {
  const [override, setOverride] = useState<boolean | null>(null);
  // A manual open/close applies until the phase changes; the live section then follows `active` again.
  useEffect(() => setOverride(null), [active]);
  const open = override ?? active;
  const classes = ['adm-section', active ? 'is-active' : 'is-inactive', open ? '' : 'is-collapsed'].filter(Boolean).join(' ');
  return (
    <div className={classes}>
      <div
        className="adm-section__head"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOverride(open ? false : true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setOverride(open ? false : true);
          }
        }}
      >
        <h3>
          {title}
          {active ? <Chip tone="good">live</Chip> : status ? <Chip tone="muted">{status}</Chip> : null}
        </h3>
        <span className="adm-small adm-muted">{open ? '▾' : '▸'}</span>
      </div>
      <div className="adm-section__body">{children}</div>
    </div>
  );
}

/** Button bound to a parameterless action, enabled by `allowedActions` (module level so it never remounts). */
function ActionButton({
  type,
  tone,
  children,
  can,
  send,
  title,
}: {
  type: AdminAction['type'];
  tone?: ButtonTone;
  children?: ReactNode;
  can: (t: AdminAction['type']) => boolean;
  send: (a: AdminAction) => void;
  /** Tooltip, e.g. the reason the button is disabled right now. */
  title?: string;
}) {
  return (
    <Button tone={tone} hotkey={hotkeyFor(type)} disabled={!can(type)} onClick={() => send({ type } as AdminAction)} title={title}>
      {children ?? ACTION_LABELS[type]}
    </Button>
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function RoundControls({ state, dispatch, busy, allowed }: RoundControlsProps) {
  const can = (t: AdminAction['type']) => allowed.has(t) && !busy;
  const send = (action: AdminAction) => void dispatch(action);
  const name = (t: TeamId) => state.teams[t].name;
  const active = activeTeams(state);
  /**
   * The round whose order picker is open. A round button opens it (or closes it again); the picker sends
   * `round:start` with the queued order. It closes itself when the phase changes and is dropped when the
   * round can no longer be started (e.g. an undo finished it).
   */
  const [picking, setPicking] = useState<RoundName | null>(null);
  useEffect(() => setPicking(null), [state.phase]);
  const picker = picking !== null && canStartRound(state, picking) ? picking : null;

  const finished = state.finishedRounds ?? [];
  const phaseIsQuestion = state.phase === 'connections' || state.phase === 'sequences';
  const vsLive = state.phase === 'vowels' ? state.vowels : null;
  const otherCandidates = vsLive && vsLive.stage === 'other' ? otherAnswerCandidates(state, vsLive) : [];

  return (
    <Panel
      title="Round controls"
      tools={
        <div className="adm-row" style={{ gap: 12 }}>
          <Button
            size="sm"
            tone="warn"
            hotkey={hotkeyFor('game:undo')}
            disabled={!can('game:undo')}
            aria-label="Undo last action"
            title={state.undoable ? `Undo ${ACTION_LABELS[state.undoable].toLowerCase()}` : 'Nothing to undo'}
            onClick={() => send({ type: 'game:undo' })}
          >
            Undo{state.undoable ? `: ${ACTION_LABELS[state.undoable]}` : ''}
          </Button>
          <div className="adm-keys" aria-label="keyboard shortcuts">
            {HOTKEYS.map((h) => (
              <span key={h.key}>
                <span className="adm-btn__key">{h.label}</span>
                {h.candidates
                  .map((c) => ACTION_LABELS[c])
                  .filter((v, i, arr) => arr.indexOf(v) === i)
                  .slice(0, 2)
                  .join(' / ')}
              </span>
            ))}
          </div>
        </div>
      }
    >
      <div className="adm-controls">
        {/* ---- rounds ---- */}
        <div>
          <div className="adm-subhead" style={{ marginBottom: 6 }}>
            Rounds
          </div>
          <div className="adm-rounds">
            {(['connections', 'sequences', 'wall', 'vowels'] as const).map((round, i) => {
              const played = finished.includes(round);
              const live = state.phase === round;
              const paused = isRoundSuspended(state, round);
              const enabled = !busy && allowed.has('round:start') && canStartRound(state, round);
              const verb = paused ? 'resume' : 'start';
              return (
                <Button
                  key={round}
                  tone={live ? 'primary' : 'default'}
                  className={[played ? 'is-played' : '', picker === round ? 'is-picking' : ''].filter(Boolean).join(' ') || undefined}
                  disabled={!enabled}
                  aria-expanded={picker === round}
                  onClick={() => setPicking((p) => (p === round ? null : round))}
                  title={played ? 'already played' : live ? 'in progress' : enabled ? `${verb} ${ROUND_TITLES[round]}: choose the team order` : 'not available now'}
                >
                  <span>
                    {i + 1}. {ROUND_TITLES[round]}
                  </span>
                  <small>{played ? 'played' : live ? 'in progress' : enabled ? `${verb}…` : paused ? 'paused' : '—'}</small>
                </Button>
              );
            })}
            <Button
              tone={state.phase === 'final' ? 'primary' : 'default'}
              disabled={!can('round:final') || !canGoFinal(state)}
              onClick={() => send({ type: 'round:final' })}
            >
              <span>Final scores</span>
              <small>{state.phase === 'final' ? 'on screen' : 'show'}</small>
            </Button>
          </div>
          {picker && (
            <OrderPicker
              key={picker}
              state={state}
              round={picker}
              busy={busy}
              onStart={(order) => {
                setPicking(null);
                send(order ? { type: 'round:start', round: picker, order } : { type: 'round:start', round: picker });
              }}
              onCancel={() => setPicking(null)}
            />
          )}
        </div>

        {/* ---- connections / sequences ---- */}
        <Section
          title="Connections & Sequences"
          active={phaseIsQuestion}
          status={finished.includes('connections') && finished.includes('sequences') ? 'both played' : undefined}
        >
          <QuestionControls state={state} send={send} can={can} />
        </Section>

        {/* ---- wall ---- */}
        <Section title="Connecting Wall" active={state.phase === 'wall'} status={finished.includes('wall') ? 'played' : undefined}>
          <WallControls state={state} send={send} can={can} busy={busy} />
        </Section>

        {/* ---- vowels ---- */}
        <Section title="Missing Vowels" active={state.phase === 'vowels'} status={finished.includes('vowels') ? 'played' : undefined}>
          {(() => {
            const vs = state.phase === 'vowels' ? state.vowels : null;
            const group = vs ? currentVowelGroup(state) : null;
            const clue = vs ? currentVowelClue(state) : null;
            return (
              <>
                {vs && group && (
                  <div className="adm-row adm-row--between">
                    <span>
                      <strong>{group.category}</strong> · category {vs.groupIndex + 1}/{state.pack.vowelGroups.length} · clue {vs.clueIndex + 1}/{group.clues.length}
                    </span>
                    <span className="adm-row" style={{ gap: 6 }}>
                      <OrderChip state={state} order={vowelsOrder(state, vs)} display />
                      {vs.stage === 'clue' && <Chip tone="warn">buzzers open</Chip>}
                      {vs.stage === 'buzzed' && vs.buzz && (
                        <Chip tone={vs.buzz.team}>
                          {vs.buzz.playerName} ({name(vs.buzz.team)}) buzzed
                        </Chip>
                      )}
                      {vs.stage === 'other' &&
                        vs.buzz &&
                        otherCandidates.map((t) => (
                          <Chip key={t} tone={t}>
                            {name(t)} may answer
                          </Chip>
                        ))}
                      {vs.stage === 'answer' && <Chip tone="good">answer shown{isLastVowelClue(state) ? ' · last clue' : ''}</Chip>}
                      {vs.stage === 'category' && <Chip tone="muted">category shown</Chip>}
                    </span>
                  </div>
                )}
                {vs && clue && (
                  <div className="adm-judge">
                    <div className="adm-judge__label">On screen: {vs.stage === 'category' ? 'category only' : clue.display}</div>
                    <div className="adm-judge__answer">{clue.answer}</div>
                  </div>
                )}
                {!vs && (
                  <div className="adm-small adm-muted">
                    Start Missing Vowels above. Correct +1, incorrect −1, then {active.length > 2 ? 'another team' : 'the other team'} may answer
                    {active.length > 2 ? ' (click the team that got it)' : ''}.
                  </div>
                )}
                <div className="adm-btngroup">
                  <ActionButton can={can} send={send} type="vowels:showClue" tone="primary" />
                  <ActionButton can={can} send={send} type="vowels:correct" tone="good" />
                  <ActionButton can={can} send={send} type="vowels:incorrect" tone="bad" />
                  {active.length > 2 ? (
                    // Three or four teams: the host names the team that answered after the wrong buzz.
                    (otherCandidates.length > 0 ? otherCandidates : active.filter((t) => t !== vs?.buzz?.team)).map((t) => (
                      <Button
                        key={t}
                        tone="good"
                        disabled={!can('vowels:otherCorrect') || !otherCandidates.includes(t)}
                        onClick={() => send({ type: 'vowels:otherCorrect', team: t })}
                        title="this team answered correctly after the wrong buzz (+1)"
                      >
                        {name(t)} correct
                      </Button>
                    ))
                  ) : (
                    <ActionButton can={can} send={send} type="vowels:otherCorrect" tone="good" />
                  )}
                  <ActionButton can={can} send={send} type="vowels:nobody" />
                </div>
                <div className="adm-btngroup">
                  <ActionButton can={can} send={send} type="vowels:reopen" tone="warn" />
                  <ActionButton can={can} send={send} type="vowels:next" tone="primary" />
                  <ActionButton can={can} send={send} type="vowels:skipCategory" tone="ghost" />
                </div>
              </>
            );
          })()}
        </Section>
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// Connections / Sequences controls (own component so the 40 s countdown re-renders alone)
// ---------------------------------------------------------------------------

/**
 * "0:37" style countdown chip for the question clock; warn tone under 10 s, "Time's up" once it ran out.
 * Between the pick and `startedAt` (V3.1) the monitor is playing the pick-to-question intro and nothing counts
 * yet, so the chip says so instead of a frozen 0:40: the host should wait for the cut before revealing.
 */
function QuestionClockChip({ qs, now }: { qs: NonNullable<GameState['question']>; now: number }) {
  if (qs.stage !== 'question') return null;
  if (qs.timeUp) {
    return (
      <Chip tone="bad" title="the 40 s clock ran out: no more clues, the team must answer">
        Time's up
      </Chip>
    );
  }
  if (!questionClockRunning(qs)) return null;
  if (!questionClockStarted(qs, now)) {
    const startsIn = Math.max(1, Math.ceil(((qs.startedAt ?? now) - now) / 1000));
    return (
      <Chip tone="muted" title={`the monitor is playing the pick intro; the ${QUESTION_SECONDS} s clock starts when it cuts to the question`}>
        intro · clock in {startsIn} s
      </Chip>
    );
  }
  const left = questionSecondsRemaining(qs, now);
  return (
    <Chip tone={left < 10 ? 'warn' : 'default'} title={`${QUESTION_SECONDS} s clock, started after the pick intro`}>
      ⏱ {formatSeconds(left)}
    </Chip>
  );
}

function QuestionControls({
  state,
  send,
  can,
}: {
  state: GameState;
  send: (a: AdminAction) => void;
  can: (t: AdminAction['type']) => boolean;
}) {
  const now = useServerNow();
  const name = (t: TeamId) => state.teams[t].name;
  const phaseIsQuestion = state.phase === 'connections' || state.phase === 'sequences';
  const qs = phaseIsQuestion ? state.question : null;
  const q = qs ? questionById(state, qs.questionId) : null;
  const max = qs ? maxCluesFor(qs.round) : 4;
  // The engine sets revealed = 4 once judged; for the host "3/3" is the honest count in Sequences.
  const shown = qs ? Math.min(qs.revealed, max) : 0;
  const audio = visibleAudioClues(state);
  const timeUp = qs?.stage === 'question' && qs.timeUp === true;
  const active = activeTeams(state);
  const order = qs ? questionOrder(state, qs) : null;
  // Who may steal: the other team (two teams) or every other team in the order (the host names the one).
  const stealers = qs && qs.stage === 'steal' ? stealCandidates(state, qs) : [];
  return (
    <>
      {qs && qs.stage === 'selecting' && (
        <>
          <div className="adm-row adm-row--between">
            <span className="adm-row" style={{ gap: 6 }}>
              <Chip tone={qs.team}>{name(qs.team)}</Chip> to pick · {qs.questionsDone}/{qs.questionsTotal} done
              {order && <OrderChip state={state} order={order} current={qs.team} />}
            </span>
            <span className="adm-small adm-muted">Click the hieroglyph the team chose · the monitor plays the pick intro (~5 s), then the {QUESTION_SECONDS} s clock starts</span>
          </div>
          <HieroglyphGrid
            className={`adm-glyphpick${can('q:select') ? '' : ' is-disabled'}`}
            hieroglyphs={qs.available}
            used={qs.used}
            onPick={(h) => {
              if (can('q:select') && qs.available.includes(h)) send({ type: 'q:select', hieroglyph: h });
            }}
          />
        </>
      )}
      {qs && qs.stage !== 'selecting' && q && (
        <div className="adm-row adm-row--between">
          <span>
            <Chip tone={qs.team}>{name(qs.team)}</Chip> {HIEROGLYPH_LABELS[q.hieroglyph]} · {shown}/{max} clue{shown === 1 ? '' : 's'} shown
          </span>
          <span className="adm-row" style={{ gap: 6 }} data-testid="question-status">
            <QuestionClockChip qs={qs} now={now} />
            {qs.stage === 'question' && <Chip tone="warn">{qs.pointsOnOffer} point{qs.pointsOnOffer === 1 ? '' : 's'} on offer</Chip>}
            {qs.stage === 'steal' &&
              stealers.map((t) => (
                <Chip key={t} tone={t}>
                  {name(t)} may steal for 1
                </Chip>
              ))}
            {qs.stage === 'answer' && (
              <Chip tone="good">
                {qs.result?.winner ? `${name(qs.result.winner)} +${qs.result.points}${qs.result.viaSteal ? ' (steal)' : ''}` : 'no points'}
              </Chip>
            )}
          </span>
        </div>
      )}
      {qs && qs.stage !== 'selecting' && q && (
        <div className="adm-judge">
          <div className="adm-judge__label">Answer</div>
          <div className="adm-judge__answer">{q.answer}</div>
          {q.note && <div className="adm-judge__clues">{q.note}</div>}
        </div>
      )}
      {qs && timeUp && (
        <div className="adm-small adm-muted" data-testid="question-timeup-hint">
          Time is up: no more clues can be revealed; {name(qs.team)} must answer for {qs.pointsOnOffer} point{qs.pointsOnOffer === 1 ? '' : 's'}.
        </div>
      )}
      {qs && order && qs.stage !== 'selecting' && (
        <div className="adm-row">
          <OrderChip state={state} order={order} current={qs.team} />
        </div>
      )}
      {!qs && (
        <div className="adm-small adm-muted">
          Start Connections or Sequences above and queue the teams. Points: {CLUE_POINTS.slice(1).join(' / ')} after 1–4 clues; steal = 1
          {active.length > 2 ? ' (click the team that stole)' : ''}. Each question has a {QUESTION_SECONDS} s clock.
        </div>
      )}
      <div className="adm-btngroup">
        <ActionButton can={can} send={send} type="q:reveal" tone="primary" title={timeUp ? 'time is up: no more clues' : undefined} />
        <ActionButton can={can} send={send} type="q:timeUp" tone="warn" title="end the clock early: no more clues, the team must answer">
          Time up
        </ActionButton>
        <ActionButton can={can} send={send} type="q:correct" tone="good" />
        <ActionButton can={can} send={send} type="q:incorrect" tone="bad" />
      </div>
      <div className="adm-btngroup" data-testid="steal-buttons">
        {active.length > 2 ? (
          // Three or four teams: one button per team that may steal; the host names the one that got it.
          <>
            {(stealers.length > 0 ? stealers : active.filter((t) => t !== qs?.team)).map((t) => (
              <Button
                key={t}
                tone="good"
                disabled={!can('q:stealCorrect') || !stealers.includes(t)}
                onClick={() => send({ type: 'q:stealCorrect', team: t })}
                title="this team stole the answer (+1)"
              >
                {name(t)} stole it
              </Button>
            ))}
            <ActionButton can={can} send={send} type="q:stealIncorrect" tone="bad">
              Nobody stole
            </ActionButton>
          </>
        ) : (
          <>
            <ActionButton can={can} send={send} type="q:stealCorrect" tone="good" />
            <ActionButton can={can} send={send} type="q:stealIncorrect" tone="bad" />
          </>
        )}
        <ActionButton can={can} send={send} type="q:next" tone="primary" />
        <ActionButton can={can} send={send} type="q:void" tone="ghost">
          Void question (broken clue)
        </ActionButton>
      </div>
      <div className="adm-btngroup">
        {audio.length <= 1 && (
          <ActionButton can={can} send={send} type="media:play">
            Play audio again{audio[0] ? ` (${audio[0].clue.text})` : ''}
          </ActionButton>
        )}
        {audio.length > 1 &&
          audio.map(({ index, clue }) => (
            <Button key={index} disabled={!can('media:play')} onClick={() => send({ type: 'media:play', clueIndex: index })} title={clue.text}>
              ♪ Play clue {index + 1}
            </Button>
          ))}
        <ActionButton can={can} send={send} type="media:stop" tone="ghost" />
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Wall controls (own component so the countdown re-renders alone)
// ---------------------------------------------------------------------------

function WallControls({
  state,
  send,
  can,
  busy,
}: {
  state: GameState;
  send: (a: AdminAction) => void;
  can: (t: AdminAction['type']) => boolean;
  busy: boolean;
}) {
  const now = useServerNow();
  const round = state.phase === 'wall' ? state.wall : null;
  const play = round?.current ?? null;
  const name = (t: TeamId) => state.teams[t].name;
  const [confirm, setConfirm] = useState<'timeUp' | 'abort' | null>(null);
  useEffect(() => setConfirm(null), [play?.stage, play?.team]);

  // The engine decides which wall glyphs the choosing team may pick right now (none once a wall is on screen
  // or the round is over).
  const selectable = round ? selectableWallHieroglyphs(state) : [];
  const roundOver = round !== null && round.wallsDone >= round.wallsTotal;
  const wallNumber = round ? Math.min(round.wallsDone + 1, round.wallsTotal) : 0;

  const secondsLeft = play ? wallSecondsRemaining(play, now) : 0;
  const progress = play && play.stage === 'live' ? 1 - secondsLeft / WALL_SECONDS : play && play.stage !== 'ready' ? 1 : 0;

  const current = play && play.stage === 'resolving' && play.resolvingGroup !== null ? play.groups.find((g) => g.solvedOrder === play.resolvingGroup) ?? null : null;
  const wall = play ? state.pack.walls.find((w) => w.id === play.wallId) ?? null : null;
  const glyphLabel = wall ? HIEROGLYPH_LABELS[wall.hieroglyph] : null;

  return (
    <>
      {!round && (
        <div className="adm-small adm-muted">
          Start the Connecting Wall above and queue the teams (the team behind on score first, by default). Each team in turn chooses a wall by its
          hieroglyph and plays it for up to {formatSeconds(WALL_SECONDS)}; every team plays the same number of walls.
        </div>
      )}

      {round && round.stage === 'selecting' && !play && (
        <div className="adm-wallpick" data-testid="wall-picker" data-wall-stage={roundOver ? 'over' : 'selecting'}>
          <div className="adm-row adm-row--between">
            <span className="adm-wallpick__status adm-row" style={{ gap: 6 }}>
              {roundOver ? (
                <>
                  <Chip tone="good">all walls played</Chip> {round.wallsTotal} of {round.wallsTotal} · start the next round above
                </>
              ) : (
                <>
                  <Chip tone={round.team}>{name(round.team)}</Chip> chooses · Wall {wallNumber} of {round.wallsTotal}
                  <OrderChip state={state} order={wallOrder(state, round)} current={round.team} />
                </>
              )}
            </span>
            <span className="adm-small adm-muted">{roundOver ? '' : 'Click the hieroglyph the team chose'}</span>
          </div>
          <HieroglyphGrid
            className={`adm-glyphpick adm-glyphpick--walls adm-glyphpick--walls-${round.available.length > 2 ? 4 : 2}${can('wall:select') && !roundOver ? '' : ' is-disabled'}`}
            hieroglyphs={round.available}
            used={round.used}
            onPick={(h) => {
              if (can('wall:select') && selectable.includes(h)) send({ type: 'wall:select', hieroglyph: h });
            }}
          />
        </div>
      )}

      {round && play && (
        <div className="adm-row adm-row--between adm-wallpick__status">
          <span className="adm-row" style={{ gap: 6 }}>
            <Chip tone={play.team}>{name(play.team)}</Chip> {glyphLabel ? `${glyphLabel} wall` : 'wall'} · Wall {wallNumber} of {round.wallsTotal}
            <OrderChip state={state} order={wallOrder(state, round)} current={play.team} />
          </span>
          <span className="adm-small adm-muted">
            {round.wallsTotal - round.used.length} wall{round.wallsTotal - round.used.length === 1 ? '' : 's'} left to choose after this one
          </span>
        </div>
      )}

      {play && (
        <div className="adm-timer" aria-live="off">
          <span className="adm-timer__clock">{play.stage === 'live' ? formatSeconds(secondsLeft) : play.stage === 'ready' ? formatSeconds(WALL_SECONDS) : '0:00'}</span>
          <div className="adm-timer__bar">
            <div className="adm-timer__fill" style={{ width: `${Math.round(Math.min(1, Math.max(0, progress)) * 100)}%` }} />
          </div>
          <Chip tone={play.team}>{name(play.team)}</Chip>
          <Chip tone="muted">{play.stage}</Chip>
          {play.lives !== null && <Chip tone={play.lives === 0 ? 'bad' : 'warn'}>{play.lives} lives</Chip>}
          <Chip tone="muted">{play.groups.filter((g) => g.foundByTeam).length}/4 found</Chip>
          {play.endReason && <Chip tone="muted">{play.endReason === 'complete' ? 'complete' : play.endReason === 'lives' ? 'out of lives' : "time's up"}</Chip>}
        </div>
      )}

      {current && wall && (
        <div className="adm-judge">
          <div className="adm-judge__label">
            Ask for the connection of group {(play?.resolvingGroup ?? 0) + 1}/4{' '}
            <span style={{ display: 'inline-block', width: 12, height: 12, borderRadius: 3, background: WALL_GROUP_COLOURS[current.solvedOrder ?? 0], verticalAlign: 'middle' }} />
            {current.foundByTeam ? ' (found by the team)' : ' (revealed)'}
          </div>
          <div className="adm-judge__answer">{current.connection}</div>
          <div className="adm-judge__clues">{wall.groups[current.index]?.clues.join(' · ')}</div>
        </div>
      )}

      {play && play.stage === 'ready' && (
        <div className="adm-small adm-muted" data-testid="wall-ready-hint">
          Tiles are hidden from the monitor and the wall panel until you press Start: the monitor keeps the hieroglyph grid with a "get ready" bar and the panel
          shows its "Get ready" screen. Start when the team is at the panel; both show the wall at the same moment.
        </div>
      )}

      {play && play.stage === 'done' && play.awarded && (
        <div className="adm-notice adm-notice--good">
          {name(play.team)} scored {play.awarded.total}: {play.awarded.groups} group{play.awarded.groups === 1 ? '' : 's'} + {play.awarded.connections} connection
          {play.awarded.connections === 1 ? '' : 's'}
          {play.awarded.bonus ? ` + ${play.awarded.bonus} bonus` : ''}.
        </div>
      )}

      {confirm === 'timeUp' && play && (
        <InlineConfirm
          text={`End ${name(play.team)}'s wall now with ${formatSeconds(secondsLeft)} left?`}
          confirmLabel="Time up"
          busy={busy}
          onConfirm={() => {
            setConfirm(null);
            send({ type: 'wall:timeUp' });
          }}
          onCancel={() => setConfirm(null)}
        />
      )}
      {confirm === 'abort' && play && (
        <InlineConfirm
          text={`Take ${name(play.team)}'s ${glyphLabel ?? ''} wall off screen? Nothing is awarded, the hieroglyph becomes available again and ${name(play.team)} chooses again.`}
          confirmLabel="Abort wall"
          busy={busy}
          onConfirm={() => {
            setConfirm(null);
            send({ type: 'wall:abort' });
          }}
          onCancel={() => setConfirm(null)}
        />
      )}
      <div className="adm-btngroup">
        <Button tone="primary" disabled={!can('wall:start')} onClick={() => send({ type: 'wall:start' })} title="reveals the tiles on the monitor and the panel and starts the clock">
          Start wall ({formatSeconds(WALL_SECONDS)})
        </Button>
        <Button tone="warn" disabled={!can('wall:timeUp') || confirm === 'timeUp'} onClick={() => setConfirm('timeUp')}>
          Time up
        </Button>
        <Button tone="primary" disabled={!can('wall:resolve')} onClick={() => send({ type: 'wall:resolve' })}>
          Resolve wall
        </Button>
        <Button tone="ghost" disabled={!can('wall:abort') || confirm === 'abort'} onClick={() => setConfirm('abort')} title="Take the wall off screen without scoring it">
          Abort wall
        </Button>
      </div>
      <div className="adm-btngroup">
        <Button tone="good" hotkey={hotkeyFor('wall:connectionCorrect')} disabled={!can('wall:connectionCorrect')} onClick={() => send({ type: 'wall:connectionCorrect' })}>
          Connection correct
        </Button>
        <Button tone="bad" hotkey={hotkeyFor('wall:connectionIncorrect')} disabled={!can('wall:connectionIncorrect')} onClick={() => send({ type: 'wall:connectionIncorrect' })}>
          Connection incorrect
        </Button>
        <Button tone="primary" disabled={!can('wall:finish')} onClick={() => send({ type: 'wall:finish' })}>
          Finish wall (award points)
        </Button>
        <Button tone="ghost" disabled={!can('wall:clear') || busy} onClick={() => send({ type: 'wall:clear' })}>
          Clear wall
        </Button>
      </div>
    </>
  );
}

export default RoundControls;
