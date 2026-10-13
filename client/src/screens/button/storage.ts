import { TEAM_IDS, type TeamId } from '@only-connect/shared';

export const PLAYER_STORAGE_KEY = 'oc.player';

export interface StoredPlayer {
  /** Server-assigned id; null until the first successful join. */
  playerId: string | null;
  /** Proof of ownership of `playerId` (from the join ack); null until the first successful join. */
  secret: string | null;
  name: string;
  team: TeamId;
}

function isTeam(value: unknown): value is TeamId {
  return typeof value === 'string' && (TEAM_IDS as readonly string[]).includes(value);
}

export function loadPlayer(): StoredPlayer | null {
  try {
    const raw = window.localStorage.getItem(PLAYER_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const obj = parsed as Record<string, unknown>;
    const name = typeof obj.name === 'string' ? obj.name.trim() : '';
    if (!name || !isTeam(obj.team)) return null;
    const playerId = typeof obj.playerId === 'string' && obj.playerId.length > 0 ? obj.playerId : null;
    const secret = typeof obj.secret === 'string' && obj.secret.length > 0 ? obj.secret : null;
    return { playerId, secret, name, team: obj.team };
  } catch {
    return null;
  }
}

export function savePlayer(player: StoredPlayer): void {
  try {
    window.localStorage.setItem(PLAYER_STORAGE_KEY, JSON.stringify(player));
  } catch {
    /* storage unavailable (private mode): the session simply will not survive a reload */
  }
}

export function clearPlayer(): void {
  try {
    window.localStorage.removeItem(PLAYER_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
