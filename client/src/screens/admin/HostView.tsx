import {
  HIEROGLYPH_LABELS,
  WALL_GROUP_COLOURS,
  currentVowelClue,
  currentVowelGroup,
  isClueVisible,
  otherTeam,
  projectPublic,
  type Clue,
  type GameState,
  type PublicGameState,
  type QuestionRoundState,
  type TeamId,
  type WallGroupState,
  type WallPlay,
} from '@only-connect/shared';
import { useServerNow } from '../../lib/useServerNow';
import { Chip, Panel } from './ui';

export interface HostViewProps {
  state: GameState;
}

const KIND_LABEL = { text: 'text', image: 'picture', audio: 'audio' } as const;
const KIND_ICON = { text: '', image: '▣', audio: '♪' } as const;

/** Plain-text summary of what the monitor is showing right now (built from the public projection). */
export function monitorSummary(pub: PublicGameState): string[] {
  const name = (t: TeamId) => pub.teams[t].name;
  const scores = `${name('pink')} ${pub.teams.pink.score} · ${name('blue')} ${pub.teams.blue.score}`;
  switch (pub.phase) {
    case 'lobby':
      return ['ONLY CONNECT title', `${name('pink')} vs ${name('blue')}`, `${pub.players.filter((p) => p.connected).length} players connected`];
    case 'connections':
    case 'sequences': {
      const q = pub.question;
      if (!q) return [pub.phase];
      if (q.stage === 'selecting') {
        return [`Hieroglyph grid (${q.used.length ? `used: ${q.used.map((h) => HIEROGLYPH_LABELS[h]).join(', ')}` : 'none used'})`, `"${name(q.team)} to choose"`, scores];
      }
      const tiles = q.clues.map((c, i) => {
        if (!c.revealed) return pub.phase === 'sequences' && i === 3 ? '[ ? ]' : '[ ■ ]';
        if (c.kind === 'text') return `[ ${c.text ?? ''} ]`;
        return `[ ${c.kind === 'audio' ? '♪' : '▣'}${c.text ? ` ${c.text}` : ''} ]`;
      });
      const lines = [tiles.join(' ')];
      if (q.stage === 'question' || q.stage === 'steal') lines.push(`Badge: ${q.pointsOnOffer} point${q.pointsOnOffer === 1 ? '' : 's'}`);
      lines.push(`Bar: ${q.stage === 'answer' ? q.answer ?? '' : q.stage === 'steal' ? name(otherTeam(q.team)) : name(q.team)}`);
      lines.push(scores);
      return lines;
    }
    case 'wall': {
      const w = pub.wall;
      const play = w?.current;
      if (!w) return ['Connecting Wall', scores];
      if (!play) {
        if (w.wallsDone >= w.wallsTotal) return ['Wall hieroglyph grid (all dark: every wall played)', scores];
        const used = w.used.length ? `used: ${w.used.map((h) => HIEROGLYPH_LABELS[h]).join(', ')}` : 'none used';
        return [`Wall hieroglyph grid: ${w.available.map((h) => HIEROGLYPH_LABELS[h]).join(', ')} (${used})`, `"${name(w.team)} to choose a wall"`, scores];
      }
      const rows: string[] = [];
      for (let r = 0; r < 4; r++) {
        rows.push(
          play.tiles
            .slice(r * 4, r * 4 + 4)
            .map((t) => `${t.colour !== null ? `${t.colour + 1}:` : play.selected.includes(t.id) ? '*' : ''}${t.text}`)
            .join(' | '),
        );
      }
      const lines = [`${name(play.team)} wall (${play.stage})`, ...rows];
      if (play.lives !== null) lines.push(`${play.lives} lives`);
      for (const g of play.groups) if (g.connection) lines.push(`Group ${(g.solvedOrder ?? 0) + 1}: ${g.connection}${g.connectionCorrect === true ? ' ✓' : g.connectionCorrect === false ? ' ✗' : ''}`);
      lines.push(scores);
      return lines;
    }
    case 'vowels': {
      const v = pub.vowels;
      if (!v) return ['Missing Vowels'];
      const lines = [`Category bar: ${v.category}`];
      if (v.answer !== null) lines.push(`Answer bar: ${v.answer}`);
      else if (v.display !== null) lines.push(`Clue bar: ${v.display}`);
      if (v.buzz) lines.push(`Buzz banner: ${v.buzz.playerName} (${name(v.buzz.team)})`);
      lines.push(scores);
      return lines;
    }
    case 'final': {
      const p = pub.teams.pink.score;
      const b = pub.teams.blue.score;
      return [`Final scores: ${scores}`, p === b ? 'Draw' : `Winners: ${p > b ? name('pink') : name('blue')}`];
    }
    default:
      return [];
  }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "2 of 4 clues shown · 3 points on offer" — what the audience can see and what is at stake. */
export function clueCaption(qs: QuestionRoundState, clues: ReadonlyArray<Clue>, teamName: (t: TeamId) => string): string {
  const shown = clues.filter((_, i) => isClueVisible(qs, i)).length;
  const total = qs.round === 'sequences' && qs.stage !== 'answer' ? 3 : clues.length;
  const head = `${shown} of ${total} clue${total === 1 ? '' : 's'} shown`;
  if (qs.stage === 'answer') return `${head} · answer on screen`;
  if (qs.stage === 'steal') return `${head} · ${teamName(otherTeam(qs.team))} may steal for ${plural(qs.pointsOnOffer, 'point')}`;
  return `${head} · ${plural(qs.pointsOnOffer, 'point')} on offer`;
}

/** One mini tile mirroring the monitor: light when the audience can see it, dark navy with a badge when not. */
function MiniClue({ clue, index, visible, isFourthOfSequence }: { clue: Clue; index: number; visible: boolean; isFourthOfSequence: boolean }) {
  const hiddenQm = !visible && isFourthOfSequence;
  const classes = ['adm-minitile', visible ? 'is-shown' : 'is-hidden', hiddenQm ? 'is-qm' : ''].filter(Boolean).join(' ');
  const kindIcon = KIND_ICON[clue.kind];
  const face =
    hiddenQm ? (
      <span className="adm-minitile__qm" aria-hidden="true">
        ?
      </span>
    ) : (
      <>
        {clue.kind === 'image' && clue.media?.url && visible ? <img className="adm-minitile__img" src={clue.media.url} alt="" draggable={false} /> : null}
        <span className="adm-minitile__text">
          {kindIcon && (
            <span className="adm-minitile__icon" title={KIND_LABEL[clue.kind]} aria-label={KIND_LABEL[clue.kind]}>
              {kindIcon}
            </span>
          )}
          {clue.text || (clue.kind === 'text' ? '' : `(${KIND_LABEL[clue.kind]} clue)`)}
        </span>
      </>
    );
  return (
    <div className={classes} data-clue-state={visible ? 'shown' : 'hidden'}>
      <div className="adm-minitile__tile" aria-label={`clue ${index + 1}: ${visible ? 'shown' : 'hidden'}`}>
        <span className="adm-minitile__n">{index + 1}</span>
        <span className={`adm-minitile__badge ${visible ? 'is-shown' : 'is-hidden'}`}>{visible ? 'on screen' : 'hidden'}</span>
        {face}
      </div>
      <div className="adm-minitile__under">
        {hiddenQm ? (
          <>
            <span className="adm-minitile__under-label">4th item: </span>
            {kindIcon && <span aria-hidden="true">{kindIcon} </span>}
            {clue.text}
          </>
        ) : clue.kind === 'text' ? (
          <span className="adm-faint">{visible ? 'text · shown' : 'text · not yet revealed'}</span>
        ) : (
          <span className="adm-faint">
            {KIND_LABEL[clue.kind]}
            {clue.media?.name ? ` · ${clue.media.name}` : ''}
            {visible ? '' : ' · not yet revealed'}
          </span>
        )}
      </div>
    </div>
  );
}

/** Classes + labels for a wall group row from its state. */
function wallGroupStatus(g: WallGroupState, play: WallPlay) {
  const asking = play.stage === 'resolving' && play.resolvingGroup !== null && g.solvedOrder === play.resolvingGroup;
  const state: 'found' | 'revealed' | 'pending' = g.solvedOrder === null ? 'pending' : g.foundByTeam ? 'found' : 'revealed';
  const conn: 'asking' | 'correct' | 'wrong' | 'todo' | 'none' = asking
    ? 'asking'
    : g.connectionCorrect === true
      ? 'correct'
      : g.connectionCorrect === false
        ? 'wrong'
        : g.solvedOrder !== null
          ? 'todo'
          : 'none';
  return { asking, state, conn };
}

export function HostView({ state }: HostViewProps) {
  const now = useServerNow(undefined, 1000);
  const pub = projectPublic(state, now);
  const name = (t: TeamId) => state.teams[t].name;

  const qs = state.phase === 'connections' || state.phase === 'sequences' ? state.question : null;
  const q = qs && qs.questionId ? state.pack.questions.find((x) => x.id === qs.questionId) ?? null : null;
  const wr = state.phase === 'wall' ? state.wall : null;
  const play = wr?.current ?? null;
  const wall = play ? state.pack.walls.find((w) => w.id === play.wallId) ?? null : null;
  const vs = state.phase === 'vowels' ? state.vowels : null;
  const vgroup = vs ? currentVowelGroup(state) : null;
  const vclue = vs ? currentVowelClue(state) : null;

  return (
    <Panel title="Host view">
      <div className="adm-host">
        {/* ---- question: picking ---- */}
        {qs && qs.stage === 'selecting' && (
          <div>
            <div className="adm-host__title">
              <h3>{name(qs.team)} to pick</h3>
              <span className="adm-small adm-muted">
                {qs.available.length - qs.used.length} of {qs.available.length} left
              </span>
            </div>
            <div className="adm-row" style={{ marginTop: 6 }}>
              {qs.available.map((h) => {
                const used = qs.used.includes(h);
                const question = state.pack.questions.find((x) => x.round === qs.round && x.hieroglyph === h);
                return (
                  <Chip key={h} tone={used ? 'muted' : 'default'} title={question ? question.answer : undefined}>
                    {used ? '✓ ' : ''}
                    {HIEROGLYPH_LABELS[h]}
                  </Chip>
                );
              })}
            </div>
          </div>
        )}

        {/* ---- question: clues on screen ---- */}
        {qs && q && (
          <div className="adm-stack">
            <div className="adm-host__title">
              <h3>
                {HIEROGLYPH_LABELS[q.hieroglyph]} · {qs.round === 'sequences' ? 'Sequence' : 'Connection'} for {name(qs.team)}
              </h3>
              <Chip tone={qs.stage === 'answer' ? 'good' : qs.stage === 'steal' ? 'warn' : 'muted'}>
                {qs.stage === 'answer' ? 'answer revealed' : qs.stage === 'steal' ? `steal: ${name(otherTeam(qs.team))}` : `${name(qs.team)} answering`}
              </Chip>
            </div>
            <div className="adm-cluecap" data-testid="clue-caption">
              {clueCaption(qs, q.clues, name)}
            </div>
            <div className="adm-minitiles" role="list" aria-label="clues">
              {q.clues.map((c, i) => (
                <MiniClue key={i} clue={c} index={i} visible={isClueVisible(qs, i)} isFourthOfSequence={qs.round === 'sequences' && i === 3} />
              ))}
            </div>
            <div className={`adm-answer${qs.stage === 'answer' ? ' is-onscreen' : ''}`}>
              <div className="adm-answer__label">{qs.stage === 'answer' ? 'Answer · on screen' : 'Answer · host only'}</div>
              <div className="adm-answer__text">{q.answer}</div>
              {q.note && <div className="adm-answer__note">Note: {q.note}</div>}
            </div>
          </div>
        )}

        {/* ---- wall ---- */}
        {play && wall && (
          <div className="adm-stack">
            <div className="adm-host__title">
              <h3>
                {HIEROGLYPH_LABELS[wall.hieroglyph]} wall for {name(play.team)}
              </h3>
              <span className="adm-row" style={{ gap: 4 }}>
                {wr && (
                  <Chip tone="muted">
                    wall {Math.min(wr.wallsDone + 1, wr.wallsTotal)} of {wr.wallsTotal}
                  </Chip>
                )}
                <Chip tone={play.stage === 'live' ? 'good' : play.stage === 'resolving' ? 'warn' : 'muted'}>{play.stage}</Chip>
              </span>
            </div>
            <div className="adm-cluecap">
              {(() => {
                const found = play.groups.filter((g) => g.solvedOrder !== null && g.foundByTeam).length;
                const parts = [`${found} of 4 groups found`];
                if (play.lives !== null && play.stage === 'live') parts.push(`${play.lives} ${play.lives === 1 ? 'life' : 'lives'} left`);
                if (play.stage === 'resolving') {
                  const asked = play.groups.filter((g) => g.connectionRevealed).length;
                  parts.push(`${asked} of 4 connections asked`);
                }
                if (play.awarded) parts.push(`${plural(play.awarded.total, 'point')} awarded`);
                return parts.join(' · ');
              })()}
            </div>
            <div className="adm-wallgroups">
              {[...play.groups]
                .sort((a, b) => (a.solvedOrder ?? 9) - (b.solvedOrder ?? 9) || a.index - b.index)
                .map((g) => {
                  const { asking, state: gstate, conn } = wallGroupStatus(g, play);
                  const colour = g.solvedOrder !== null ? WALL_GROUP_COLOURS[g.solvedOrder] : null;
                  const classes = ['adm-wallgroup', `is-${gstate}`, asking ? 'is-current' : '', conn === 'correct' ? 'is-correct' : conn === 'wrong' ? 'is-wrong' : ''].filter(Boolean).join(' ');
                  return (
                    <div key={g.index} className={classes} data-group-state={gstate} data-connection-state={conn}>
                      <span className="adm-wallgroup__swatch" style={colour ? { background: colour } : undefined} />
                      <div className="adm-wallgroup__main">
                        <div className="adm-wallgroup__conn">
                          {g.connection}
                          {conn === 'correct' && (
                            <span className="adm-wallgroup__mark is-correct" aria-label="connection correct">
                              ✓
                            </span>
                          )}
                          {conn === 'wrong' && (
                            <span className="adm-wallgroup__mark is-wrong" aria-label="connection wrong">
                              ✗
                            </span>
                          )}
                        </div>
                        <div className="adm-wallgroup__clues">
                          {(wall.groups[g.index]?.clues ?? []).map((text, i) => (
                            <span key={i} className="adm-wallgroup__clue" style={colour ? { borderColor: colour } : undefined}>
                              {text}
                            </span>
                          ))}
                        </div>
                      </div>
                      <div className="adm-wallgroup__status">
                        {gstate === 'pending' ? (
                          <Chip tone="muted">not found yet</Chip>
                        ) : gstate === 'found' ? (
                          <Chip tone="good">found #{(g.solvedOrder ?? 0) + 1}</Chip>
                        ) : (
                          <Chip tone="warn">not found · revealed #{(g.solvedOrder ?? 0) + 1}</Chip>
                        )}
                        {conn === 'asking' && <Chip tone="warn">asking connection now</Chip>}
                        {conn === 'correct' && <Chip tone="good">connection ✓ correct</Chip>}
                        {conn === 'wrong' && <Chip tone="bad">connection ✗ wrong</Chip>}
                        {conn === 'todo' && play.stage === 'resolving' && <Chip tone="muted">connection not asked yet</Chip>}
                      </div>
                    </div>
                  );
                })}
            </div>
          </div>
        )}
        {wr && !play && (
          <div className="adm-stack" data-testid="host-walls">
            <div className="adm-host__title">
              <h3>{wr.wallsDone >= wr.wallsTotal ? 'All walls played' : `${name(wr.team)} to choose a wall`}</h3>
              <span className="adm-small adm-muted">
                {wr.wallsDone >= wr.wallsTotal ? `${wr.wallsTotal} of ${wr.wallsTotal} played` : `wall ${Math.min(wr.wallsDone + 1, wr.wallsTotal)} of ${wr.wallsTotal} · ${wr.available.length - wr.used.length} left`}
              </span>
            </div>
            {[...state.pack.walls]
              .sort((a, b) => a.position - b.position)
              .map((w, i) => {
                const used = wr.used.includes(w.hieroglyph);
                return (
                  <div key={w.id} className={`adm-wallgroup${used ? ' is-found' : ' is-pending'}`} data-wall-state={used ? 'played' : 'available'}>
                    <span className="adm-wallgroup__swatch" />
                    <div className="adm-wallgroup__main">
                      <div className="adm-wallgroup__conn">
                        {HIEROGLYPH_LABELS[w.hieroglyph]} <span className="adm-faint">· wall {i + 1}</span>
                      </div>
                      <div className="adm-wallgroup__clues adm-wallgroup__clues--plain">{w.groups.map((g) => g.connection).join(' · ')}</div>
                    </div>
                    <div className="adm-wallgroup__status">{used ? <Chip tone="good">played</Chip> : <Chip tone="muted">available</Chip>}</div>
                  </div>
                );
              })}
          </div>
        )}

        {/* ---- vowels ---- */}
        {vs && vgroup && (
          <div className="adm-stack">
            <div className="adm-host__title">
              <h3>{vgroup.category}</h3>
              <Chip tone="muted">
                category {vs.groupIndex + 1}/{state.pack.vowelGroups.length}
              </Chip>
            </div>
            {vclue && (
              <div className="adm-vowelcard" data-testid="vowels-current">
                <div className="adm-vowelcard__row">
                  <div className="adm-vowelcard__label">
                    Clue {vs.clueIndex + 1}/{vgroup.clues.length} · on screen
                  </div>
                  <div className={`adm-vowelcard__display${vs.stage === 'category' ? ' is-empty' : ''}`}>
                    {vs.stage === 'answer' ? vclue.answer : vs.stage === 'category' ? 'category bar only — no clue yet' : vclue.display}
                  </div>
                </div>
                <div className={`adm-answer${vs.stage === 'answer' ? ' is-onscreen' : ''}`}>
                  <div className="adm-answer__label">{vs.stage === 'answer' ? 'Answer · on screen' : 'Answer · host only'}</div>
                  <div className="adm-answer__text">{vclue.answer}</div>
                </div>
                <div className="adm-vowelcard__buzz">
                  {vs.buzz ? (
                    <>
                      <span className="adm-vowelcard__buzzlabel">Buzzed:</span>
                      <Chip tone={vs.buzz.team}>
                        {vs.buzz.playerName} · {name(vs.buzz.team)}
                      </Chip>
                      <Chip tone={vs.stage === 'buzzed' ? 'warn' : vs.stage === 'other' ? 'warn' : vs.stage === 'answer' ? 'good' : 'muted'}>
                        {vs.stage === 'buzzed' ? 'judge their answer' : vs.stage === 'other' ? `wrong · ${name(otherTeam(vs.buzz.team))} may answer` : vs.stage === 'answer' ? 'answer revealed' : vs.stage}
                      </Chip>
                    </>
                  ) : (
                    <Chip tone="muted">{vs.stage === 'clue' ? 'buzzers open · nobody has buzzed' : vs.stage === 'category' ? 'buzzers closed' : 'no buzz'}</Chip>
                  )}
                  {vs.lockedPlayers.length > 0 && (
                    <span className="adm-small adm-muted">
                      locked out: {vs.lockedPlayers.map((id) => state.players.find((p) => p.id === id)?.name ?? id).join(', ')}
                    </span>
                  )}
                  {vs.result && (
                    <span className="adm-small adm-muted">
                      result: {vs.result.team ? `${name(vs.result.team)} ${vs.result.delta[vs.result.team] >= 0 ? '+' : ''}${vs.result.delta[vs.result.team]}` : 'nobody'}
                    </span>
                  )}
                </div>
              </div>
            )}
            <div className="adm-clues">
              {vgroup.clues.map((c, i) => {
                const done = i < vs.clueIndex || (i === vs.clueIndex && vs.stage === 'answer');
                const current = i === vs.clueIndex;
                const cls = done ? 'is-done' : current ? 'is-current' : 'is-next';
                return (
                  <div key={i} className={`adm-vclue ${cls}`} data-clue-state={done ? 'done' : current ? 'current' : 'next'}>
                    <span className="adm-vclue__n">{done ? '✓' : i + 1}</span>
                    <span className="adm-vclue__display">{c.display}</span>
                    <span className="adm-vclue__answer">{c.answer}</span>
                    <span className="adm-vclue__state">{done ? 'done' : current ? (vs.stage === 'category' ? 'up next' : 'on screen') : 'not yet'}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {state.phase === 'lobby' && (
          <div className="adm-small adm-muted">
            Lobby on screen. {state.players.length} player{state.players.length === 1 ? '' : 's'} joined; pack "{state.pack.name}" with{' '}
            {state.pack.vowelGroups.length} vowel categor{state.pack.vowelGroups.length === 1 ? 'y' : 'ies'}.
          </div>
        )}
        {state.phase === 'final' && (
          <div className="adm-small adm-muted">
            Final scores on screen: {name('pink')} {state.teams.pink.score} · {name('blue')} {state.teams.blue.score}.
          </div>
        )}

        <div className="adm-preview" aria-label="monitor preview">
          <div className="adm-preview__label">Monitor shows</div>
          {monitorSummary(pub).join('\n')}
        </div>
      </div>
    </Panel>
  );
}

export default HostView;
