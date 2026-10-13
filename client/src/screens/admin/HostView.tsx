import {
  HIEROGLYPHS,
  HIEROGLYPH_LABELS,
  WALL_GROUP_COLOURS,
  currentVowelClue,
  currentVowelGroup,
  isClueVisible,
  otherTeam,
  projectPublic,
  type GameState,
  type PublicGameState,
  type TeamId,
} from '@only-connect/shared';
import { useServerNow } from '../../lib/useServerNow';
import { Chip, Panel } from './ui';

export interface HostViewProps {
  state: GameState;
}

const KIND_LABEL = { text: 'text', image: 'picture', audio: 'audio' } as const;

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
      const play = pub.wall?.current;
      if (!play) return ['Wall round, no wall on screen', scores];
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

export function HostView({ state }: HostViewProps) {
  const now = useServerNow(undefined, 1000);
  const pub = projectPublic(state, now);
  const name = (t: TeamId) => state.teams[t].name;

  const qs = state.phase === 'connections' || state.phase === 'sequences' ? state.question : null;
  const q = qs && qs.questionId ? state.pack.questions.find((x) => x.id === qs.questionId) ?? null : null;
  const play = state.phase === 'wall' ? state.wall?.current ?? null : null;
  const wall = play ? state.pack.walls.find((w) => w.id === play.wallId) ?? null : null;
  const vs = state.phase === 'vowels' ? state.vowels : null;
  const vgroup = vs ? currentVowelGroup(state) : null;
  const vclue = vs ? currentVowelClue(state) : null;

  return (
    <Panel title="Host view">
      <div className="adm-host">
        {/* ---- question ---- */}
        {qs && qs.stage === 'selecting' && (
          <div>
            <div className="adm-host__title">
              <h3>{name(qs.team)} to pick</h3>
              <span className="adm-small adm-muted">{6 - qs.used.length} left</span>
            </div>
            <div className="adm-row" style={{ marginTop: 6 }}>
              {HIEROGLYPHS.map((h) => {
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
        {qs && q && (
          <div className="adm-stack">
            <div className="adm-host__title">
              <h3>
                {HIEROGLYPH_LABELS[q.hieroglyph]} · {qs.round === 'sequences' ? 'Sequence' : 'Connection'} for {name(qs.team)}
              </h3>
              <Chip tone="muted">
                {q.clues.filter((_, i) => isClueVisible(qs, i)).length}/{q.clues.length} revealed
              </Chip>
            </div>
            <div className="adm-clues">
              {q.clues.map((c, i) => {
                const visible = isClueVisible(qs, i);
                return (
                  <div key={i} className={`adm-clue${visible ? '' : ' is-hidden'}`}>
                    <span className="adm-clue__n">{i + 1}</span>
                    <span className="adm-clue__text">
                      {c.text}
                      {qs.round === 'sequences' && i === 3 && <span className="adm-small"> (hidden 4th item)</span>}
                    </span>
                    <span className="adm-clue__kind">{c.kind === 'text' ? (visible ? 'shown' : 'hidden') : `${KIND_LABEL[c.kind]}${visible ? '' : ' · hidden'}`}</span>
                  </div>
                );
              })}
            </div>
            <div className="adm-answer">
              <div className="adm-answer__label">Answer{qs.stage === 'answer' ? ' (on screen)' : ''}</div>
              <div className="adm-answer__text">{q.answer}</div>
              {q.note && <div className="adm-answer__note">Note: {q.note}</div>}
            </div>
          </div>
        )}

        {/* ---- wall ---- */}
        {play && wall && (
          <div className="adm-stack">
            <div className="adm-host__title">
              <h3>Wall for {name(play.team)}</h3>
              <Chip tone="muted">{play.stage}</Chip>
            </div>
            <div className="adm-wallgroups">
              {[...play.groups]
                .sort((a, b) => (a.solvedOrder ?? 9) - (b.solvedOrder ?? 9) || a.index - b.index)
                .map((g) => {
                  const isCurrent = play.stage === 'resolving' && play.resolvingGroup !== null && g.solvedOrder === play.resolvingGroup;
                  return (
                    <div key={g.index} className={`adm-wallgroup${isCurrent ? ' is-current' : ''}`}>
                      <span className="adm-wallgroup__swatch" style={g.solvedOrder !== null ? { background: WALL_GROUP_COLOURS[g.solvedOrder] } : undefined} />
                      <div>
                        <div className="adm-wallgroup__conn">{g.connection}</div>
                        <div className="adm-wallgroup__clues">{wall.groups[g.index]?.clues.join(' · ')}</div>
                      </div>
                      <div className="adm-wallgroup__status">
                        {g.solvedOrder === null ? (
                          <Chip tone="muted">not found</Chip>
                        ) : g.foundByTeam ? (
                          <Chip tone="good">found #{g.solvedOrder + 1}</Chip>
                        ) : (
                          <Chip tone="warn">revealed #{g.solvedOrder + 1}</Chip>
                        )}
                        {g.connectionRevealed && (
                          <Chip tone={g.connectionCorrect ? 'good' : 'bad'}>{g.connectionCorrect ? 'connection ✓' : 'connection ✗'}</Chip>
                        )}
                        {isCurrent && <Chip tone="warn">asking now</Chip>}
                      </div>
                    </div>
                  );
                })}
            </div>
          </div>
        )}
        {state.phase === 'wall' && !play && state.wall && (
          <div className="adm-stack">
            <h3>Walls in this pack</h3>
            {state.pack.walls.map((w, i) => {
              const team = (['pink', 'blue'] as const).find((t) => state.wall?.assignment[t] === w.id);
              return (
                <div key={w.id} className="adm-wallgroup">
                  <span className="adm-wallgroup__swatch" />
                  <div>
                    <div className="adm-wallgroup__conn">Wall {i + 1}</div>
                    <div className="adm-wallgroup__clues">{w.groups.map((g) => g.connection).join(' · ')}</div>
                  </div>
                  <div className="adm-wallgroup__status">{team ? <Chip tone={team}>{name(team)}</Chip> : <Chip tone="muted">unassigned</Chip>}</div>
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
              <div className="adm-answer">
                <div className="adm-answer__label">
                  Clue {vs.clueIndex + 1}/{vgroup.clues.length} · on screen: {vs.stage === 'category' ? '—' : vclue.display}
                </div>
                <div className="adm-answer__text">{vclue.answer}</div>
                {vs.buzz && (
                  <div className="adm-answer__note">
                    Buzzed: {vs.buzz.playerName} ({name(vs.buzz.team)})
                    {vs.lockedPlayers.length > 0 ? ` · locked out: ${vs.lockedPlayers.map((id) => state.players.find((p) => p.id === id)?.name ?? id).join(', ')}` : ''}
                  </div>
                )}
              </div>
            )}
            <div className="adm-clues">
              {vgroup.clues.map((c, i) => {
                const done = i < vs.clueIndex || (i === vs.clueIndex && vs.stage === 'answer');
                const current = i === vs.clueIndex;
                return (
                  <div key={i} className={`adm-clue${done || current ? '' : ' is-hidden'}`}>
                    <span className="adm-clue__n">{i + 1}</span>
                    <span className="adm-clue__text">
                      {c.answer} <span className="adm-small" style={{ opacity: 0.7 }}>({c.display})</span>
                    </span>
                    <span className="adm-clue__kind">{done ? 'done' : current ? 'current' : 'next'}</span>
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
