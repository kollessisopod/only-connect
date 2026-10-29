import type { AdminAction, GameState, MediaRef, Pack, PackSummary } from '@only-connect/shared';
import type { DownloadedFile, PackImportResult } from '../../lib/api';

export interface ActionLogEntry {
  id: number;
  at: number;
  action: AdminAction;
  label: string;
  ok: boolean;
  error?: string;
  /** Round-trip time in ms. */
  tookMs: number;
}

export interface LastError {
  id: number;
  message: string;
}

/** What the game-control page consumes; implemented by `useAdminState` (live) and the dev fixtures (stub). */
export interface AdminStateHook {
  /** Full authoritative GameState, or null when there is no game yet. */
  state: GameState | null;
  /** True once the first state (or "no game") has been received. */
  loaded: boolean;
  /** Admin socket connected. */
  connected: boolean;
  /** Load / socket error (cleared on success). */
  error: string | null;
  /** Error of the most recent failed dispatch (for the toast). */
  lastError: LastError | null;
  clearLastError: () => void;
  /** Sends an action; resolves with the new state, or null when it failed (the error is in `lastError`). */
  dispatch: (action: AdminAction) => Promise<GameState | null>;
  /** Last 20 actions, newest first. */
  log: ActionLogEntry[];
}

/** Pack storage used by the packs pages; implemented over the REST API (live) or in memory (fixtures). */
export interface PacksApi {
  list: () => Promise<PackSummary[]>;
  get: (id: string) => Promise<Pack>;
  create: (name: string) => Promise<Pack>;
  save: (pack: Pack) => Promise<Pack>;
  remove: (id: string) => Promise<void>;
  duplicate: (id: string) => Promise<Pack>;
  upload: (file: File) => Promise<MediaRef>;
  /** The pack as a JSON document (for a backup file). */
  exportJson: (id: string) => Promise<string>;
  /** Creates a new pack from an exported JSON document. */
  importJson: (json: string) => Promise<Pack>;
  /** The pack together with its media files as a `.only-connect.zip` (docs/DESKTOP.md §5). */
  exportBundle: (id: string) => Promise<DownloadedFile>;
  /** Creates a new pack from a `.only-connect.zip` (pack + media) and reports how many media files came with it. */
  importBundle: (file: File) => Promise<PackImportResult>;
}

export const LOG_LIMIT = 20;
