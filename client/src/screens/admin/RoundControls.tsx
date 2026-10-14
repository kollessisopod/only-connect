import { useEffect, useState, type ReactNode } from 'react';
import {
  CLUE_POINTS,
  HIEROGLYPH_LABELS,
  WALL_GROUP_COLOURS,
  WALL_SECONDS,
  canGoFinal,
  canStartRound,
  currentVowelClue,
  currentVowelGroup,
  isLastVowelClue,
  isRoundSuspended,
  maxCluesFor,
  otherTeam,
  roundProgress,
  selectableWallHieroglyphs,
  visibleAudioClues,
  wallSecondsRemaining,
  type AdminAction,
  type GameState,
  type RoundName,
  type TeamId,
} from '@only-connect/shared';
import { HieroglyphGrid } from '../../components/HieroglyphGrid';
import { useServerNow } from '../../lib/useServerNow';
import { ACTION_LABELS, HOTKEYS, hotkeyFor } from './actions';
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
}: {
  type: AdminAction['type'];
  tone?: ButtonTone;
  children?: ReactNode;
  can: (t: AdminAction['type']) => boolean;
  send: (a: AdminAction) => void;
}) {
  return (
    <Button tone={tone} hotkey={hotkeyFor(type)} disabled={!can(type)} onClick={() => send({ type } as AdminAction)}>
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
  /** A round switch that would leave progress behind waits for a confirmation. */
  const [confirmRound, setConfirmRound] = useState<RoundName | null>(null);
  useEffect(() => setConfirmRound(null), [state.phase]);

  const finished = state.finishedRounds ?? [];
  const phaseIsQuestion = state.phase === 'connections' || state.phase === 'sequences';
  const progress = roundProgress(state);

  const startRound = (round: RoundName) => {
    if (progress !== null) setConfirmRound(round);
    else send({ type: 'round:start', round });
  };

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
              const active = state.phase === round;
              const paused = isRoundSuspended(state, round);
              const enabled = !busy && allowed.has('round:start') && canStartRound(state, round);
              const verb = paused ? 'resume' : 'start';
              return (
                <Button
                  key={round}
                  tone={active ? 'primary' : 'default'}
                  className={played ? 'is-played' : undefined}
                  disabled={!enabled}
                  onClick={() => startRound(round)}
                  title={played ? 'already played' : active ? 'in progress' : enabled ? `${verb} ${ROUND_TITLES[round]}` : 'not available now'}
                >
                  <span>
                    {i + 1}. {ROUND_TITLES[round]}
                  </span>
                  <small>{played ? 'played' : active ? 'in progress' : enabled ? verb : paused ? 'paused' : '—'}</small>
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
          {confirmRound && (
            <div style={{ marginTop: 8 }}>
              <InlineConfirm
                text={`${ROUND_TITLES[state.phase as RoundName] ?? 'This round'} is under way (${progress}). Leave it and ${isRoundSuspended(state, confirmRound) ? 'resume' : 'start'} ${ROUND_TITLES[confirmRound]}? You can come back to it later.`}
                confirmLabel={`${isRoundSuspended(state, confirmRound) ? 'Resume' : 'Start'} ${ROUND_TITLES[confirmRound]}`}
                busy={busy}
                onConfirm={() => {
                  const round = confirmRound;
                  setConfirmRound(null);
                  send({ type: 'round:start', round });
                }}
                onCancel={() => setConfirmRound(null)}
              />
            </div>
          )}
        </div>

        {/* ---- connections / sequences ---- */}
        <Section
          title="Connections & Sequences"
          active={phaseIsQuestion}
          status={finished.includes('connections') && finished.includes('sequences') ? 'both played' : undefined}
        >
          {(() => {
            const qs = phaseIsQuestion ? state.question : null;
            const q = qs ? questionById(state, qs.questionId) : null;
            const max = qs ? maxCluesFor(qs.round) : 4;
            // The engine sets revealed = 4 once judged; for the host "3/3" is the honest count in Sequences.
            const shown = qs ? Math.min(qs.revealed, max) : 0;
            const audio = visibleAudioClues(state);
            return (
              <>
                {qs && qs.stage === 'selecting' && (
                  <>
                    <div className="adm-row adm-row--between">
                      <span>
                        <Chip tone={qs.team}>{name(qs.team)}</Chip> to pick · {qs.questionsDone}/{qs.questionsTotal} done
                      </span>
                      <span className="adm-small adm-muted">Click the hieroglyph the team chose</span>
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
                    <span>
                      {qs.stage === 'question' && <Chip tone="warn">{qs.pointsOnOffer} point{qs.pointsOnOffer === 1 ? '' : 's'} on offer</Chip>}
                      {qs.stage === 'steal' && (
                        <Chip tone={otherTeam(qs.team)}>
                          {name(otherTeam(qs.team))} may steal for 1
                        </Chip>
                      )}
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
                {!qs && (
                  <div className="adm-small adm-muted">
                    Start Connections or Sequences above. Points: {CLUE_POINTS.slice(1).join(' / ')} after 1–4 clues; steal = 1.
                  </div>
                )}
                <div className="adm-btngroup">
                  <ActionButton can={can} send={send} type="q:reveal" tone="primary" />
                  <ActionButton can={can} send={send} type="q:correct" tone="good" />
                  <ActionButton can={can} send={send} type="q:incorrect" tone="bad" />
                </div>
                <div className="adm-btngroup">
                  <ActionButton can={can} send={send} type="q:stealCorrect" tone="good" />
                  <ActionButton can={can} send={send} type="q:stealIncorrect" tone="bad" />
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
          })()}
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
                    <span>
                      {vs.stage === 'clue' && <Chip tone="warn">buzzers open</Chip>}
                      {vs.stage === 'buzzed' && vs.buzz && (
                        <Chip tone={vs.buzz.team}>
                          {vs.buzz.playerName} ({name(vs.buzz.team)}) buzzed
                        </Chip>
                      )}
                      {vs.stage === 'other' && vs.buzz && <Chip tone={otherTeam(vs.buzz.team)}>{name(otherTeam(vs.buzz.team))} may answer</Chip>}
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
                {!vs && <div className="adm-small adm-muted">Start Missing Vowels above. Correct +1, incorrect −1, then the other team may answer.</div>}
                <div className="adm-btngroup">
                  <ActionButton can={can} send={send} type="vowels:showClue" tone="primary" />
                  <ActionButton can={can} send={send} type="vowels:correct" tone="good" />
                  <ActionButton can={can} send={send} type="vowels:incorrect" tone="bad" />
                  <ActionButton can={can} send={send} type="vowels:otherCorrect" tone="good" />
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
          Start the Connecting Wall above. The team behind on score chooses a wall by its hieroglyph, plays it for up to 3 minutes, then the other team chooses;
          teams alternate until every wall is played.
        </div>
      )}

      {round && round.stage === 'selecting' && !play && (
        <div className="adm-wallpick" data-testid="wall-picker" data-wall-stage={roundOver ? 'over' : 'selecting'}>
          <div className="adm-row adm-row--between">
            <span className="adm-wallpick__status">
              {roundOver ? (
                <>
                  <Chip tone="good">all walls played</Chip> {round.wallsTotal} of {round.wallsTotal} · start the next round above
                </>
              ) : (
                <>
                  <Chip tone={round.team}>{name(round.team)}</Chip> chooses · Wall {wallNumber} of {round.wallsTotal}
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
          <span>
            <Chip tone={play.team}>{name(play.team)}</Chip> {glyphLabel ? `${glyphLabel} wall` : 'wall'} · Wall {wallNumber} of {round.wallsTotal}
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
        <Button tone="primary" disabled={!can('wall:start')} onClick={() => send({ type: 'wall:start' })}>
          Start wall (3:00)
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
