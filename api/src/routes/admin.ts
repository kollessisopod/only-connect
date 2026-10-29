/**
 * Admin routes (SPEC §5): login, game state + actions, pack CRUD, media upload.
 * Everything except `POST /api/admin/login` requires `Authorization: Bearer <jwt>` (see `requireAdmin`).
 */
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { GameError, type MediaRef, type PackSummary } from '@only-connect/shared';
import type { ZodError } from 'zod';
import { checkCredentials, requireAdmin, signToken } from '../auth.js';
import { config } from '../config.js';
import type { AppDeps } from '../deps.js';
import { describeZodError, parseAdminAction } from '../game/schema.js';
import { BundleError, bundleFileName, exportBundle, importBundle, isZipBuffer } from '../packs/bundle.js';
import { clonePack, emptyPack, mediaKeysOf, normalisePackInput, toSummary } from '../packs/repo.js';
import { createPackSchema, loginSchema, packInputSchema } from '../packs/schema.js';
import { loginLimits } from '../ratelimit.js';

export const UPLOAD_PREFIX = 'uploads/';
/** Uploads younger than this are never swept (the editor may not have saved the pack that uses them yet). */
export const SWEEP_MIN_AGE_MS = 60 * 60 * 1000;
/** A `.only-connect.json` sent as multipart is read whole; packs are small, so this is generous. */
export const MAX_IMPORT_JSON_BYTES = 16 * 1024 * 1024;

function badRequest(reply: FastifyReply, error: ZodError, code = 'validation'): FastifyReply {
  return reply.code(400).send({
    error: describeZodError(error),
    code,
    issues: error.issues.slice(0, 20).map((i) => ({ path: i.path.join('.'), message: i.message })),
  });
}

function gameError(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof GameError) return reply.code(400).send({ error: err.message, code: err.code });
  throw err;
}

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/ogg': 'ogg',
  'audio/webm': 'weba',
  'audio/aac': 'aac',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/flac': 'flac',
};

/** File extension for an upload: from the original name when sane, else from the mime type. */
export function uploadExtension(originalName: string, mime: string): string {
  const fromName = path.extname(originalName).replace('.', '').toLowerCase();
  if (/^[a-z0-9]{1,8}$/.test(fromName)) return fromName;
  return EXT_BY_MIME[mime.toLowerCase()] ?? (mime.startsWith('image/') ? 'img' : 'audio');
}

/**
 * Images and audio only. SVG is refused: it is a document format that can carry script, and the clue tiles
 * never need it (the media route also sandboxes everything it serves, this is belt and braces).
 */
export function isAllowedUploadMime(mime: string): boolean {
  const m = mime.toLowerCase();
  if (m.includes('svg') || m.includes('xml') || m.includes('html')) return false;
  return (m.startsWith('image/') || m.startsWith('audio/')) && !m.includes('..');
}

/**
 * Keys that no pack (and not the running game's pack snapshot) references any more, restricted to
 * `uploads/` (seeded demo media is never touched) and to objects older than `minAgeMs`.
 */
export async function orphanMediaKeys(deps: AppDeps, now: number, minAgeMs = SWEEP_MIN_AGE_MS): Promise<string[]> {
  const referenced = new Set<string>();
  for (const pack of await deps.packs.list()) for (const key of mediaKeysOf(pack)) referenced.add(key);
  const game = deps.store.getState();
  if (game) for (const key of mediaKeysOf(game.pack)) referenced.add(key);
  const out: string[] = [];
  for (const m of await deps.media.list()) {
    if (!m.key.startsWith(UPLOAD_PREFIX) || referenced.has(m.key)) continue;
    const age = now - new Date(m.createdAt).getTime();
    if (Number.isFinite(age) && age < minAgeMs) continue;
    out.push(m.key);
  }
  return out;
}

async function deleteMedia(deps: AppDeps, keys: readonly string[]): Promise<number> {
  let n = 0;
  for (const key of keys) {
    await deps.objects.deleteObject(key).catch(() => undefined);
    await deps.media.delete(key);
    n += 1;
  }
  return n;
}

