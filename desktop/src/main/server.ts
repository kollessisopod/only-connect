/**
 * Start / stop wrapper around the embedded API (docs/DESKTOP.md §4): loads dist/server/api.mjs once, keeps the
 * ServerState machine of the IPC contract and the latest EmbeddedStats, and tells the main process when either
 * changes.
 */
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import type { EmbedModule, EmbeddedServer, EmbeddedStats } from '../shared/embed';
import type { ServerState, Settings } from '../shared/ipc';
import type { LogBuffer } from './logs';

export interface ServerPaths {
  bundle: string;        // dist/server/api.mjs
  migrationsDir: string; // dist/server/migrations
  clientDir: string;     // dist/client
  dataDir: string;       // <data>/ (db/ and media/ are created inside by the api)
}

export interface ServerControllerEvents {
  state: [ServerState];
  stats: [EmbeddedStats | null];
}

export class ServerController extends EventEmitter<ServerControllerEvents> {
  state: ServerState = { status: 'stopped' };
  private server: EmbeddedServer | null = null;
  private unsubscribeStats: (() => void) | null = null;
  private latestStats: EmbeddedStats | null = null;
  private module: EmbedModule | null = null;
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly paths: ServerPaths, private readonly log: LogBuffer) {
    super();
  }

  get stats(): EmbeddedStats | null {
    return this.latestStats;
  }

  /** Polls the live counters (used by the 2 s ticker: onStatsChange is coalesced and may skip score-only changes). */
  refreshStats(): EmbeddedStats | null {
    if (this.server) {
      try {
        this.latestStats = this.server.stats();
      } catch {
        // keep the last known value
      }
    }
    return this.latestStats;
  }

  /** Start with the given settings; a no-op when the server is already running or starting. Operations are serialised. */
  start(settings: Settings): Promise<void> {
    return this.enqueue(() => this.doStart(settings));
  }

  stop(): Promise<void> {
    return this.enqueue(() => this.doStop());
  }

  restart(settings: Settings): Promise<void> {
    return this.enqueue(async () => {
      await this.doStop();
      await this.doStart(settings);
    });
  }

  private enqueue(op: () => Promise<void>): Promise<void> {
    const run = this.pending.then(op, op);
    this.pending = run.catch(() => undefined);
    return run;
  }

  private setState(next: ServerState): void {
    this.state = next;
    this.emit('state', next);
  }

  private async loadModule(): Promise<EmbedModule> {
    if (!this.module) {
      const mod = (await import(pathToFileURL(this.paths.bundle).href)) as Partial<EmbedModule>;
      if (typeof mod.startEmbedded !== 'function') {
        throw new Error(`${this.paths.bundle} does not export startEmbedded()`);
      }
      this.module = mod as EmbedModule;
    }
    return this.module;
  }

  private async doStart(settings: Settings): Promise<void> {
    if (this.server) return;
    this.setState({ status: 'starting' });
    this.log.note(`starting the server on port ${settings.port}`);
    try {
      const mod = await this.loadModule();
      const server = await mod.startEmbedded({
        port: settings.port,
        host: '0.0.0.0',
        dataDir: this.paths.dataDir,
        clientDir: this.paths.clientDir,
        migrationsDir: this.paths.migrationsDir,
        adminUsername: settings.adminUsername,
        adminPassword: settings.adminPassword,
        jwtSecret: settings.jwtSecret,
        logLevel: 'info',
        logStream: this.log.stream(),
      });
      this.server = server;
      this.latestStats = this.safeStats(server);
      this.unsubscribeStats = server.onStatsChange((s) => {
        this.latestStats = s;
        this.emit('stats', s);
      });
      const startedAt = this.latestStats?.startedAt ?? Date.now();
      this.setState({ status: 'running', port: server.port, startedAt });
      this.emit('stats', this.latestStats);
      this.log.note(`server running on port ${server.port}`);
    } catch (err) {
      const e = err as { code?: unknown; message?: unknown };
      const code = typeof e?.code === 'string' ? e.code : null;
      const message = err instanceof Error ? err.message : String(err);
      this.server = null;
      this.latestStats = null;
      this.setState({ status: 'failed', code, message, port: settings.port });
      this.log.note(`start failed${code ? ` (${code})` : ''}: ${message}`);
    }
  }

  private async doStop(): Promise<void> {
    const server = this.server;
    if (!server) {
      if (this.state.status !== 'failed') this.setState({ status: 'stopped' });
      return;
    }
    this.setState({ status: 'stopping' });
    this.log.note('stopping the server');
    try {
      this.unsubscribeStats?.();
      this.unsubscribeStats = null;
      await server.close();
      this.log.note('server stopped');
    } catch (err) {
      this.log.note(`error while stopping: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.server = null;
      this.latestStats = null;
      this.setState({ status: 'stopped' });
      this.emit('stats', null);
    }
  }

  private safeStats(server: EmbeddedServer): EmbeddedStats | null {
    try {
      return server.stats();
    } catch {
      return null;
    }
  }
}
