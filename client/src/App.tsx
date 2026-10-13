import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Background } from './components/Background';

const MonitorScreen = lazy(() => import('./screens/monitor/MonitorScreen'));
const WallScreen = lazy(() => import('./screens/wall/WallScreen'));
const ButtonScreen = lazy(() => import('./screens/button/ButtonScreen'));
const AdminScreen = lazy(() => import('./screens/admin/AdminScreen'));
const GalleryScreen = lazy(() => import('./screens/gallery/GalleryScreen'));
// Dev-only fixture pages: each screen renders its presentational view with canned state so it can be
// screenshotted without the API. `?fixture=<id>` selects the fixture; see each screen's DevFixtures.tsx.
const MonitorFixtures = lazy(() => import('./screens/monitor/DevFixtures'));
const WallFixtures = lazy(() => import('./screens/wall/DevFixtures'));
const ButtonFixtures = lazy(() => import('./screens/button/DevFixtures'));
const AdminFixtures = lazy(() => import('./screens/admin/DevFixtures'));

function Loading() {
  return (
    <div className="screen">
      <Background variant="blue">
        <div className="screen__placeholder">
          <small>Loading…</small>
        </div>
      </Background>
    </div>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<Loading />}>
        <Routes>
          <Route path="/" element={<Navigate to="/monitor" replace />} />
          <Route path="/monitor" element={<MonitorScreen />} />
          <Route path="/wall" element={<WallScreen />} />
          <Route path="/button" element={<ButtonScreen />} />
          <Route path="/admin/*" element={<AdminScreen />} />
          <Route path="/gallery" element={<GalleryScreen />} />
          <Route path="/dev/monitor" element={<MonitorFixtures />} />
          <Route path="/dev/wall" element={<WallFixtures />} />
          <Route path="/dev/button" element={<ButtonFixtures />} />
          <Route path="/dev/admin/*" element={<AdminFixtures />} />
          <Route path="*" element={<Navigate to="/monitor" replace />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}

export default App;
