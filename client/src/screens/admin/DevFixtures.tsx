/**
 * /dev/admin?fixture=<id> — renders the admin pages with canned state and a local (engine-backed) dispatch so
 * they can be screenshotted and clicked through without the API. Ids: lobby, connections-question,
 * wall-live, vowels-buzzed, final, packs-list, pack-editor, all.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import type { GameState } from '@only-connect/shared';
import { GameControl } from './GameControl';
import { DirtyContext } from './guard';
import { PackEditor } from './PackEditor';
import { PacksList } from './PacksList';
import { FIXTURE_IDS, createFixturePacksApi, fixtureState, useFixtureGame, type FixtureId } from './fixtures';
import './admin.css';

const GAME_FIXTURES = ['lobby', 'connections-question', 'wall-live', 'vowels-buzzed', 'final'] as const;
type GameFixtureId = (typeof GAME_FIXTURES)[number];

function isFixtureId(v: string | null): v is FixtureId {
  return v !== null && (FIXTURE_IDS as readonly string[]).includes(v);
}

function FixtureFrame({ id, children }: { id: string; children: ReactNode }) {
  return (
    <div className="adm-fixture">
      <div className="adm-fixture__label">fixture: {id}</div>
      {children}
    </div>
  );
}

function GameFixture({ id, packsApi }: { id: GameFixtureId; packsApi: ReturnType<typeof createFixturePacksApi> }) {
  const initial = useMemo<GameState>(() => fixtureState(id), [id]);
  const game = useFixtureGame(initial, packsApi);
  return (
    <FixtureFrame id={id}>
      <GameControl game={game} packs={packsApi} />
    </FixtureFrame>
  );
}

function PacksListFixture({ packsApi }: { packsApi: ReturnType<typeof createFixturePacksApi> }) {
  return (
    <FixtureFrame id="packs-list">
      <PacksList packs={packsApi} editorPath={() => '/dev/admin?fixture=pack-editor'} />
    </FixtureFrame>
  );
}

function PackEditorFixture({ packsApi }: { packsApi: ReturnType<typeof createFixturePacksApi> }) {
  const pack = [...packsApi.packs.values()][0];
  const [dirty, setDirty] = useState(false);
  const guard = useMemo(() => ({ dirty, setDirty }), [dirty]);
  return (
    <FixtureFrame id="pack-editor">
      <DirtyContext.Provider value={guard}>
        <PackEditor packs={packsApi} packId={pack.id} initialPack={pack} backPath="/dev/admin?fixture=packs-list" />
      </DirtyContext.Provider>
    </FixtureFrame>
  );
}

export function DevFixtures() {
  const { search } = useLocation();
  const requested = new URLSearchParams(search).get('fixture');
  const id: FixtureId = isFixtureId(requested) ? requested : 'lobby';
  const packsApi = useMemo(() => createFixturePacksApi(), []);
  const ids: FixtureId[] = id === 'all' ? FIXTURE_IDS.filter((f) => f !== 'all') : [id];

  return (
    <div className="adm">
      {ids.map((f) => {
        if (f === 'packs-list') return <PacksListFixture key={f} packsApi={packsApi} />;
        if (f === 'pack-editor') return <PackEditorFixture key={f} packsApi={packsApi} />;
        if ((GAME_FIXTURES as readonly string[]).includes(f)) return <GameFixture key={f} id={f as GameFixtureId} packsApi={packsApi} />;
        return null;
      })}
    </div>
  );
}

export default DevFixtures;
