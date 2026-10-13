/**
 * /dev/monitor?fixture=<id> — renders MonitorView with an engine-built state (see fixtures.ts), so every
 * monitor stage can be screenshotted without the API. `?fixture=all` stacks every fixture in 1920×1080 frames.
 */
import { useMemo } from 'react';
import { useLocation } from 'react-router-dom';
import { FIXTURE_IDS, buildAllFixtures, buildFixture, isFixtureId, type MonitorFixture } from './fixtures';
import { MonitorIdle, MonitorView } from './MonitorView';
import './DevFixtures.css';

function errorMessage(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

function FixtureFrame({ fixture }: { fixture: MonitorFixture }) {
  if (fixture.state.phase === 'none') return <MonitorIdle caption="Waiting for the game master" pulse={false} />;
  return <MonitorView state={fixture.state} now={fixture.now} soundEnabled />;
}

function FixtureIndex({ current }: { current: string | null }) {
  return (
    <nav className="mfx__index" aria-label="fixtures">
      {current !== null && !isFixtureId(current) && current !== 'all' && (
        <p className="mfx__error">Unknown fixture “{current}”. Pick one:</p>
      )}
      <ul>
        <li>
          <a href="?fixture=all">all</a>
        </li>
        {FIXTURE_IDS.map((id) => (
          <li key={id}>
            <a href={`?fixture=${id}`}>{id}</a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function AllFixtures() {
  const fixtures = useMemo(() => {
    const out: Array<{ id: string; fixture: MonitorFixture | null; error: string | null }> = [];
    try {
      for (const fixture of buildAllFixtures()) out.push({ id: fixture.id, fixture, error: null });
    } catch (err) {
      out.push({ id: 'build', fixture: null, error: errorMessage(err) });
    }
    return out;
  }, []);

  return (
    <div className="screen screen--scroll mfx">
      <header className="mfx__header">
        <h1>Monitor fixtures</h1>
        <p>
          Every frame is 1920×1080 and is produced by replaying real actions through the game engine. Open a
          single one with <code>?fixture=&lt;id&gt;</code>.
        </p>
      </header>
      {fixtures.map(({ id, fixture, error }) => (
        <section key={id} className="mfx__item" data-fixture={id}>
          <h2 className="mfx__label">
            <code>{id}</code>
            {fixture && <span> — {fixture.label}</span>}
          </h2>
          <div className="mfx__frame">
            {fixture ? <FixtureFrame fixture={fixture} /> : <pre className="mfx__error">{error}</pre>}
          </div>
        </section>
      ))}
    </div>
  );
}

export function DevFixtures() {
  const { search } = useLocation();
  const requested = new URLSearchParams(search).get('fixture');
  const id = requested ?? 'lobby';

  const single = useMemo(() => {
    if (!isFixtureId(id)) return null;
    try {
      return { fixture: buildFixture(id), error: null };
    } catch (err) {
      return { fixture: null, error: errorMessage(err) };
    }
  }, [id]);

  if (id === 'all') return <AllFixtures />;

  if (!single) {
    return (
      <div className="screen screen--scroll mfx">
        <FixtureIndex current={requested} />
      </div>
    );
  }

  if (!single.fixture) {
    return (
      <div className="screen screen--scroll mfx">
        <pre className="mfx__error">
          Fixture “{id}” failed to build:{'\n'}
          {single.error}
        </pre>
        <FixtureIndex current={null} />
      </div>
    );
  }

  return (
    <div className="screen" data-fixture={id}>
      <FixtureFrame fixture={single.fixture} />
    </div>
  );
}

export default DevFixtures;
