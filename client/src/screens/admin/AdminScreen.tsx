/**
 * /admin — game master console (SPEC §8). Login gate, top nav, then nested routes:
 *   /admin            game control
 *   /admin/packs      pack list
 *   /admin/packs/:id  pack editor
 */
import { useCallback, useEffect, useMemo, useState, type MouseEvent } from 'react';
import { NavLink, Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { UNAUTHORIZED_EVENT, getToken, logout } from '../../lib/api';
import { GameControl } from './GameControl';
import { DirtyContext } from './guard';
import { LoginPage } from './LoginPage';
import { PackEditor } from './PackEditor';
import { PacksList } from './PacksList';
import { livePacksApi } from './packsApi';
import { useAdminState } from './useAdminState';
import { Button, InlineConfirm } from './ui';
import './admin.css';

export function AdminScreen() {
  const [token, setToken] = useState<string | null>(() => getToken());
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const onUnauthorized = () => {
      setToken(null);
      setNotice('Your session has expired. Please log in again.');
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
  }, []);

  if (!token) {
    return (
      <LoginPage
        notice={notice}
        onLoggedIn={(t) => {
          setNotice(null);
          setToken(t);
        }}
      />
    );
  }
  return (
    <AdminShell
      token={token}
      onLogout={() => {
        logout();
        setNotice(null);
        setToken(null);
      }}
    />
  );
}

function AdminShell({ token, onLogout }: { token: string; onLogout: () => void }) {
  const game = useAdminState(token);
  const navigate = useNavigate();
  const [dirty, setDirty] = useState(false);
  const [pendingNav, setPendingNav] = useState<string | null>(null);
  const guard = useMemo(() => ({ dirty, setDirty }), [dirty]);

  const guardedClick = useCallback(
    (to: string) => (e: MouseEvent<HTMLAnchorElement>) => {
      if (!dirty) return;
      e.preventDefault();
      setPendingNav(to);
    },
    [dirty],
  );

  return (
    <DirtyContext.Provider value={guard}>
      <div className="adm">
        <nav className="adm-nav" aria-label="admin">
          <div className="adm-nav__brand">
            Only Connect <small>admin</small>
          </div>
          <div className="adm-nav__links">
            <NavLink to="/admin" end className={({ isActive }) => `adm-nav__link${isActive ? ' is-active' : ''}`} onClick={guardedClick('/admin')}>
              Game
            </NavLink>
            <NavLink to="/admin/packs" className={({ isActive }) => `adm-nav__link${isActive ? ' is-active' : ''}`} onClick={guardedClick('/admin/packs')}>
              Packs {dirty && <span className="adm-nav__dirty" title="unsaved changes" />}
            </NavLink>
            <a className="adm-nav__link" href="/monitor" target="_blank" rel="noopener noreferrer">
              Monitor ↗
            </a>
          </div>
          <div className="adm-nav__right">
            <span className={`adm-conn ${game.connected ? 'is-on' : 'is-off'}`} title={game.error ?? undefined}>
              <span className="adm-conn__dot" />
              {game.connected ? 'connected' : game.error ? 'disconnected' : 'connecting…'}
            </span>
            <Button size="sm" tone="ghost" onClick={onLogout}>
              Logout
            </Button>
          </div>
        </nav>

        {pendingNav && (
          <div className="adm-page" style={{ paddingBottom: 0 }}>
            <InlineConfirm
              text="You have unsaved changes in the pack editor. Leave and discard them?"
              confirmLabel="Discard changes"
              onConfirm={() => {
                const to = pendingNav;
                setPendingNav(null);
                setDirty(false);
                navigate(to);
              }}
              onCancel={() => setPendingNav(null)}
            />
          </div>
        )}

        <Routes>
          <Route index element={<GameControl game={game} packs={livePacksApi} />} />
          <Route path="packs" element={<PacksList packs={livePacksApi} />} />
          <Route path="packs/:id" element={<PackEditorRoute />} />
          <Route path="*" element={<Navigate to="/admin" replace />} />
        </Routes>
      </div>
    </DirtyContext.Provider>
  );
}

function PackEditorRoute() {
  const { id } = useParams<{ id: string }>();
  if (!id) return <Navigate to="/admin/packs" replace />;
  return <PackEditor key={id} packs={livePacksApi} packId={id} />;
}

export default AdminScreen;
