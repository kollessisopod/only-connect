/**
 * Object store facade (docs/DESKTOP.md §3.2). The routes and the seeder only see `ObjectStore`; which
 * driver answers follows `config().STORAGE_DRIVER`:
 *
 *   s3   MinIO / any S3-compatible bucket (the compose deployment)   -> storage/s3.ts
 *   fs   files under MEDIA_DIR (the Windows app)                     -> storage/fs.ts
 *
 * The S3 driver (and the AWS SDK with it) is only loaded when it is used.
 */
import type { Readable } from 'node:stream';
import { config } from './config.js';

export interface PutResult {
  key: string;
  size: number;
}

export interface ObjectStream {
  stream: Readable;
  mime: string;
  /** Length of the returned body (the part, when a range was requested). */
  size: number | null;
  etag: string | null;
  lastModified: Date | null;
  /** `bytes start-end/total` when a range was requested and honoured, else null. */
  contentRange: string | null;
}

export interface GetObjectOptions {
  /** HTTP Range header value (e.g. `bytes=0-1023`), forwarded to the object store. */
  range?: string;
}

export class StorageNotFoundError extends Error {
  readonly code = 'ENOENT';
  constructor(key: string) {
    super(`Object not found: ${key}`);
    this.name = 'StorageNotFoundError';
  }
}

export class StorageRangeError extends Error {
  readonly code = 'ERANGE';
  constructor(key: string) {
    super(`Requested range not satisfiable: ${key}`);
    this.name = 'StorageRangeError';
  }
}

/**
 * The subset of storage operations the routes and the seeder use, so tests can swap in an in-memory store.
 */
export interface ObjectStore {
  putObject(key: string, body: Buffer | Readable, mime: string): Promise<PutResult>;
  getObjectStream(key: string, opts?: GetObjectOptions): Promise<ObjectStream>;
  headObject(key: string): Promise<{ mime: string; size: number | null } | null>;
  deleteObject(key: string): Promise<void>;
}

type S3Module = typeof import('./storage/s3.js');
let s3Module: Promise<S3Module> | null = null;
const s3 = (): Promise<S3Module> => (s3Module ??= import('./storage/s3.js'));

/** The bucket-backed store (the module behind it loads on first call). */
export const s3ObjectStore: ObjectStore = {
  putObject: async (key, body, mime) => (await s3()).putObject(key, body, mime),
  getObjectStream: async (key, opts) => (await s3()).getObjectStream(key, opts),
  headObject: async (key) => (await s3()).headObject(key),
  deleteObject: async (key) => (await s3()).deleteObject(key),
};

type FsModule = typeof import('./storage/fs.js');
let fsModule: Promise<FsModule> | null = null;
const fsDriver = (): Promise<FsModule> => (fsModule ??= import('./storage/fs.js'));

let fsStore: Promise<import('./storage/fs.js').FsObjectStore> | null = null;
function fsObjectStoreInstance(): Promise<import('./storage/fs.js').FsObjectStore> {
  return (fsStore ??= fsDriver().then((m) => new m.FsObjectStore(config().MEDIA_DIR as string)));
}

/** The directory-backed store for `MEDIA_DIR` (created lazily from the config). */
export const fsObjectStore: ObjectStore = {
  putObject: async (key, body, mime) => (await fsObjectStoreInstance()).putObject(key, body, mime),
  getObjectStream: async (key, opts) => (await fsObjectStoreInstance()).getObjectStream(key, opts),
  headObject: async (key) => (await fsObjectStoreInstance()).headObject(key),
  deleteObject: async (key) => (await fsObjectStoreInstance()).deleteObject(key),
};

/** The store the configured driver names. */
export function defaultObjectStore(): ObjectStore {
  return config().STORAGE_DRIVER === 'fs' ? fsObjectStore : s3ObjectStore;
}

/**
 * Make sure the storage exists: the bucket (created when missing, retried while MinIO starts) or the media
 * directory layout.
 */
export async function ensureStorage(timeoutMs = 60_000, log: (msg: string) => void = console.log): Promise<void> {
  const c = config();
  if (c.STORAGE_DRIVER === 'fs') {
    const store = await fsObjectStoreInstance();
    await store.ensure();
    log(`[storage] media directory "${c.MEDIA_DIR}" ready`);
    return;
  }
  await (await s3()).ensureBucket(timeoutMs, log);
}

/** Alias kept from the S3-only days. */
export const ensureBucket = ensureStorage;

/** Forget the driver instances (the embedded stop, tests): the next use re-reads the config. */
export async function resetStorage(): Promise<void> {
  fsStore = null;
  if (s3Module) (await s3Module).resetS3();
}
