/**
 * /dev/monitor?fixture=<id> — renders MonitorView with an engine-built state (see fixtures.ts), so every
 * monitor stage can be screenshotted without the API. `?fixture=all` stacks every fixture in 1920×1080 frames.
 * `?fixture=<a>,<b>,<c>&step=<ms>` plays the fixtures one after another (default 2500 ms each, ending on the
 * last) through the same MonitorView instance, so the transitions a live game produces — the first-clue
 * intro, the points badge gliding to the next column — can be watched and screenshotted without the API.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useServerNow } from '../../lib/useServerNow';
import { FIXTURE_IDS, buildAllFixtures, buildFixture, isFixtureId, type MonitorFixture } from './fixtures';
import { MonitorIdle, MonitorView } from './MonitorView';
import './DevFixtures.css';

function errorMessage(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/**
 * `?tick=1` advances the fixture's frozen `now` with the real clock (250 ms re-renders, exactly like
 * /monitor's useServerNow), so the wall countdown runs and render performance can be measured without the API.
 * Off by default so fixture screenshots stay deterministic.
 */
function useFixtureNow(base: number, ticking: boolean): number {
  const start = useRef(Date.now());
  const tick = useServerNow(0, ticking ? 250 : 3_600_000);
  return ticking ? base + (tick - start.current) : base;
}

function FixtureFrame({ fixture, ticking = false }: { fixture: MonitorFixture; ticking?: boolean }) {
  const now = useFixtureNow(fixture.now, ticking);
  if (fixture.state.phase === 'none') return <MonitorIdle caption="Waiting for the game master" pulse={false} />;
  return <MonitorView state={fixture.state} now={now} soundEnabled forceIntro={fixture.intro === true} />;
}

/**
 * Plays `fixtures` in order, `stepMs` apart, with a clock that runs on from each fixture's own `now` (the
 * question-clock fixtures share one `startedAt`, so the badge's fill carries straight on across the steps).
 */
function FixtureSequence({ fixtures, stepMs }: { fixtures: MonitorFixture[]; stepMs: number }) {
  const [index, setIndex] = useState(0);
  const stepStart = useRef(Date.now());
  const tick = useServerNow(0, 250);
  useEffect(() => {
    if (index >= fixtures.length - 1) return undefined;
    const timer = window.setTimeout(() => {
      stepStart.current = Date.now();
      setIndex(index + 1);
    }, stepMs);
    return () => window.clearTimeout(timer);
  }, [index, fixtures.length, stepMs]);
  const fixture = fixtures[index];
  const now = fixture.now + Math.max(0, tick - stepStart.current);
  if (fixture.state.phase === 'none') return <MonitorIdle caption="Waiting for the game master" pulse={false} />;
  return <MonitorView state={fixture.state} now={now} soundEnabled forceIntro={fixture.intro === true} />;
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
  const params = new URLSearchParams(search);
  const requested = params.get('fixture');
  const ticking = params.get('tick') === '1';
  const id = requested ?? 'lobby';
  const stepMs = Math.max(200, Number(params.get('step')) || 2500);

  const sequence = useMemo(() => {
    const ids = id.split(',');
    if (ids.length < 2) return null;
    try {
      if (!ids.every(isFixtureId)) throw new Error(`unknown fixture in sequence: ${ids.filter((x) => !isFixtureId(x)).join(', ')}`);
      return { fixtures: ids.map(buildFixture), error: null };
    } catch (err) {
      return { fixtures: null, error: errorMessage(err) };
    }
  }, [id]);

  const single = useMemo(() => {
    if (!isFixtureId(id)) return null;
    try {
      return { fixture: buildFixture(id), error: null };
    } catch (err) {
      return { fixture: null, error: errorMessage(err) };
    }
  }, [id]);

  if (id === 'all') return <AllFixtures />;

  if (sequence) {
    if (!sequence.fixtures) {
      return (
        <div className="screen screen--scroll mfx">
          <pre className="mfx__error">{sequence.error}</pre>
          <FixtureIndex current={null} />
        </div>
      );
    }
    return (
      <div className="screen" data-fixture={id}>
        <FixtureSequence fixtures={sequence.fixtures} stepMs={stepMs} />
      </div>
    );
  }

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
      <FixtureFrame fixture={single.fixture} ticking={ticking} />
    </div>
  );
}

export default DevFixtures;
