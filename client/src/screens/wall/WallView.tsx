import {
  memo,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  WALL_GROUP_COLOURS,
  wallSecondsRemaining,
  type PublicGameState,
  type PublicStateMessage,
  type PublicWallGroup,
  type PublicWallPlay,
} from '@only-connect/shared';
import { Background, TeamBar, WallGrid, WallLives, WallTimer, wallProgress } from '../../components';
import { playSfx } from '../../lib/sfx';
import './WallView.css';

export interface WallViewProps {
  /** Latest public state (null until the first load). */
  state: PublicStateMessage | null;
  /** Server time in ms (from useServerNow) — drives the countdown. */
  now: number;
  onSelect: (tileId: number) => void;
  /** True while a wall:select ack is pending; taps are ignored meanwhile. */
  selecting: boolean;
  /** Transient message, e.g. the ack error "time is up". */
  notice?: string | null;
  /** Socket connectivity; shows a "Reconnecting" pill when false. */
  connected?: boolean;
}

/** Width / height of the 4×4 box (the show's tiles are 210×120 plus gaps). */
const GRID_RATIO = 1.75;

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

interface FitSize {
  width: number;
  height: number;
}

/**
 * Largest box with the given aspect ratio that fits in the board once its other children (team bar, timer
 * row, connections list) have taken their height. Measuring the board rather than a stretchy middle area lets
 * the whole column be centred as one unit when the grid is width-limited (portrait tablets).
 */
