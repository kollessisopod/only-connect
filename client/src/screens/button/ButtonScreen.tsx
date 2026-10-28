import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_TEAM_IDS, DEFAULT_TEAM_NAMES, TEAM_IDS, type Ack, type TeamId } from '@only-connect/shared';
import { buzz, getSocket, joinPlayer, leavePlayer, usePublicState } from '../../lib';
import { BUZZER_FILES, preloadSfx, primeBuzzer, type PrimedSfx } from '../../lib/sfx';
import { ButtonView, type BuzzFeedback } from './ButtonView';
import { JoinForm } from './JoinForm';
import { clearPlayer, loadPlayer, savePlayer, type StoredPlayer } from './storage';

/** Ignore presses for this long after a press (double-tap / bounce protection). */
const PRESS_COOLDOWN_MS = 300;

function vibrate(ms: number): void {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') navigator.vibrate(ms);
  } catch {
    /* not supported */
  }
}

function ackCode(res: Ack<unknown>): string | undefined {
  const code = (res as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function buzzFeedback(res: Ack<{ won: boolean }>): BuzzFeedback {
  if (res.ok) return res.data?.won === false ? { kind: 'late', text: 'Too late' } : { kind: 'won', text: 'You buzzed first!' };
  const code = ackCode(res);
  const error = res.error ?? '';
  if (code === 'buzz_lost' || /too late/i.test(error)) return { kind: 'late', text: 'Too late' };
  if (code === 'buzz_locked' || /already buzzed/i.test(error)) return { kind: 'late', text: 'You already buzzed on this clue' };
  if (code === 'buzz_closed' || /closed/i.test(error)) return { kind: 'error', text: 'Buzzers are closed' };
  if (code === 'unknown_player' || /unknown player/i.test(error)) return { kind: 'error', text: 'You are not in the game' };
  if (/timeout/i.test(error)) return { kind: 'error', text: 'No answer from the server' };
  return { kind: 'error', text: error ? error.charAt(0).toUpperCase() + error.slice(1) : 'Something went wrong' };
}

/** /button — the Missing Vowels buzzer phone screen (SPEC §8). */
export function ButtonScreen() {
  const { state, connected } = usePublicState();
  const [stored, setStored] = useState<StoredPlayer | null>(() => loadPlayer());
  /** Prefill for the join form after leaving / a failed join. */
  const [draft, setDraft] = useState<StoredPlayer | null>(null);
  const [joining, setJoining] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [buzzing, setBuzzing] = useState(false);
  const [feedback, setFeedback] = useState<BuzzFeedback | null>(null);

  const storedRef = useRef(stored);
  storedRef.current = stored;
  const joinSeq = useRef(0);
  const cooldownUntil = useRef(0);
  const pressTimers = useRef<{ ack: boolean; cool: boolean }>({ ack: true, cool: true });
  /** The buzzer sound armed by the latest press (see onBuzz); dropped when the screen goes away. */
  const armed = useRef<PrimedSfx | null>(null);
  useEffect(
    () => () => {
      armed.current?.cancel();
      armed.current = null;
    },
    [],
  );

  const join = useCallback(async (player: StoredPlayer) => {
    const seq = ++joinSeq.current;
    setJoining(true);
    setJoinError(null);
    const res = await joinPlayer({ playerId: player.playerId, secret: player.secret, name: player.name, team: player.team });
    if (seq !== joinSeq.current) return; // superseded by a newer join / leave
    setJoining(false);
    if (res.ok && res.data && typeof res.data.playerId === 'string' && res.data.playerId.length > 0) {
      const next: StoredPlayer = { playerId: res.data.playerId, secret: res.data.secret ?? player.secret, name: player.name, team: player.team };
      savePlayer(next);
      setStored(next);
      setDraft(null);
    } else {
      const code = ackCode(res);
      // Removed by the host, or the stored identity belongs to another device: drop it so the next join
      // creates a fresh player (the form stays up so the player sees why).
      const dropIdentity = code === 'player_removed' || code === 'not_owner';
      if (dropIdentity) clearPlayer();
      const message =
        code === 'player_removed'
          ? 'The host removed you from the game. Join again to come back.'
          : code === 'not_owner'
            ? 'This name is already in use on another device. Join again as a new player.'
            : code === 'game_full'
              ? 'The game is full.'
              : code === 'team_locked'
                ? 'Teams cannot be changed during Missing Vowels.'
                : code === 'team_inactive'
                  ? `${DEFAULT_TEAM_NAMES[player.team]} is not playing this game. Pick one of the teams below.`
                  : res.error
                    ? res.error.charAt(0).toUpperCase() + res.error.slice(1)
                    : 'Could not join';
      setJoinError(message);
      // The identity is kept (the form prefills it); a team that is not playing is dropped by the form itself.
      setDraft(dropIdentity ? { playerId: null, secret: null, name: player.name, team: player.team } : player);
      setStored(null);
    }
  }, []);

  // Join on mount (stored player), and re-join whenever the socket (re)connects. A new game is handled by
  // the server (it re-joins every connected phone itself), so this is the only join path.
  useEffect(() => {
    const socket = getSocket();
    const onConnect = () => {
      const p = storedRef.current;
      if (p) void join(p);
    };
    socket.on('connect', onConnect);
    const p = storedRef.current;
    if (p && socket.connected) void join(p);
    return () => {
      socket.off('connect', onConnect);
    };
  }, [join]);

  // Warm the buzzer sounds once the server has confirmed the player, so the first winning buzz plays
  // without a fetch delay. Fire and forget: a failed load just means a silent buzz.
  const joinedId = stored?.playerId ?? null;
  useEffect(() => {
    if (joinedId) preloadSfx(BUZZER_FILES);
  }, [joinedId]);

  // The teams playing this game (V3.2). The server resolves `activeTeams`; the default pair stands in while
  // no game is loaded. Memoised by content so the form's effects do not re-run on every broadcast.
  const game = state && state.phase !== 'none' ? state : null;
  const activeKey = (game?.activeTeams ?? DEFAULT_TEAM_IDS).join(',');
  const activeTeams = useMemo(
    () => activeKey.split(',').filter((id): id is TeamId => (TEAM_IDS as readonly string[]).includes(id)),
    [activeKey],
  );

  // A joined phone whose team is not playing any more (the host started a new game with other teams; the
  // server's own re-join of this phone failed with `team_inactive`) goes back to the form with its name
  // kept, instead of sitting on a dead buzzer. Teams never change inside a game, so this fires only then.
  const storedTeam = stored?.playerId ? stored.team : null;
  const hasGame = game !== null;
  useEffect(() => {
    if (!hasGame || storedTeam === null || activeTeams.includes(storedTeam)) return;
    const p = storedRef.current;
    if (!p) return;
    joinSeq.current += 1; // cancel any in-flight join
    setStored(null);
    setJoining(false);
    setFeedback(null);
    setJoinError(`${DEFAULT_TEAM_NAMES[storedTeam]} is not playing this game. Pick one of the teams below.`);
    setDraft({ playerId: p.playerId, secret: p.secret, name: p.name, team: p.team });
  }, [hasGame, storedTeam, activeTeams]);

  // Clear press feedback once the clue moves on (or the buzzers reopen).
  const vowels = state && state.phase !== 'none' && state.phase === 'vowels' ? state.vowels : null;
  const stage = vowels?.stage ?? 'none';
  const clueKey = vowels ? `${vowels.groupNumber}:${vowels.clueNumber}` : 'none';
  const prevStage = useRef(stage);
  const prevClue = useRef(clueKey);
  useEffect(() => {
    const clueChanged = prevClue.current !== clueKey;
    const reopened = stage === 'clue' && prevStage.current !== 'clue';
    const movedOn = stage !== 'clue' && stage !== 'buzzed';
    prevStage.current = stage;
    prevClue.current = clueKey;
    if (clueChanged || reopened || movedOn) setFeedback(null);
  }, [stage, clueKey]);

  const onJoin = useCallback(
    (name: string, team: TeamId) => {
      const playerId = draft?.playerId ?? null;
      const secret = playerId ? draft?.secret ?? null : null;
      void join({ playerId, secret, name, team });
    },
    [draft, join],
  );

  const onLeave = useCallback(() => {
    const p = storedRef.current;
    joinSeq.current += 1; // cancel any in-flight join
    if (p?.playerId) void leavePlayer(p.playerId);
    clearPlayer();
    setStored(null);
    setJoining(false);
    setJoinError(null);
    setFeedback(null);
    setDraft(p ? { playerId: null, secret: null, name: p.name, team: p.team } : null);
  }, []);

  const onRejoin = useCallback(() => {
    const p = storedRef.current;
    if (p) void join(p);
  }, [join]);

  const settlePress = useCallback((part: 'ack' | 'cool') => {
    pressTimers.current[part] = true;
    if (pressTimers.current.ack && pressTimers.current.cool) setBuzzing(false);
  }, []);

  const onBuzz = useCallback(() => {
    const p = storedRef.current;
    if (!p || !p.playerId) return;
    const t = Date.now();
    if (t < cooldownUntil.current) return;
    cooldownUntil.current = t + PRESS_COOLDOWN_MS;
    pressTimers.current = { ack: false, cool: false };
    setBuzzing(true);
    vibrate(50);
    window.setTimeout(() => settlePress('cool'), PRESS_COOLDOWN_MS);
    // The team's buzzer plays only on the winning buzz (the monitor plays the same sound), never on a lost
    // buzz, a lockout or an error. The answer comes back on the socket, outside the press, where iOS Safari
    // refuses a fresh play(): so the sound is armed here, inside the gesture, and fired on the ack. `p` is
    // the identity that pressed, so the sound follows its team even if the player left since. Which file
    // (and, for green / orange, which speed) a team gets is `BUZZER_SOUNDS` in lib/sfx.ts.
    armed.current?.cancel();
    const sound = primeBuzzer(p.team);
    armed.current = sound;
    void buzz(p.playerId).then((res) => {
      const fb = buzzFeedback(res);
      if (fb.kind === 'won') sound.fire();
      else sound.cancel();
      setFeedback(fb);
      settlePress('ack');
    });
  }, [settlePress]);

  const teamNames = useMemo(() => {
    if (!game) return undefined;
    const names: Partial<Record<TeamId, string>> = {};
    for (const id of activeTeams) names[id] = game.teams[id]?.name ?? DEFAULT_TEAM_NAMES[id];
    return names;
  }, [game, activeTeams]);

  if (!stored || !stored.playerId) {
    // Not joined (or joining for the first time): the form stays up until the server confirms an id.
    return (
      <JoinForm
        initialName={draft?.name ?? stored?.name ?? ''}
        initialTeam={draft?.team ?? stored?.team ?? null}
        teams={activeTeams}
        teamNames={teamNames}
        busy={joining}
        error={joinError}
        connected={connected}
        onJoin={onJoin}
      />
    );
  }

  return (
    <ButtonView
      state={state}
      player={{ playerId: stored.playerId, name: stored.name, team: stored.team }}
      connected={connected}
      joining={joining}
      buzzing={buzzing}
      feedback={feedback}
      onBuzz={onBuzz}
      onLeave={onLeave}
      onRejoin={onRejoin}
    />
  );
}

export default ButtonScreen;
