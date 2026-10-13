/**
 * HTTP route registration (SPEC §5). Everything lives under `/api`.
 */
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../deps.js';
import { registerPublicRoutes } from './public.js';
import { registerAdminRoutes } from './admin.js';

export interface RouteOptions {
  deps: AppDeps;
}

export async function registerRoutes(app: FastifyInstance, opts: RouteOptions): Promise<void> {
  // Probed every few seconds by the container health checks: not worth two log lines each time.
  app.get('/api/health', { logLevel: 'silent' }, async () => ({ ok: true }));
  await registerPublicRoutes(app, opts.deps);
  await registerAdminRoutes(app, opts.deps);
}
