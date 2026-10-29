/**
 * Types of the embedded API start, copied from api/src/embed.ts (docs/DESKTOP.md §4). The desktop app loads
 * the esbuild bundle of that module at runtime (dist/server/api.mjs) and codes against this interface; no
 * source is imported across workspaces.
 */
export interface EmbeddedOptions {
  port: number;                      // 1..65535
  host?: string;                     // default '0.0.0.0'
  dataDir: string;                   // PGLITE_DIR = <dataDir>/db, MEDIA_DIR = <dataDir>/media (created)
  clientDir: string;                 // SERVE_CLIENT_DIR
  migrationsDir: string;             // where the .sql files are in this bundle
  adminUsername: string;
  adminPassword: string;
  jwtSecret: string;                 // ≥ 8 chars
  logLevel?: string;                 // default 'info'
  logStream?: NodeJS.WritableStream; // pino destination; default stdout
}

export interface EmbeddedStats {
  startedAt: number;                 // epoch ms
  connections: { monitor: number; wall: number; button: number; other: number; admin: number };
  players: number;                   // players currently connected (public namespace sockets with a playerId)
  game: null | {
    phase: string;                   // GameState.phase
    pack: string | null;             // pack name
    teams: Array<{ id: string; name: string; score: number }>; // active teams
  };
}

export interface EmbeddedServer {
  port: number;
  stats(): EmbeddedStats;
  onStatsChange(cb: (s: EmbeddedStats) => void): () => void; // fired on connect/disconnect/state change, coalesced ≥ 250 ms
  close(): Promise<void>;                                     // idle store, close app + database; resolves when the port is free
}

/** Shape of the bundle module: rejects with an Error whose `.code` is 'EADDRINUSE' or 'EACCES' when the port cannot be bound. */
export interface EmbedModule {
  startEmbedded(opts: EmbeddedOptions): Promise<EmbeddedServer>;
}
