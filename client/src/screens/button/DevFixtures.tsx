import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { TeamId } from '@only-connect/shared';
import { ButtonView, type BuzzFeedback } from './ButtonView';
import { JoinForm } from './JoinForm';
import { BUTTON_FIXTURE_IDS, buildButtonFixtures, type ButtonFixture } from './fixtures';
import './DevFixtures.css';

const FIXTURES = buildButtonFixtures(Date.now());

function FixturePhone({ fixture }: { fixture: ButtonFixture }) {
  const [feedback, setFeedback] = useState<BuzzFeedback | null>(fixture.feedback ?? null);
  const [busy, setBusy] = useState(false);
  const [joined, setJoined] = useState<{ name: string; team: TeamId } | null>(null);

  if (fixture.join) {
    const game = fixture.state && fixture.state.phase !== 'none' ? fixture.state : null;
    return (
      <JoinForm
        initialTeam={null}
        teamNames={game ? { pink: game.teams.pink.name, blue: game.teams.blue.name } : undefined}
        busy={busy}
        error={joined ? `(dev) would join as ${joined.name} on ${joined.team}` : null}
        onJoin={(name, team) => {
          setBusy(true);
          window.setTimeout(() => {
            setBusy(false);
            setJoined({ name, team });
          }, 600);
        }}
      />
    );
  }

  return (
    <ButtonView
      state={fixture.state}
      player={fixture.player}
      connected={fixture.connected ?? true}
      joining={fixture.joining ?? false}
      buzzing={busy}
      feedback={feedback}
      onBuzz={() => {
        setBusy(true);
        window.setTimeout(() => {
          setBusy(false);
          setFeedback({ kind: 'won', text: 'You buzzed first!' });
        }, 300);
      }}
      onLeave={() => setFeedback({ kind: 'error', text: '(dev) leave pressed' })}
      onRejoin={() => setFeedback({ kind: 'error', text: '(dev) rejoin pressed' })}
    />
  );
}

function Index() {
  return (
    <div className="devfx__index">
      <h1>/dev/button fixtures</h1>
      <ul>
        {BUTTON_FIXTURE_IDS.map((id) => (
          <li key={id}>
            <a href={`/dev/button?fixture=${id}`}>{id}</a> — {FIXTURES[id]?.title}
          </li>
        ))}
        <li>
          <a href="/dev/button?fixture=all">all</a> — every fixture in a 390×844 phone frame
        </li>
      </ul>
    </div>
  );
}

function All() {
  return (
    <div className="devfx__all">
      {BUTTON_FIXTURE_IDS.map((id) => (
        <section key={id} className="devfx__item">
          <h2 className="devfx__label">
            {id} — {FIXTURES[id].title}
          </h2>
          <div className="devfx__frame devfx__frame--phone">
            <FixturePhone fixture={FIXTURES[id]} />
          </div>
        </section>
      ))}
    </div>
  );
}

/** `/dev/button?fixture=<id>` renders one fixture full-screen; `all` tiles them; anything else lists them. */
export function DevFixtures() {
  const [params] = useSearchParams();
  const id = params.get('fixture') ?? 'open';
  if (id === 'all') return <All />;
  const fixture = FIXTURES[id];
  if (!fixture) return <Index />;
  return <FixturePhone key={id} fixture={fixture} />;
}

export default DevFixtures;
