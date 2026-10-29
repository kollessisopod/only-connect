/**
 * Process entry point and app factory.
 *
 *   createApp()  -> Fastify instance with cors + multipart + routes (+ the built client when SERVE_CLIENT_DIR
 *                   is set, docs/DESKTOP.md §3.3), and a socket.io Server attached to the same http server
 *                   (available as `app.io`). `app.deps` holds the store / repositories; tests pass in-memory
 *                   implementations via `opts.deps`.
 *   boot(app)    -> migrate -> ensure storage -> seed demo pack -> load game -> arm game timer (wall /
 *                   question clocks) -> attach sockets. Shared by the CLI start and the embedded start
 *                   (api/src/embed.ts).
 *   start()      -> createApp -> boot -> listen on HOST:PORT; handles SIGTERM/SIGINT.
 */
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { Server as SocketServer } from 'socket.io';
import { allowedOrigins, config, configWarnings } from './config.js';
import { closeDatabase, migrate } from './db.js';
import { createDefaultDeps, type AppDeps } from './deps.js';
import { GameTimer } from './game/timers.js';
import { originAllowed } from './origin.js';
import { registerRoutes } from './routes/index.js';
import { seedDemo } from './seed/index.js';
import { attachSockets } from './sockets/index.js';
import { ensureStorage } from './storage.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** socket.io server bound to this app's http server. */
    io: SocketServer;
    /** Store, repositories and object storage used by the routes. */
    deps: AppDeps;
  }
}

export interface CreateAppOptions {
  /** Pino log level; defaults to LOG_LEVEL from the config. */
  logLevel?: string;
  /** Pino destination (the embedded start writes the window's log file); default stdout. */
  logStream?: NodeJS.WritableStream;
  /** Services to use instead of the Postgres/S3-backed defaults (tests). */
  deps?: AppDeps;
  /** Called after cors/multipart/routes are registered and before the app is returned. */
  onReady?: Array<(app: FastifyInstance) => Promise<void> | void>;
}

/** The client's Content-Security-Policy, identical to client/nginx/default.conf. */
export const CLIENT_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self'; connect-src 'self' ws: wss:; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'";

/**
 * Response headers for a file of the served client at `urlPath` (`/index.html`, `/assets/...`), mirroring
 * the nginx locations: hashed assets and fonts are cached hard, everything else (the HTML above all) gets
 * the security headers and `no-cache`.
 */
export function clientHeaders(urlPath: string): Record<string, string> {
  if (urlPath.startsWith('/assets/')) {
    return { 'Cache-Control': 'public, max-age=604800', 'X-Content-Type-Options': 'nosniff' };
  }
  if (urlPath.startsWith('/fonts/')) {
    return { 'Cache-Control': 'public, max-age=2592000, immutable', 'X-Content-Type-Options': 'nosniff' };
  }
  return {
    'Cache-Control': 'no-cache',
    'Content-Security-Policy': CLIENT_CSP,
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
  };
}

/** True for a request the SPA fallback answers (anything that is not the API or socket.io). */
export function isSpaPath(method: string, url: string): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false;
  const pathname = url.split('?')[0] ?? '';
  return !pathname.startsWith('/api/') && pathname !== '/api' && !pathname.startsWith('/socket.io/') && pathname !== '/socket.io';
}

