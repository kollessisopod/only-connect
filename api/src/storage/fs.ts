/**
 * The `fs` object store (docs/DESKTOP.md §3.2): media files in a directory, for the Windows app.
 *
 *   <MEDIA_DIR>/objects/<key>        the bytes
 *   <MEDIA_DIR>/meta/<key>.json      { mime, size, createdAt }
 *
 * Keys are validated before anything touches the disk (`validateKey`), so a key can never name a path
 * outside the directory; an invalid key is reported as "not found" exactly like a missing object. Writes go
 * to a temp file in the target directory and are renamed into place, so a crashed upload never leaves a
 * half-written object under its final name. Range requests follow S3's semantics (`parseRange`).
 */
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { GetObjectOptions, ObjectStore, ObjectStream, PutResult } from '../storage.js';
import { StorageNotFoundError, StorageRangeError } from '../storage.js';

export const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
export const MAX_KEY_LENGTH = 200;

/** True when `key` may be used as a relative path under the media directory. */
export function isValidKey(key: string): boolean {
  if (typeof key !== 'string' || key.length === 0 || key.length > MAX_KEY_LENGTH) return false;
  if (!KEY_RE.test(key)) return false;
  return !key.split('/').some((segment) => segment === '..' || segment === '.');
}

/** The key itself, or a `StorageNotFoundError` for anything that is not a safe relative path. */
export function validateKey(key: string): string {
  if (!isValidKey(key)) throw new StorageNotFoundError(key);
  return key;
}

export interface ByteRange {
  start: number;
  end: number;
}

/**
 * Resolve an HTTP `Range` header against an object of `size` bytes the way S3 does:
 *   `bytes=a-b`  a..min(b, size-1); unsatisfiable when a >= size or a > b
 *   `bytes=a-`   a..size-1;         unsatisfiable when a >= size
 *   `bytes=-n`   the last n bytes (the whole object when n > size); unsatisfiable when n = 0
 * Returns null when the header is absent or not a single `bytes=` range (the request is served in full).
 * Throws `StorageRangeError` when the range is unsatisfiable (HTTP 416).
 */
export function parseRange(header: string | undefined, size: number, key = ''): ByteRange | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  const unsatisfiable = () => new StorageRangeError(key);
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (suffix === 0 || size === 0) throw unsatisfiable();
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(m[1]);
  if (start >= size) throw unsatisfiable();
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (start > end) throw unsatisfiable();
  return { start, end };
}

interface Meta {
  mime: string;
  size: number;
  createdAt: string;
}

/**
 * "No such object": ENOENT, or ENOTDIR when a segment of the key's path is an existing object (a regular file),
 * e.g. `demo/flag.svg/x.png` next to `demo/flag.svg`. S3 answers NoSuchKey for both, so the drivers agree.
 */
