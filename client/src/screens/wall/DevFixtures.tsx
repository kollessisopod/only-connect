import { useCallback, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { GameError, applyAction, type GameState } from '@only-connect/shared';
import { useServerNow } from '../../lib';
import { WallView } from './WallView';
import { WALL_FIXTURE_IDS, buildWallFixtures, makeCtx, projectFixture, type WallFixture } from './fixtures';
import './DevFixtures.css';

const BASE = Date.now();
const FIXTURES = buildWallFixtures(BASE);

/**
 * One fixture rendered through the real view. Taps are applied with the engine locally (wall:select against
 * the fixture's full state) so the flash / FLIP animations can be exercised without the API.
 */
function FixturePanel({ fixture, ticking }: { fixture: WallFixture; ticking: boolean }) {
  const now = useServerNow(0, ticking ? 250 : 60_000);
  const [full, setFull] = useState<GameState | null>(fixture.full);
  const [notice, setNotice] = useState<string | null>(fixture.notice ?? null);
  const timer = useRef<number | null>(null);

  const flash = useCallback((text: string) => {
    setNotice(text);
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setNotice(null), 1600);
  }, []);

  const onSelect = useCallback(
    (tileId: number) => {
      setFull((current) => {
        if (!current) return current;
        try {
          return applyAction(current, { type: 'wall:select', tileId }, makeCtx(Date.now()));
        } catch (err) {
          flash(err instanceof GameError ? err.message : String(err));
          return current;
        }
      });
    },
    [flash],
  );

  // Project once per engine state and let only `serverNow` follow the clock: the tiles keep their identity
  // across ticks, as on /wall where the state only changes on broadcasts, so the memoised grid is left alone.
  const projected = useMemo(() => (full ? projectFixture(full, Date.now()) : fixture.state), [full, fixture.state]);
  const state = useMemo(
    () => (projected && projected.phase !== 'none' ? { ...projected, serverNow: now } : projected),
    [projected, now],
  );
  return <WallView state={state} now={now} onSelect={onSelect} selecting={false} notice={notice} />;
}

function Index() {
  return (
    <div className="devfx__index">
      <h1>/dev/wall fixtures</h1>
      <ul>
        {WALL_FIXTURE_IDS.map((id) => (
          <li key={id}>
            <a href={`/dev/wall?fixture=${id}`}>{id}</a> — {FIXTURES[id]?.title}
          </li>
        ))}
        <li>
          <a href="/dev/wall?fixture=all">all</a> — every fixture in a 960×540 frame
        </li>
      </ul>
    </div>
  );
}

function All() {
  return (
    <div className="devfx__all">
      {WALL_FIXTURE_IDS.map((id) => (
        <section key={id} className="devfx__item">
          <h2 className="devfx__label">
            {id} — {FIXTURES[id].title}
          </h2>
          <div className="devfx__frame devfx__frame--wall">
            <FixturePanel fixture={FIXTURES[id]} ticking={false} />
          </div>
        </section>
      ))}
    </div>
  );
}

/** `/dev/wall?fixture=<id>` renders one fixture full-screen; `all` tiles them; anything else lists them. */
export function DevFixtures() {
  const [params] = useSearchParams();
  const id = params.get('fixture') ?? 'live-0';
  if (id === 'all') return <All />;
  const fixture = FIXTURES[id];
  if (!fixture) return <Index />;
  return <FixturePanel fixture={fixture} ticking />;
}

export default DevFixtures;