export function mediaUrl(key: string): string {
  return `/api/media/${key.split('/').map(encodeURIComponent).join('/')}`;
}

export async function registerAdminRoutes(app: FastifyInstance, deps: AppDeps): Promise<void> {
  app.post('/api/admin/login', async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body ?? {});
    if (!parsed.success) return badRequest(reply, parsed.error);
    // Brute-force protection: wrong guesses drain a per-client and a global bucket (see ratelimit.ts).
    const client = request.ip;
    const retry = Math.max(loginLimits.perClient.retryAfterSeconds(client), loginLimits.global.retryAfterSeconds('global'));
    if (retry > 0) {
      request.log.warn(`[auth] login throttled for ${client}`);
      return reply.code(429).header('Retry-After', String(retry)).send({ error: `Too many failed logins, try again in ${retry} s`, code: 'rate_limited' });
    }
    const { username, password } = parsed.data;
    if (!checkCredentials(username, password)) {
      loginLimits.perClient.tryTake(client);
      loginLimits.global.tryTake('global');
      request.log.warn(`[auth] failed login for "${username.slice(0, 40)}" from ${client}`);
      return reply.code(401).send({ error: 'Invalid username or password', code: 'bad_credentials' });
    }
    return signToken(username);
  });

  await app.register(async (admin) => {
    admin.addHook('preHandler', requireAdmin);

    admin.get('/api/admin/state', async (_request, reply) => {
      reply.header('Cache-Control', 'no-store').type('application/json; charset=utf-8');
      const state = deps.store.getState();
      return state ? JSON.stringify(state) : 'null';
    });

    admin.post('/api/admin/actions', async (request, reply) => {
      const parsed = parseAdminAction(request.body);
      if (!parsed.ok) return badRequest(reply, parsed.error, 'invalid_action_payload');
      const action = parsed.action;
      try {
        if (action.type === 'game:new') {
          // 2..4 teams (schema-checked); a pack with fewer walls than teams is a 400 `not_enough_walls`.
          return await deps.store.newGame(action.packId, action.teams);
        }
        return await deps.store.dispatch(action, { who: 'admin' });
      } catch (err) {
        return gameError(reply, err);
      }
    });

    // --- packs ---------------------------------------------------------
    admin.get('/api/admin/packs', async (): Promise<PackSummary[]> => {
      const packs = await deps.packs.list();
      return packs.map(toSummary);
    });

    admin.post('/api/admin/packs', async (request, reply) => {
      const parsed = createPackSchema.safeParse(request.body ?? {});
      if (!parsed.success) return badRequest(reply, parsed.error);
      const pack = await deps.packs.insert(emptyPack(parsed.data.name, new Date().toISOString()));
      return reply.code(201).send(pack);
    });

    admin.get<{ Params: { id: string } }>('/api/admin/packs/:id', async (request, reply) => {
      const pack = await deps.packs.get(request.params.id);
      if (!pack) return reply.code(404).send({ error: 'Pack not found', code: 'not_found' });
      return pack;
    });

    admin.put<{ Params: { id: string } }>('/api/admin/packs/:id', async (request, reply) => {
      const parsed = packInputSchema.safeParse(request.body ?? {});
      if (!parsed.success) return badRequest(reply, parsed.error);
      const pack = await deps.packs.replace(request.params.id, parsed.data);
      if (!pack) return reply.code(404).send({ error: 'Pack not found', code: 'not_found' });
      return pack;
    });

    admin.delete<{ Params: { id: string } }>('/api/admin/packs/:id', async (request, reply) => {
      const pack = await deps.packs.get(request.params.id);
      const deleted = pack ? await deps.packs.delete(request.params.id) : false;
      if (!pack || !deleted) return reply.code(404).send({ error: 'Pack not found', code: 'not_found' });
      // Uploads only this pack used go with it (the running game keeps its own pack snapshot and is checked).
      const keys = [...mediaKeysOf(pack)].filter((k) => k.startsWith(UPLOAD_PREFIX));
      if (keys.length > 0) {
        const orphans = new Set(await orphanMediaKeys(deps, Date.now(), 0));
        const removed = await deleteMedia(deps, keys.filter((k) => orphans.has(k)));
        if (removed > 0) request.log.info(`[media] removed ${removed} object(s) with pack ${pack.id}`);
      }
      return reply.code(204).send();
    });

    admin.post<{ Params: { id: string } }>('/api/admin/packs/:id/duplicate', async (request, reply) => {
      const source = await deps.packs.get(request.params.id);
      if (!source) return reply.code(404).send({ error: 'Pack not found', code: 'not_found' });
      const copy = await deps.packs.insert(clonePack(source, new Date().toISOString()));
      return reply.code(201).send(copy);
    });

    // --- export / import (backup, moving packs between instances) ------
    // Two formats: the plain Pack JSON (media stays behind, referenced by key) and the bundle of
    // docs/DESKTOP.md §5 (`.only-connect.zip`: pack JSON + media.json + the media objects).
    admin.get<{ Params: { id: string } }>('/api/admin/packs/:id/export', async (request, reply) => {
      const pack = await deps.packs.get(request.params.id);
      if (!pack) return reply.code(404).send({ error: 'Pack not found', code: 'not_found' });
      return reply
        .header('Content-Disposition', `attachment; filename="${bundleFileName(pack.name, 'json')}"`)
        .type('application/json; charset=utf-8')
        .send(JSON.stringify(pack, null, 2));
    });

    admin.get<{ Params: { id: string } }>('/api/admin/packs/:id/export.zip', async (request, reply) => {
      const pack = await deps.packs.get(request.params.id);
      if (!pack) return reply.code(404).send({ error: 'Pack not found', code: 'not_found' });
      return reply
        .header('Content-Disposition', `attachment; filename="${bundleFileName(pack.name, 'zip')}"`)
        .header('Cache-Control', 'no-store')
        .type('application/zip')
        .send(exportBundle(pack, deps.objects));
    });

    /**
     * Body: the exported Pack JSON (response: the new Pack), or multipart/form-data with a `file` field holding
     * a `.only-connect.json` (same response) or a `.only-connect.zip` (response: `{ pack, imported, skipped, warnings }`).
     * The file is told apart by content, not by name; the multipart cap is MAX_IMPORT_BYTES.
     */
    admin.post('/api/admin/packs/import', async (request, reply) => {
      if (!request.isMultipart()) return importJson(reply, request.body);
      const maxBytes = config().MAX_IMPORT_BYTES;
      let part;
      try {
        part = await request.file({ limits: { fileSize: maxBytes } });
      } catch (err) {
        return importUploadError(reply, err, maxBytes);
      }
      if (!part || part.fieldname !== 'file') return reply.code(400).send({ error: 'Missing "file" field', code: 'missing_file' });
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-import-'));
      const tmp = path.join(dir, 'upload.bin');
      try {
        try {
          await pipeline(part.file, createWriteStream(tmp));
        } catch (err) {
          return importUploadError(reply, err, maxBytes);
        }
        if (part.file.truncated) return reply.code(413).send({ error: `File too large (max ${maxBytes} bytes)`, code: 'file_too_large' });
        const head = Buffer.alloc(4);
        const fh = await fs.open(tmp, 'r');
        try {
          await fh.read(head, 0, 4, 0);
        } finally {
          await fh.close();
        }
        if (!isZipBuffer(head)) {
          const { size } = await fs.stat(tmp);
          if (size > MAX_IMPORT_JSON_BYTES) return reply.code(413).send({ error: `JSON file too large (max ${MAX_IMPORT_JSON_BYTES} bytes)`, code: 'file_too_large' });
          let body: unknown;
          try {
            body = JSON.parse(await fs.readFile(tmp, 'utf8'));
          } catch {
            return reply.code(400).send({ error: 'That file is neither a zip bundle nor valid JSON', code: 'invalid_json' });
          }
          return importJson(reply, body);
        }
        try {
          const result = await importBundle(tmp, deps);
          request.log.info(`[packs] imported bundle "${result.pack.name}" (${result.imported} media file(s), ${result.skipped} skipped)`);
          return reply.code(201).send(result);
        } catch (err) {
          if (err instanceof BundleError) {
            if (err.validation) return badRequest(reply, err.validation, err.code);
            return reply.code(err.status).send({ error: err.message, code: err.code });
          }
          throw err;
        }
      } finally {
        await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    });

    async function importJson(reply: FastifyReply, body: unknown): Promise<FastifyReply> {
      const parsed = packInputSchema.safeParse(body ?? {});
      if (!parsed.success) return badRequest(reply, parsed.error);
      const now = new Date().toISOString();
      const pack = normalisePackInput(randomUUID(), parsed.data, { createdAt: now, updatedAt: now });
      const stored = await deps.packs.insert(pack);
      return reply.code(201).send(stored);
    }

    // --- media housekeeping -----------------------------------------------
    admin.get('/api/admin/media/orphans', async () => {
      const keys = await orphanMediaKeys(deps, Date.now());
      return { keys };
    });

    /** Delete uploads that no pack references any more (older than an hour). */
    admin.post('/api/admin/media/sweep', async (request) => {
      const keys = await orphanMediaKeys(deps, Date.now());
      const removed = await deleteMedia(deps, keys);
      request.log.info(`[media] sweep removed ${removed} orphaned object(s)`);
      return { removed, keys };
    });

    // --- media upload --------------------------------------------------
    admin.post('/api/admin/media', async (request, reply) => {
      if (!request.isMultipart()) {
        return reply.code(400).send({ error: 'Expected multipart/form-data with a "file" field', code: 'not_multipart' });
      }
      let part;
      try {
        part = await request.file();
      } catch (err) {
        return uploadError(reply, err);
      }
      if (!part || part.fieldname !== 'file') {
        return reply.code(400).send({ error: 'Missing "file" field', code: 'missing_file' });
      }
      const mime = (part.mimetype || '').toLowerCase();
      if (!isAllowedUploadMime(mime)) {
        part.file.resume(); // drain so the request completes
        return reply.code(415).send({ error: `Unsupported media type "${part.mimetype}": only images and audio`, code: 'unsupported_media' });
      }
      const originalName = (part.filename || 'upload').slice(0, 255);
      const key = `${UPLOAD_PREFIX}${randomUUID()}.${uploadExtension(originalName, mime)}`;
      let size: number;
      try {
        size = (await deps.objects.putObject(key, part.file, mime)).size;
      } catch (err) {
        await deps.objects.deleteObject(key).catch(() => undefined);
        return uploadError(reply, err);
      }
      if (part.file.truncated) {
        await deps.objects.deleteObject(key).catch(() => undefined);
        return reply.code(413).send({ error: `File too large (max ${config().MAX_UPLOAD_BYTES} bytes)`, code: 'file_too_large' });
      }
      await deps.media.record({ key, mime, size, originalName });
      const ref: MediaRef = { key, url: mediaUrl(key), mime, name: originalName };
      return reply.code(201).send(ref);
    });
  });
}

/** Like `uploadError`, with the bundle cap in the message. */
function importUploadError(reply: FastifyReply, err: unknown, maxBytes: number): FastifyReply {
  if ((err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
    return reply.code(413).send({ error: `File too large (max ${maxBytes} bytes)`, code: 'file_too_large' });
  }
  return uploadError(reply, err);
}

function uploadError(reply: FastifyReply, err: unknown): FastifyReply {
  const code = (err as { code?: string }).code;
  if (code === 'FST_REQ_FILE_TOO_LARGE') {
    return reply.code(413).send({ error: `File too large (max ${config().MAX_UPLOAD_BYTES} bytes)`, code: 'file_too_large' });
  }
  if (code === 'FST_FILES_LIMIT' || code === 'FST_PARTS_LIMIT' || code === 'FST_FIELDS_LIMIT' || code === 'FST_INVALID_MULTIPART_CONTENT_TYPE') {
    return reply.code(400).send({ error: (err as Error).message, code: 'bad_multipart' });
  }
  throw err;
}