function useFitBox(ratio: number, layoutKey: string): [RefObject<HTMLDivElement>, FitSize | null] {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<FitSize | null>(null);

  useLayoutEffect(() => {
    const board = ref.current;
    if (!board) return undefined;
    const measure = () => {
      const rect = board.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const cs = window.getComputedStyle(board);
      const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
      const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
      const gap = parseFloat(cs.rowGap) || 0;
      let others = 0;
      let count = 0;
      for (const child of Array.from(board.children)) {
        count += 1;
        if (child instanceof HTMLElement && child.dataset.fitArea !== undefined) continue;
        others += child.getBoundingClientRect().height;
      }
      const availW = rect.width - padX;
      const availH = rect.height - padY - others - gap * Math.max(0, count - 1);
      if (availW <= 0 || availH <= 0) return;
      const width = Math.floor(Math.min(availW, availH * ratio));
      const height = Math.floor(width / ratio);
      setSize((prev) => (prev && prev.width === width && prev.height === height ? prev : { width, height }));
    };
    measure();
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    if (observer) {
      observer.observe(board);
      for (const child of Array.from(board.children)) observer.observe(child);
    }
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [ratio, layoutKey]);

  return [ref, size];
}

/** Tile order + solved state: the only changes that should start a FLIP glide. */
function tileOrderKey(play: PublicWallPlay): string {
  return play.tiles.map((t) => (t.colour === null ? String(t.id) : `${t.id}:${t.colour}`)).join(',');
}

/**
 * FLIP animation for the tiles: when the engine re-orders them (a solved group moves to the top rows)
 * each tile glides from its previous position to the new one instead of jumping.
 *
 * Measures only when `layoutKey` changes (tile order / solved state / fitted size), never on the 250 ms clock
 * ticks: measuring on every render read mid-glide rects (getBoundingClientRect includes the transform) and
 * restarted the transition from a wrong offset on every tick, which showed as a stutter. Any glide still
 * running when a new order arrives is finished first so the rects are real layout positions.
 */
function useFlipTiles(ref: RefObject<HTMLElement>, layoutKey: string): void {
  const previous = useRef<Map<string, DOMRect> | null>(null);
  const previousBox = useRef<{ w: number; h: number } | null>(null);
  const running = useRef<Array<() => void>>([]);

  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    for (const finish of running.current.splice(0)) finish();

    const box = root.getBoundingClientRect();
    const sameBox =
      previousBox.current !== null &&
      Math.abs(previousBox.current.w - box.width) < 1 &&
      Math.abs(previousBox.current.h - box.height) < 1;
    const tiles = Array.from(root.querySelectorAll<HTMLElement>('[data-tile-id]'));
    const next = new Map<string, DOMRect>();
    for (const el of tiles) next.set(el.dataset.tileId ?? '', el.getBoundingClientRect());
    const from = previous.current;

    if (from && sameBox) {
      for (const el of tiles) {
        const id = el.dataset.tileId ?? '';
        const was = from.get(id);
        const is = next.get(id);
        if (!was || !is) continue;
        const dx = was.left - is.left;
        const dy = was.top - is.top;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
        el.style.transition = 'none';
        el.style.transform = `translate(${dx}px, ${dy}px)`;
        el.style.zIndex = '3';
        el.style.willChange = 'transform';
        void el.offsetWidth; // flush so the transition starts from the old position
        el.style.transition = 'transform 540ms cubic-bezier(0.22, 0.8, 0.2, 1)';
        el.style.transform = '';
        let cleared = false;
        let timer = 0;
        const clear = () => {
          if (cleared) return;
          cleared = true;
          window.clearTimeout(timer);
          el.removeEventListener('transitionend', onEnd);
          // Land on the final position without starting the tile's own 120 ms transform transition (matters
          // when a glide is cut short because a new order arrived mid-flight: the rects measured next must be
          // the untransformed layout positions).
          el.style.transition = 'none';
          el.style.transform = '';
          void el.offsetWidth;
          el.style.transition = '';
          el.style.zIndex = '';
          el.style.willChange = '';
        };
        const onEnd = (e: TransitionEvent) => {
          if (e.target === el && e.propertyName === 'transform') clear();
        };
        el.addEventListener('transitionend', onEnd);
        timer = window.setTimeout(clear, 700);
        running.current.push(clear);
      }
    }
    previous.current = next;
    previousBox.current = { w: box.width, h: box.height };
  }, [ref, layoutKey]);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatClock(seconds: number): string {
  const s = Math.max(0, seconds);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

function endReasonText(play: PublicWallPlay): { title: string; sub: string } {
  switch (play.endReason) {
    case 'complete':
      return { title: 'Wall complete!', sub: 'All four groups found' };
    case 'lives':
      return { title: 'No lives left', sub: 'The wall is frozen' };
    case 'time':
    default:
      return { title: "Time's up", sub: 'The wall is frozen' };
  }
}

function endReasonShort(play: PublicWallPlay): string {
  switch (play.endReason) {
    case 'complete':
      return 'complete';
    case 'lives':
      return 'out of lives';
    case 'time':
      return "time's up";
    default:
      return '';
  }
}

function groupsInSolveOrder(play: PublicWallPlay): PublicWallGroup[] {
  return play.groups
    .filter((g) => g.solvedOrder !== null)
    .sort((a, b) => (a.solvedOrder as number) - (b.solvedOrder as number));
}

function foundCount(play: PublicWallPlay): number {
  return play.groups.filter((g) => g.foundByTeam).length;
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function Idle({ kicker, title, sub, dots = true }: { kicker: string; title: string; sub: string; dots?: boolean }) {
  return (
    <div className="wallpanel__idle" role="status" aria-live="polite">
      <div className="wallpanel__idle-kicker">{kicker}</div>
      <h1 className="wallpanel__idle-title">{title}</h1>
      <p className="wallpanel__idle-sub">{sub}</p>
      {dots && (
        <div className="wallpanel__idle-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </div>
      )}
    </div>
  );
}

const ConnectionsList = memo(function ConnectionsList({ play }: { play: PublicWallPlay }) {
  const groups = groupsInSolveOrder(play);
  return (
    <ol className="wallboard__groups" aria-label="connections">
      {groups.map((g) => {
        const order = g.solvedOrder as number;
        const asking = play.stage === 'resolving' && play.resolvingGroup === order;
        const style = { '--g': WALL_GROUP_COLOURS[order] } as CSSProperties;
        return (
          <li key={g.index} className={`wallboard__group${asking ? ' is-asking' : ''}`} style={style}>
            <span className="wallboard__group-index" aria-hidden="true">
              {order + 1}
            </span>
            <span className={`wallboard__group-text${g.connection === null ? ' is-pending' : ''}`}>
              {g.connection ?? (asking ? 'What connects these?' : '…')}
            </span>
            {!g.foundByTeam && <span className="wallboard__group-tag">revealed</span>}
            {g.connectionCorrect !== null && (
              <span
                className={`wallboard__group-mark ${g.connectionCorrect ? 'is-correct' : 'is-wrong'}`}
                aria-label={g.connectionCorrect ? 'correct' : 'incorrect'}
              >
                {g.connectionCorrect ? '✓' : '✗'}
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
});

interface BoardProps {
  game: PublicGameState;
  play: PublicWallPlay;
  now: number;
  onSelect: (tileId: number) => void;
  selecting: boolean;
}

function Board({ game, play, now, onSelect, selecting }: BoardProps) {
  const live = play.stage === 'live';
  const teamName = game.teams[play.team].name;
  const showList = play.stage === 'resolving' || play.stage === 'done';
  const showAward = play.stage === 'done' && play.awarded !== null;
  const [boardRef, fit] = useFitBox(GRID_RATIO, `${showList}:${showAward}`);
  const gridRef = useRef<HTMLDivElement>(null);
  useFlipTiles(gridRef, `${tileOrderKey(play)}|${fit ? `${fit.width}x${fit.height}` : ''}`);

  // Timer: while live it follows the server clock; once frozen it stays where it stopped (`endedAt` is the
  // server time of the freeze, so a panel loaded afterwards shows the same bar).
  const liveProgress = wallProgress(play, now);
  const progress = live
    ? liveProgress
    : play.stage === 'ready'
      ? 0
      : play.endReason === 'time'
        ? 1
        : wallProgress(play, play.endedAt ?? Math.min(now, play.endsAt ?? now));
  const secondsLeft = wallSecondsRemaining(play, now);

  // Client-side guard (the server checks too): taps only count while live and before endsAt, so a panel whose
  // clock has run out does not fire selects in the gap before the server's wall:timeUp broadcast arrives.
  const expired = play.endsAt !== null && now >= play.endsAt;
  const acceptsTaps = live && !expired;
  // The tap sound is played here, on the panel, the moment a tap is accepted (SPEC §4: `wallBtnClick` locally
  // on the /wall tap): waiting for the server's broadcast would put the click a round trip behind the finger.
  // The panel is touched by the players, so audio is already unlocked; a refused play is only logged.

  // Pointer-down selection (snappier than click on a touch panel); the click path stays for keyboards.
  const suppressClickUntil = useRef(0);
  // Re-entrancy (one tap in flight at a time) is enforced synchronously by the container's ref guard in
  // onSelect; `selecting` only drives the busy styling. Checking the prop here dropped taps that landed in the
  // few milliseconds between the previous ack and React's re-render (seen as a lost tile on a quick team).
  const tap = (tileId: number) => {
    if (!acceptsTaps) return;
    playSfx('wallBtnClick');
    onSelect(tileId);
  };
  // Stable identity so the memoised WallGrid (16 tiles) is not re-rendered by the 250 ms clock ticks.
  const tapRef = useRef(tap);
  tapRef.current = tap;
  const onClickSelect = useCallback((tileId: number) => {
    if (performance.now() < suppressClickUntil.current) return;
    tapRef.current(tileId);
  }, []);
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!acceptsTaps) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const el = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-tile-id]');
    if (!el || el.classList.contains('is-disabled')) return;
    const tileId = Number(el.dataset.tileId);
    if (!Number.isInteger(tileId)) return;
    suppressClickUntil.current = performance.now() + 700;
    tap(tileId);
  };

  const boardStyle = fit
    ? ({ '--wall-w': `${fit.width}px`, '--wall-h': `${fit.height}px` } as CSSProperties)
    : undefined;
  const found = foundCount(play);
  const frozen = play.stage === 'frozen';
  const reason = endReasonText(play);

  return (
    <div className="wallboard" data-stage={play.stage} style={boardStyle} ref={boardRef}>
      <div className="wallboard__head">
        {/* In the team's colour (V3.2): with up to four teams the bar is what tells a panel whose wall it is. */}
        <TeamBar size="sm" className="wallboard__team" tone={play.team}>
          {teamName}
        </TeamBar>
      </div>

      <div className="wallboard__area" data-fit-area="">
        <div
          ref={gridRef}
          className={`wallboard__fit${acceptsTaps ? '' : ' is-inert'}${selecting ? ' is-busy' : ''}`}
          onPointerDown={acceptsTaps ? onPointerDown : undefined}
          aria-busy={selecting || undefined}
        >
          <WallGrid
            tiles={play.tiles}
            selected={play.selected}
            lastWrong={play.lastWrong}
            wrongKey={game.version}
            onSelect={acceptsTaps ? onClickSelect : undefined}
            interactive={acceptsTaps}
          />
          {frozen && (
            <div
              className={`wallboard__overlay${play.endReason === 'complete' ? ' wallboard__overlay--complete' : ''}`}
              role="status"
              aria-live="assertive"
            >
              <div className="wallboard__overlay-text">{reason.title}</div>
              <div className="wallboard__overlay-sub">{reason.sub}</div>
            </div>
          )}
        </div>
      </div>

      <div className="wallboard__foot">
        <WallTimer progress={progress} secondsLeft={live ? secondsLeft : undefined} />
        <div className="wallboard__meta">
          <div className="wallboard__meta-left">
            <WallLives lives={play.lives} />
            <span className="wallboard__found">
              {found}/4 groups
            </span>
          </div>
          <div className="wallboard__meta-right">
            {live ? (
              <span className={`wallboard__clock${secondsLeft <= 10 ? ' is-low' : ''}`} aria-live="off">
                {formatClock(secondsLeft)}
              </span>
            ) : (
              <span className="wallboard__reason">{endReasonShort(play)}</span>
            )}
          </div>
        </div>
      </div>

      {showList && <ConnectionsList play={play} />}

      {showAward && play.awarded && (
        <div className="wallboard__award" role="status">
          {teamName} score {play.awarded.total} point{play.awarded.total === 1 ? '' : 's'}
          <small>
            {play.awarded.groups} for groups · {play.awarded.connections} for connections
            {play.awarded.bonus > 0 ? ` · ${play.awarded.bonus} bonus` : ''}
          </small>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

export function WallView({ state, now, onSelect, selecting, notice = null, connected = true }: WallViewProps) {
  const game: PublicGameState | null = state && state.phase !== 'none' ? state : null;
  const play = game?.wall?.current ?? null;

  let body: ReactNode;
  if (!game || !play) {
    body = (
      <Idle
        kicker="Only Connect"
        title="Connecting Wall"
        sub={state === null ? 'Connecting to the game…' : 'Waiting for the game master…'}
      />
    );
  } else if (play.stage === 'ready') {
    // Chosen but not started: the public projection sends `tiles: []` here (SPEC §3.3, nobody sees the tiles
    // before `wall:start`), so the Board — which lays the grid out from `play.tiles` — is not mounted at all.
    // (It would not crash on an empty list either: WallGrid simply maps over the tiles it is given.)
    body = (
      <Idle
        kicker="Get ready"
        title={game.teams[play.team].name}
        sub="The wall will start when the game master is ready"
      />
    );
  } else {
    body = <Board game={game} play={play} now={now} onSelect={onSelect} selecting={selecting} />;
  }

  return (
    <div className="screen wallpanel" data-stage={play?.stage ?? 'idle'}>
      <Background variant="blue">
        {body}
        {!connected && <div className="wallpanel__conn">Reconnecting</div>}
        {notice && play?.stage !== 'frozen' && (
          <div className="wallpanel__notice" role="alert">
            {notice}
          </div>
        )}
      </Background>
    </div>
  );
}

export default WallView;