function isEnoent(err: unknown): boolean {
  const code = (err as { code?: string }).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** mkdir/rename failing because the key's parent path is an existing object: EEXIST (parent itself) or ENOTDIR (deeper). */
function isParentAnObject(err: unknown): boolean {
  const code = (err as { code?: string }).code;
  return code === 'EEXIST' || code === 'ENOTDIR';
}

export class FsObjectStore implements ObjectStore {
  constructor(private readonly root: string) {}

  get objectsDir(): string {
    return path.join(this.root, 'objects');
  }

  get metaDir(): string {
    return path.join(this.root, 'meta');
  }

  /** Create the directory layout (idempotent). */
  async ensure(): Promise<void> {
    await mkdir(this.objectsDir, { recursive: true });
    await mkdir(this.metaDir, { recursive: true });
  }

  objectPath(key: string): string {
    return path.join(this.objectsDir, ...validateKey(key).split('/'));
  }

  metaPath(key: string): string {
    const parts = validateKey(key).split('/');
    parts[parts.length - 1] = `${parts[parts.length - 1]}.json`;
    return path.join(this.metaDir, ...parts);
  }

  async putObject(key: string, body: Buffer | Readable, mime: string): Promise<PutResult> {
    const target = this.objectPath(key);
    const dir = path.dirname(target);
    try {
      await mkdir(dir, { recursive: true });
    } catch (err) {
      // A key nested under an existing object (`uploads/a` then `uploads/a/b.png`) cannot be a file on disk:
      // the caller's key is at fault, so report it like an invalid key rather than as a server failure.
      if (isParentAnObject(err)) throw new StorageNotFoundError(key);
      throw err;
    }
    const tmp = path.join(dir, `.${path.basename(target)}.${randomBytes(6).toString('hex')}.tmp`);
    let size = 0;
    try {
      const source = Buffer.isBuffer(body) ? Readable.from(body) : body;
      const out = createWriteStream(tmp, { flags: 'wx' });
      source.on('data', (chunk: Buffer | string) => {
        size += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
      });
      await pipeline(source, out);
      await rename(tmp, target);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => undefined);
      // The reverse nesting: the key names a directory that holds other objects (`uploads/a/b.png` exists).
      if ((err as { code?: string }).code === 'EISDIR') throw new StorageNotFoundError(key);
      throw err;
    }
    await this.writeMeta(key, { mime, size, createdAt: new Date().toISOString() });
    return { key, size };
  }

  private async writeMeta(key: string, meta: Meta): Promise<void> {
    const target = this.metaPath(key);
    const dir = path.dirname(target);
    await mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `.${path.basename(target)}.${randomBytes(6).toString('hex')}.tmp`);
    try {
      await writeFile(tmp, JSON.stringify(meta), { flag: 'wx' });
      await rename(tmp, target);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
  }

  private async readMeta(key: string): Promise<Meta | null> {
    try {
      const parsed = JSON.parse(await readFile(this.metaPath(key), 'utf8')) as Partial<Meta>;
      return {
        mime: typeof parsed.mime === 'string' && parsed.mime ? parsed.mime : 'application/octet-stream',
        size: typeof parsed.size === 'number' ? parsed.size : 0,
        createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : new Date(0).toISOString(),
      };
    } catch (err) {
      if (isEnoent(err) || err instanceof SyntaxError) return null;
      throw err;
    }
  }

  async getObjectStream(key: string, opts: GetObjectOptions = {}): Promise<ObjectStream> {
    const file = this.objectPath(key);
    let info;
    try {
      info = await stat(file);
    } catch (err) {
      if (isEnoent(err)) throw new StorageNotFoundError(key);
      throw err;
    }
    if (!info.isFile()) throw new StorageNotFoundError(key);
    const meta = await this.readMeta(key);
    const range = parseRange(opts.range, info.size, key);
    const stream = range ? createReadStream(file, { start: range.start, end: range.end }) : createReadStream(file);
    return {
      stream,
      mime: meta?.mime ?? 'application/octet-stream',
      size: range ? range.end - range.start + 1 : info.size,
      etag: `"${info.size}-${Math.floor(info.mtimeMs)}"`,
      lastModified: info.mtime,
      contentRange: range ? `bytes ${range.start}-${range.end}/${info.size}` : null,
    };
  }

  async headObject(key: string): Promise<{ mime: string; size: number | null } | null> {
    if (!isValidKey(key)) return null;
    try {
      const info = await stat(this.objectPath(key));
      if (!info.isFile()) return null;
      const meta = await this.readMeta(key);
      return { mime: meta?.mime ?? 'application/octet-stream', size: info.size };
    } catch (err) {
      if (isEnoent(err)) return null;
      throw err;
    }
  }

  /** Remove the object and its metadata; a missing object (or a path through an existing object) is not an error. */
  async deleteObject(key: string): Promise<void> {
    if (!isValidKey(key)) return;
    const ignoreMissing = (err: unknown) => {
      if (!isEnoent(err)) throw err;
    };
    await rm(this.objectPath(key), { force: true }).catch(ignoreMissing);
    await rm(this.metaPath(key), { force: true }).catch(ignoreMissing);
  }
}
