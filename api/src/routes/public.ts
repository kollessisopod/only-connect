/**
 * Public routes: the initial public state and media streaming from the bucket (SPEC §5).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppDeps } from '../deps.js';
import { StorageNotFoundError, StorageRangeError } from '../storage.js';

export const MEDIA_CACHE_CONTROL = 'public, max-age=86400';
/**
 * Media objects are only ever embedded (<img>, <audio>), where a CSP on the response is irrelevant; when one
 * is opened as a top-level document (an uploaded SVG, say) this sandboxes it so nothing inside can run
 * script in the app's origin. nosniff alone does not do that for a genuine image/svg+xml.
 */
export const MEDIA_CSP = "default-src 'none'; sandbox";

/** Object keys are `prefix/name.ext` paths: no empty segments, no `.`/`..`, a conservative character set. */
export function parseMediaKey(raw: string | undefined): string | null {
  if (!raw) return null;
  let key = raw;
  if (key.includes('%')) {
    try {
      key = decodeURIComponent(key);
    } catch {
      return null;
    }
  }
  if (key.length > 500 || key.includes('\\') || key.includes('\0')) return null;
  const segments = key.split('/');
  for (const s of segments) {
    if (s.length === 0 || s === '.' || s === '..') return null;
    if (!/^[A-Za-z0-9][A-Za-z0-9._ @+()-]*$/.test(s)) return null;
  }
  return key;
}

function notFound(reply: FastifyReply, key: string): FastifyReply {
  return reply.code(404).send({ error: `Media not found: ${key}`, code: 'not_found' });
}

export async function registerPublicRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.get('/api/state', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return deps.store.getPublic();
  });

  const resolveKey = (request: FastifyRequest, reply: FastifyReply): string | null => {
    const key = parseMediaKey((request.params as { '*'?: string })['*']);
    if (!key) {
      reply.code(404).send({ error: 'Media not found', code: 'not_found' });
      return null;
    }
    return key;
  };

  // HEAD is registered before GET so Fastify does not synthesise one from the streaming GET handler.
  app.head('/api/media/*', async (request, reply) => {
    const key = resolveKey(request, reply);
    if (!key) return reply;
    const head = await deps.objects.headObject(key);
    if (!head) return notFound(reply, key);
    reply
      .header('Content-Type', head.mime)
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Security-Policy', MEDIA_CSP)
      .header('Cache-Control', MEDIA_CACHE_CONTROL)
      .header('Accept-Ranges', 'bytes');
    if (head.size !== null) reply.header('Content-Length', String(head.size));
    return reply.code(200).send();
  });

  app.get('/api/media/*', async (request, reply) => {
    const key = resolveKey(request, reply);
    if (!key) return reply;
    const rangeHeader = request.headers.range;
    const range = typeof rangeHeader === 'string' && /^bytes=\d*-\d*$/.test(rangeHeader.trim()) ? rangeHeader.trim() : undefined;
    try {
      const obj = await deps.objects.getObjectStream(key, range ? { range } : undefined);
      // nosniff: the browser must trust the stored mime; the CSP sandboxes anything that is navigated to as
      // a document (see MEDIA_CSP).
      reply
        .header('Content-Type', obj.mime)
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Security-Policy', MEDIA_CSP)
        .header('Cache-Control', MEDIA_CACHE_CONTROL)
        .header('Accept-Ranges', 'bytes')
        .header('Content-Disposition', 'inline');
      if (obj.etag) reply.header('ETag', obj.etag);
      if (obj.lastModified) reply.header('Last-Modified', obj.lastModified.toUTCString());
      if (obj.size !== null) reply.header('Content-Length', String(obj.size));
      if (range && obj.contentRange) {
        reply.header('Content-Range', obj.contentRange);
        reply.code(206);
      } else {
        reply.code(200);
      }
      return reply.send(obj.stream);
    } catch (err) {
      if (err instanceof StorageNotFoundError || (err as { code?: string }).code === 'ENOENT') return notFound(reply, key);
      if (err instanceof StorageRangeError || (err as { code?: string }).code === 'ERANGE') {
        return reply.code(416).send({ error: 'Requested range not satisfiable', code: 'range_not_satisfiable' });
      }
      throw err;
    }
  });
}