export async function createApp(opts: CreateAppOptions = {}): Promise<FastifyInstance> {
  const c = config();
  const app = Fastify({
    logger: { level: opts.logLevel ?? c.LOG_LEVEL, ...(opts.logStream ? { stream: opts.logStream } : {}) },
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
  });

  // Same-origin only (plus ALLOWED_ORIGINS): the app is always served from the same host as the API, so no
  // third-party page may read the public state or drive the player endpoints from a visitor's browser.
  const extraOrigins = allowedOrigins(c);
  await app.register(cors, {
    credentials: false,
    delegator: (req, callback) => {
      const origin = req.headers.origin;
      callback(null, { origin: originAllowed(origin, req.headers.host, extraOrigins) ? origin ?? false : false });
    },
  });
  await app.register(multipart, {
    limits: { fileSize: c.MAX_UPLOAD_BYTES, files: 1, fields: 10 },
  });

  // socket.io shares the http server Fastify created. It wraps the existing request listeners and only
  // handles requests under /socket.io/, so Fastify keeps serving everything else.
  const io = new SocketServer(app.server, {
    path: '/socket.io',
    cors: { origin: true, methods: ['GET', 'POST'] },
    allowRequest: (req, callback) => {
      const ok = originAllowed(req.headers.origin, req.headers.host, extraOrigins);
      callback(ok ? null : 'origin not allowed', ok);
    },
    serveClient: false,
    pingInterval: 10_000,
    pingTimeout: 20_000,
    maxHttpBufferSize: 64 * 1024,
  });
  app.decorate('io', io);

  const deps = opts.deps ?? createDefaultDeps(app.log);
  app.decorate('deps', deps);

  app.setErrorHandler((err, _request, reply) => {
    const status = typeof (err as { statusCode?: number }).statusCode === 'number'
      ? (err as { statusCode: number }).statusCode
      : 500;
    if (status >= 500) app.log.error(err);
    // 5xx bodies never echo the underlying error or its driver code (e.g. a Postgres SQLSTATE).
    reply.code(status).send({
      error: status >= 500 ? 'Internal server error' : err.message,
      code: status >= 500 ? 'internal_error' : (err as { code?: string }).code,
    });
  });

  // The built client (docs/DESKTOP.md §3.3): every file of the directory as a route, plus the SPA fallback
  // in the not-found handler below. Nothing of this exists when the variable is unset (compose keeps nginx).
  const clientDir = c.SERVE_CLIENT_DIR ? path.resolve(c.SERVE_CLIENT_DIR) : null;
  if (clientDir) {
    await app.register(fastifyStatic, {
      root: clientDir,
      prefix: '/',
      wildcard: false,
      index: ['index.html'],
      cacheControl: false,
      etag: true,
      lastModified: true,
      setHeaders: (res, filePath) => {
        const urlPath = `/${path.relative(clientDir, filePath).split(path.sep).join('/')}`;
        for (const [name, value] of Object.entries(clientHeaders(urlPath))) res.setHeader(name, value);
      },
    });
  }

  app.setNotFoundHandler((request, reply) => {
    if (clientDir && isSpaPath(request.method, request.url)) {
      reply.headers(clientHeaders('/index.html'));
      return reply.code(200).sendFile('index.html');
    }
    reply.code(404).send({ error: `Route ${request.method} ${request.url} not found`, code: 'not_found' });
  });

  await app.register(registerRoutes, { deps });

  for (const hook of opts.onReady ?? []) await hook(app);

  app.addHook('onClose', async () => {
    await new Promise<void>((resolve) => io.close(() => resolve()));
  });

  return app;
}

/**
 * Everything between "the app exists" and "the app listens": migrations, storage, the demo pack, the saved
 * game, the clocks and the sockets. Shared by `start()` and `startEmbedded()`. The timer and the socket
 * subscription are released in the app's `onClose`.
 */
export async function boot(app: FastifyInstance): Promise<void> {
  const log = (msg: string) => app.log.info(msg);
  await migrate(log);
  await ensureStorage(60_000, log);
  await seedDemo(app.deps, app.log);
  await app.deps.store.load();

  const timer = new GameTimer(app.deps.store, { log: app.log });
  timer.start();
  const sockets = attachSockets(app.io, app.deps.store, app.log);
  app.addHook('onClose', async () => {
    timer.stop();
    sockets.detach();
  });
}

export async function start(): Promise<FastifyInstance> {
  const c = config();
  const app = await createApp();
  for (const warning of configWarnings(c)) app.log.warn(`[config] ${warning}`);

  await boot(app);
  await app.listen({ host: c.HOST, port: c.PORT });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info(`received ${signal}, shutting down`);
    const forceExit = setTimeout(() => {
      app.log.error('shutdown timed out, exiting');
      process.exit(1);
    }, 10_000);
    forceExit.unref();
    try {
      await app.deps.store.idle();
      await app.close();
      await closeDatabase();
      process.exit(0);
    } catch (err) {
      app.log.error(err);
      process.exit(1);
    }
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));

  return app;
}

// Run when executed directly (node dist/server.js), not when imported by tests or the desktop bundle.
const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  const here = new URL(import.meta.url).pathname;
  return here === entry || here.endsWith(entry.replace(/\.ts$/, '.js')) || entry.endsWith(here);
})();

if (invokedDirectly) {
  start().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
