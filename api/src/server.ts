/**
 * Process entry point and app factory.
 *
 *   createApp()  -> Fastify instance with cors + multipart + routes, and a socket.io Server attached to the
 *                   same http server (available as `app.io`). `app.deps` holds the store / repositories;
 *                   tests pass in-memory implementations via `opts.deps`.
 *   start()      -> migrate -> ensure bucket -> seed demo pack -> load game -> arm wall timer -> attach
 *                   sockets -> listen on 0.0.0.0:PORT; handles SIGTERM/SIGINT.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { Server as SocketServer } from 'socket.io';
import { allowedOrigins, config, configWarnings } from './config.js';
import { closePool, migrate } from './db.js';
import { createDefaultDeps, type AppDeps } from './deps.js';
import { WallTimer } from './game/timers.js';
import { originAllowed } from './origin.js';
import { registerRoutes } from './routes/index.js';
import { seedDemo } from './seed/index.js';
import { attachSockets } from './sockets/index.js';
import { ensureBucket } from './storage.js';

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
  /** Services to use instead of the Postgres/S3-backed defaults (tests). */
  deps?: AppDeps;
  /** Called after cors/multipart/routes are registered and before the app is returned. */
  onReady?: Array<(app: FastifyInstance) => Promise<void> | void>;
}

export async function createApp(opts: CreateAppOptions = {}): Promise<FastifyInstance> {
  const c = config();
  const app = Fastify({
    logger: { level: opts.logLevel ?? c.LOG_LEVEL },
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

  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({ error: `Route ${request.method} ${request.url} not found`, code: 'not_found' });
  });

  await app.register(registerRoutes, { deps });

  for (const hook of opts.onReady ?? []) await hook(app);

  app.addHook('onClose', async () => {
    await new Promise<void>((resolve) => io.close(() => resolve()));
  });

  return app;
}

export async function start(): Promise<FastifyInstance> {
  const c = config();
  const app = await createApp();
  const log = (msg: string) => app.log.info(msg);
  for (const warning of configWarnings(c)) app.log.warn(`[config] ${warning}`);

  await migrate(log);
  await ensureBucket(60_000, log);
  await seedDemo(app.deps, app.log);
  await app.deps.store.load();

  const timer = new WallTimer(app.deps.store, { log: app.log });
  timer.start();
  const sockets = attachSockets(app.io, app.deps.store, app.log);
  app.addHook('onClose', async () => {
    timer.stop();
    sockets.detach();
  });

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
      await closePool();
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

// Run when executed directly (node dist/server.js), not when imported by tests.
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
