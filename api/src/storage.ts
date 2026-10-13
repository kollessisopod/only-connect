/**
 * Object storage (MinIO / any S3-compatible bucket). Media is always streamed through the API
 * (`GET /api/media/:key`), never linked directly, so the bucket stays private and host-independent.
 */
import { Readable } from 'node:stream';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { config } from './config.js';

let client: S3Client | null = null;

export function getS3(): S3Client {
  if (!client) {
    const c = config();
    client = new S3Client({
      endpoint: c.S3_ENDPOINT,
      region: c.S3_REGION,
      forcePathStyle: true,
      credentials: { accessKeyId: c.S3_ACCESS_KEY, secretAccessKey: c.S3_SECRET_KEY },
    });
  }
  return client;
}

export function bucketName(): string {
  return config().S3_BUCKET;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function errorName(err: unknown): string {
  if (err instanceof S3ServiceException) return err.name;
  if (err && typeof err === 'object' && 'name' in err) return String((err as { name: unknown }).name);
  return '';
}

/**
 * Make sure the bucket exists: HeadBucket, then CreateBucket if missing. "Already exists" responses are
 * ignored. Retries while the object store is still starting (up to `timeoutMs`).
 */
export async function ensureBucket(timeoutMs = 60_000, log: (msg: string) => void = console.log): Promise<void> {
  const s3 = getS3();
  const Bucket = bucketName();
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      try {
        await s3.send(new HeadBucketCommand({ Bucket }));
        log(`[storage] bucket "${Bucket}" ready`);
        return;
      } catch (err) {
        const name = errorName(err);
        const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
        if (name !== 'NotFound' && name !== 'NoSuchBucket' && status !== 404) throw err;
      }
      try {
        await s3.send(new CreateBucketCommand({ Bucket }));
        log(`[storage] created bucket "${Bucket}"`);
      } catch (err) {
        const name = errorName(err);
        if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists') throw err;
      }
      return;
    } catch (err) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`Object store not reachable after ${timeoutMs} ms: ${(err as Error).message}`);
      }
      log(`[storage] waiting for object store (attempt ${attempt}): ${(err as Error).message}`);
      await sleep(Math.min(2_000, remaining));
    }
  }
}

export interface PutResult {
  key: string;
  size: number;
}

/** Upload an object. Streams are uploaded with multipart (lib-storage) so large audio files work. */
export async function putObject(key: string, body: Buffer | Readable, mime: string): Promise<PutResult> {
  const s3 = getS3();
  const Bucket = bucketName();
  let size = 0;
  let stream: Readable;
  if (Buffer.isBuffer(body)) {
    size = body.length;
    stream = Readable.from(body);
  } else {
    stream = body;
  }
  const counter = new Readable({
    read() {
      // pulled by lib-storage
    },
  });
  stream.on('data', (chunk: Buffer | string) => {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    size += buf.length;
    counter.push(buf);
  });
  stream.on('end', () => counter.push(null));
  stream.on('error', (err) => counter.destroy(err));

  const upload = new Upload({
    client: s3,
    params: { Bucket, Key: key, Body: counter, ContentType: mime },
    queueSize: 2,
    partSize: 8 * 1024 * 1024,
    leavePartsOnError: false,
  });
  await upload.done();
  return { key, size };
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

/**
 * Fetch an object as a Node stream plus its metadata. Throws an error with `.code === 'ENOENT'` if missing,
 * and a `StorageRangeError` (`.code === 'ERANGE'`) when a requested range is not satisfiable.
 */
export async function getObjectStream(key: string, opts: GetObjectOptions = {}): Promise<ObjectStream> {
  const s3 = getS3();
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucketName(), Key: key, Range: opts.range }));
    const body = res.Body;
    if (!body) throw notFound(key);
    const stream = body instanceof Readable ? body : Readable.fromWeb(body.transformToWebStream() as never);
    return {
      stream,
      mime: res.ContentType ?? 'application/octet-stream',
      size: typeof res.ContentLength === 'number' ? res.ContentLength : null,
      etag: res.ETag ?? null,
      lastModified: res.LastModified ?? null,
      contentRange: res.ContentRange ?? null,
    };
  } catch (err) {
    const name = errorName(err);
    const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (name === 'NoSuchKey' || name === 'NotFound' || status === 404) throw notFound(key);
    if (name === 'InvalidRange' || status === 416) throw new StorageRangeError(key);
    throw err;
  }
}

/** Metadata only (no body). Returns null if the object does not exist. */
export async function headObject(key: string): Promise<{ mime: string; size: number | null } | null> {
  const s3 = getS3();
  try {
    const res = await s3.send(new HeadObjectCommand({ Bucket: bucketName(), Key: key }));
    return {
      mime: res.ContentType ?? 'application/octet-stream',
      size: typeof res.ContentLength === 'number' ? res.ContentLength : null,
    };
  } catch (err) {
    const name = errorName(err);
    const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (name === 'NoSuchKey' || name === 'NotFound' || status === 404) return null;
    throw err;
  }
}

/** Delete an object (no error if it does not exist). */
export async function deleteObject(key: string): Promise<void> {
  await getS3().send(new DeleteObjectCommand({ Bucket: bucketName(), Key: key }));
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

function notFound(key: string): StorageNotFoundError {
  return new StorageNotFoundError(key);
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

/** The real bucket-backed store. */
export const s3ObjectStore: ObjectStore = { putObject, getObjectStream, headObject, deleteObject };
