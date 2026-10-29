/**
 * Embedded start (docs/DESKTOP.md §4): the whole API — PGlite database, media directory, the built client
 * and socket.io — running inside another process (the Electron main process of the Windows app) without
 * touching `process.env`, signal handlers or `process.exit`.
 *
 *   const server = await startEmbedded({ port: 80, dataDir, clientDir, migrationsDir, ... });
 *   server.stats();                       // who is connected, which game is on
 *   const off = server.onStatsChange(cb); // coalesced (>= 250 ms) on connect / disconnect / state change
 *   await server.close();                 // resolves when the port is free; startEmbedded() may be called again
 *
 * Binding failures reject with the Node error (`.code` is 'EADDRINUSE' or 'EACCES').
 */
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { activeTeams } from '@only-connect/shared';
import { loadConfig, setConfig } from './config.js';
import { closeDatabase, setMigrationsDir } from './db.js';
import { boot, createApp } from './server.js';
import type { AdminNamespace, PublicServer } from './sockets/index.js';
import { resetStorage } from './storage.js';

export interface EmbeddedOptions {
  port: number; // 1..65535
  host?: string; // default '0.0.0.0'
  dataDir: string; // PGLITE_DIR = <dataDir>/db, MEDIA_DIR = <dataDir>/media (created)
  clientDir: string; // SERVE_CLIENT_DIR
  migrationsDir: string; // where the .sql files are in this bundle
  adminUsername: string;
  adminPassword: string;
  jwtSecret: string; // >= 8 chars
  logLevel?: string; // default 'info'
  logStream?: NodeJS.WritableStream; // pino destination; default stdout
}

export interface EmbeddedStats {
  startedAt: number; // epoch ms
  connections: { monitor: number; wall: number; button: number; other: number; admin: number };
  players: number; // players currently connected (public namespace sockets with a playerId)
  game: null | {
    phase: string; // GameState.phase
    pack: string | null; // pack name
    teams: Array<{ id: string; name: string; score: number }>; // active teams
  };
}

export interface EmbeddedServer {
  port: number;
  stats(): EmbeddedStats;
  /** Fired on connect / disconnect / state change, coalesced so it runs at most once per 250 ms. */
  onStatsChange(cb: (s: EmbeddedStats) => void): () => void;
  /** Idle the store, close the app and the database; resolves when the port is free. */
  close(): Promise<void>;
}

/** How long a burst of changes is collected before `onStatsChange` listeners run. */
export const STATS_COALESCE_MS = 250;

function invalid(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: 'EINVAL' });
}

/** Make sure a listen failure carries its `.code` (Fastify passes Node's error through; this is a safety net). */
function withCode(err: unknown): Error {
  const e = err instanceof Error ? err : new Error(String(err));
  const coded = e as Error & { code?: string };
  if (!coded.code) {
    if (/EADDRINUSE/.test(e.message)) coded.code = 'EADDRINUSE';
    else if (/EACCES/.test(e.message)) coded.code = 'EACCES';
  }
  return e;
}

/** Rejects with an Error whose `.code` is 'EADDRINUSE' or 'EACCES' when the port cannot be bound. */
export async function startEmbedded(opts: EmbeddedOptions): Promise<EmbeddedServer> {
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) throw invalid(`port must be 1..65535 (got ${opts.port})`);
  if (typeof opts.jwtSecret !== 'string' || opts.jwtSecret.length < 8) throw invalid('jwtSecret must be at least 8 characters');
  if (!opts.dataDir || !opts.clientDir || !opts.migrationsDir) throw invalid('dataDir, clientDir and migrationsDir are required');

  const host = opts.host ?? '0.0.0.0';
  const dbDir = path.join(opts.dataDir, 'db');
  const mediaDir = path.join(opts.dataDir, 'media');
  await mkdir(dbDir, { recursive: true });
  await mkdir(mediaDir, { recursive: true });

  // The config is built from the options, never from process.env, so the host application stays in charge.
  const cfg = loadConfig({
    NODE_ENV: 'production',
    PORT: String(opts.port),
    HOST: host,
    LOG_LEVEL: opts.logLevel ?? 'info',
    DATABASE_DRIVER: 'pglite',
    PGLITE_DIR: dbDir,
    STORAGE_DRIVER: 'fs',
    MEDIA_DIR: mediaDir,
    SERVE_CLIENT_DIR: opts.clientDir,
    ADMIN_USERNAME: opts.adminUsername,
    ADMIN_PASSWORD: opts.adminPassword,
    JWT_SECRET: opts.jwtSecret,
  });
  // A previous embedded server of this process (stop/start from the window) left the driver singletons
  // closed; a failed start may have left them open. Either way start from nothing.
  await closeDatabase();
  await resetStorage();
  setConfig(cfg);
  setMigrationsDir(opts.migrationsDir);

  const app = await createApp({ logLevel: opts.logLevel ?? 'info', logStream: opts.logStream });
  try {
    await boot(app);
    await app.listen({ host, port: opts.port });
  } catch (err) {
    await app.deps.store.idle().catch(() => undefined);
    await app.close().catch(() => undefined);
    await closeDatabase().catch(() => undefined);
    await resetStorage().catch(() => undefined);
    throw withCode(err);
  }

  const startedAt = Date.now();
  const store = app.deps.store;
  const io = app.io as unknown as PublicServer;
  const adminNs = io.of('/admin') as unknown as AdminNamespace;

  const stats = (): EmbeddedStats => {
    const connections = { monitor: 0, wall: 0, button: 0, other: 0, admin: adminNs.sockets.size };
    let players = 0;
    for (const socket of io.sockets.sockets.values()) {
      const screen = socket.data.screen;
      if (screen === 'monitor' || screen === 'wall' || screen === 'button') connections[screen] += 1;
      else connections.other += 1;
      if (socket.data.playerId) players += 1;
    }
    const state = store.getState();
    const game: EmbeddedStats['game'] = state
      ? {
          phase: state.phase,
          pack: state.pack?.name ?? null,
          teams: activeTeams(state).map((id) => ({ id, name: state.teams[id]?.name ?? id, score: state.teams[id]?.score ?? 0 })),
        }
      : null;
    return { startedAt, connections, players, game };
  };

  const listeners = new Set<(s: EmbeddedStats) => void>();
  let pending: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  const schedule = () => {
    if (closed || pending !== null) return;
    pending = setTimeout(() => {
      pending = null;
      if (closed || listeners.size === 0) return;
      const snapshot = stats();
      for (const cb of listeners) {
        try {
          cb(snapshot);
        } catch (err) {
          app.log.warn(`[embed] stats listener failed: ${(err as Error).message}`);
        }
      }
    }, STATS_COALESCE_MS);
  };
  const onConnection = (socket: { on(event: 'disconnect', cb: () => void): unknown }) => {
    schedule();
    socket.on('disconnect', schedule);
  };
  io.on('connection', onConnection);
  adminNs.on('connection', onConnection);
  const unsubscribe = store.subscribe(schedule);

  let closing: Promise<void> | null = null;
  const close = (): Promise<void> => {
    if (closing) return closing;
    closing = (async () => {
      closed = true;
      if (pending !== null) {
        clearTimeout(pending);
        pending = null;
      }
      unsubscribe();
      io.off('connection', onConnection);
      adminNs.off('connection', onConnection);
      listeners.clear();
      await store.idle();
      await app.close();
      await closeDatabase();
      await resetStorage();
    })();
    return closing;
  };

  return {
    port: opts.port,
    stats,
    onStatsChange(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    close,
  };
}
