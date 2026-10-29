/**
 * Pack bundles (docs/DESKTOP.md §5): a `<name>.only-connect.zip` that moves a pack *and* its media between
 * instances (Docker ↔ Windows app). Layout, all at the zip root:
 *
 *   manifest.json   { format: "only-connect-pack", version: 1, exportedAt, name, warnings: [] }
 *   pack.json       the Pack exactly as GET /api/admin/packs/:id/export returns it
 *   media.json      [{ key, mime, size, originalName }, …]
 *   media/<key>     one entry per object key the pack's clues reference (uploads/… and seed/… alike)
 *
 * Export streams through yazl (media is pulled from the object store one entry at a time); import reads the
 * uploaded temp file with yauzl so nothing is ever held whole in memory.
 */
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import yauzl from 'yauzl';
import yazl from 'yazl';
import type { Pack } from '@only-connect/shared';
import { z, type ZodError } from 'zod';
import { config } from '../config.js';
import type { AppDeps } from '../deps.js';
import { StorageNotFoundError, type ObjectStore } from '../storage.js';
import { mediaKeysOf, normalisePackInput } from './repo.js';
import { packInputSchema } from './schema.js';

export const BUNDLE_FORMAT = 'only-connect-pack';
export const BUNDLE_VERSION = 1;
export const MEDIA_PREFIX = 'media/';
/** pack.json / manifest.json / media.json are small; anything bigger than this is not a bundle we wrote. */
export const MAX_JSON_ENTRY_BYTES = 16 * 1024 * 1024;

/**
 * Object key rule of the fs store (docs/DESKTOP.md §3.2), repeated here so a bundle written by hand cannot
 * smuggle a key the store would refuse (or a path) past the import.
 */
export const OBJECT_KEY_RULE = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
export const MAX_OBJECT_KEY_LENGTH = 200;

export function isValidObjectKey(key: string): boolean {
  return key.length > 0 && key.length <= MAX_OBJECT_KEY_LENGTH && OBJECT_KEY_RULE.test(key) && !key.split('/').includes('..');
}

export interface BundleMediaEntry {
  key: string;
  mime: string;
  size: number;
  originalName: string;
}

export interface BundleManifest {
  format: typeof BUNDLE_FORMAT;
  version: typeof BUNDLE_VERSION;
  exportedAt: string;
  name: string;
  warnings: string[];
}

export interface ImportResult {
  pack: Pack;
  /** Media objects written to the store (and recorded). */
  imported: number;
  /** Media entries not written: already present (keys are content-unique) or of an unsupported type. */
  skipped: number;
  warnings: string[];
}

/** An import problem the route turns into an HTTP error. */
export class BundleError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string,
    /** Set when `pack.json` failed `packInputSchema` (the route renders the issues like any 400). */
    readonly validation?: ZodError,
  ) {
    super(message);
    this.name = 'BundleError';
  }
}

/** `<safe pack name>.only-connect.<ext>` — the same rule the JSON export has always used. */
export function bundleFileName(packName: string, ext: 'json' | 'zip'): string {
  return `${packName.replace(/[^\w.-]+/g, '_').slice(0, 60) || 'pack'}.only-connect.${ext}`;
}

/** `PK\x03\x04`: a zip's local file header (an empty zip starts with the end-of-central-directory record instead). */
export function isZipBuffer(head: Buffer): boolean {
  return head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
}

/** Mime type from magic bytes for the formats the clue tiles play; null when unknown. */
export function sniffMime(head: Buffer): string | null {
  const startsWith = (hex: string, offset = 0) => head.length >= offset + hex.length / 2 && head.subarray(offset, offset + hex.length / 2).toString('hex') === hex;
  const ascii = (text: string, offset = 0) => head.length >= offset + text.length && head.subarray(offset, offset + text.length).toString('latin1') === text;
  if (startsWith('89504e470d0a1a0a')) return 'image/png';
  if (startsWith('ffd8ff')) return 'image/jpeg';
  if (ascii('GIF87a') || ascii('GIF89a')) return 'image/gif';
  if (ascii('RIFF') && ascii('WEBP', 8)) return 'image/webp';
  if (ascii('RIFF') && ascii('WAVE', 8)) return 'audio/wav';
  if (ascii('BM')) return 'image/bmp';
  if (ascii('ftyp', 4)) {
    const brand = head.subarray(8, 12).toString('latin1');
    if (brand.startsWith('avif') || brand.startsWith('avis')) return 'image/avif';
    if (brand === 'M4A ' || brand === 'M4B ') return 'audio/mp4';
    return 'audio/mp4';
  }
  if (ascii('ID3') || startsWith('fffb') || startsWith('fff3') || startsWith('fff2')) return 'audio/mpeg';
  if (ascii('OggS')) return 'audio/ogg';
  if (ascii('fLaC')) return 'audio/flac';
  if (startsWith('1a45dfa3')) return 'audio/webm';
  if (startsWith('fff1') || startsWith('fff9')) return 'audio/aac';
  return null;
}

/** Same rule as the upload route: images and audio, never SVG/XML/HTML (document formats that can carry script). */
export function isBundleMediaMime(mime: string): boolean {
  const m = mime.toLowerCase();
  if (m.includes('svg') || m.includes('xml') || m.includes('html')) return false;
  return (m.startsWith('image/') || m.startsWith('audio/')) && !m.includes('..');
}

/**
 * Entry name → normalised path, or null when the entry must be ignored: directories, absolute paths
 * (`/x`, `C:x`), `.` / `..` / empty segments. Backslashes are treated as separators first.
 */
export function normaliseEntryName(raw: string): string | null {
  const name = raw.replace(/\\/g, '/');
  if (name === '' || name.endsWith('/')) return null;
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return null;
  const parts = name.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return null;
  return name;
}

/** Media key of a `media/<key>` entry name, or null when the entry is not a valid media entry. */
export function mediaKeyOfEntry(name: string): string | null {
  if (!name.startsWith(MEDIA_PREFIX)) return null;
  const key = name.slice(MEDIA_PREFIX.length);
  return isValidObjectKey(key) ? key : null;
}

/** `key → { name, mime }` from the clues that reference it (the first clue wins). */
function clueMediaByKey(pack: Pick<Pack, 'questions'>): Map<string, { name: string; mime: string }> {
  const out = new Map<string, { name: string; mime: string }>();
  for (const q of pack.questions) {
    for (const c of q.clues ?? []) {
      if (c.media?.key && !out.has(c.media.key)) out.set(c.media.key, { name: c.media.name ?? '', mime: c.media.mime ?? '' });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * The bundle as a readable zip stream. Objects are checked up front (`headObject`) so `manifest.json` can list
 * the missing ones; their bytes are then pulled lazily, one entry at a time, as yazl writes them out. Errors
 * from the store destroy the stream (the HTTP response is cut off, never a half zip that looks complete).
 */
export function exportBundle(pack: Pack, objects: ObjectStore, now: Date = new Date()): Readable {
  const zip = new yazl.ZipFile();
  const out = zip.outputStream as unknown as Readable;
  zip.on('error', (err: Error) => out.destroy(err));
  void (async () => {
    const warnings: string[] = [];
    const media: BundleMediaEntry[] = [];
    const clues = clueMediaByKey(pack);
    for (const key of [...mediaKeysOf(pack)].sort()) {
      if (!isValidObjectKey(key)) {
        warnings.push(`media ${key} has an invalid key, not exported`);
        continue;
      }
      const head = await objects.headObject(key);
      if (!head) {
        warnings.push(`media ${key} not found`);
        continue;
      }
      const clue = clues.get(key);
      media.push({ key, mime: head.mime || clue?.mime || 'application/octet-stream', size: head.size ?? 0, originalName: clue?.name ?? '' });
    }
    const manifest: BundleManifest = { format: BUNDLE_FORMAT, version: BUNDLE_VERSION, exportedAt: now.toISOString(), name: pack.name, warnings };
    const mtime = now;
    zip.addBuffer(Buffer.from(JSON.stringify(manifest, null, 2)), 'manifest.json', { mtime });
    zip.addBuffer(Buffer.from(JSON.stringify(pack, null, 2)), 'pack.json', { mtime });
    zip.addBuffer(Buffer.from(JSON.stringify(media, null, 2)), 'media.json', { mtime });
    for (const m of media) {
      // Already-compressed formats: store them (deflate would only burn CPU on the host's laptop).
      zip.addReadStreamLazy(`${MEDIA_PREFIX}${m.key}`, { compress: false, mtime }, (cb) => {
        objects.getObjectStream(m.key).then(
          (obj) => {
            obj.stream.on('error', (err) => out.destroy(err));
            cb(null, obj.stream);
          },
          (err: unknown) => cb(err, undefined as never),
        );
      });
    }
    zip.end();
  })().catch((err: unknown) => out.destroy(err instanceof Error ? err : new Error(String(err))));
  return out;
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

const manifestSchema = z
  .object({
    format: z.literal(BUNDLE_FORMAT, { errorMap: () => ({ message: `format must be "${BUNDLE_FORMAT}"` }) }),
    version: z.literal(BUNDLE_VERSION, { errorMap: () => ({ message: `version must be ${BUNDLE_VERSION}` }) }),
    exportedAt: z.string().optional(),
    name: z.string().optional(),
    warnings: z.array(z.string()).optional(),
  })
  .passthrough();

const mediaListSchema = z.array(
  z
    .object({
      key: z.string(),
      mime: z.string().optional(),
      size: z.number().optional(),
      originalName: z.string().optional(),
    })
    .passthrough(),
);

export interface ImportLimits {
  /** Per media entry (the same cap as a direct upload). */
  maxEntryBytes: number;
  /** All media entries together. */
  maxTotalBytes: number;
}

function defaultLimits(): ImportLimits {
  const c = config();
  return { maxEntryBytes: c.MAX_UPLOAD_BYTES, maxTotalBytes: c.MAX_IMPORT_BYTES };
}

/** Decoded entry name: honours the UTF-8 flag and the Info-ZIP unicode path field, CP437 otherwise. */
function entryName(entry: yauzl.Entry): string {
  return yauzl.getFileNameLowLevel(entry.generalPurposeBitFlag, entry.fileNameRaw, entry.extraFields, false);
}

function readAllEntries(zip: yauzl.ZipFile): Promise<yauzl.Entry[]> {
  return new Promise((resolve, reject) => {
    const entries: yauzl.Entry[] = [];
    zip.on('entry', (entry: yauzl.Entry) => {
      entries.push(entry);
      zip.readEntry();
    });
    zip.once('end', () => resolve(entries));
    zip.once('error', reject);
    zip.readEntry();
  });
}

function openEntry(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<Readable> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (err, stream) => (err ? reject(err) : resolve(stream)));
  });
}

async function readEntryBuffer(zip: yauzl.ZipFile, entry: yauzl.Entry, name: string): Promise<Buffer> {
  if (entry.uncompressedSize > MAX_JSON_ENTRY_BYTES) throw new BundleError(413, `${name} is too large (max ${MAX_JSON_ENTRY_BYTES} bytes)`, 'file_too_large');
  const stream = await openEntry(zip, entry);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    size += buf.length;
    if (size > MAX_JSON_ENTRY_BYTES) {
      stream.destroy();
      throw new BundleError(413, `${name} is too large (max ${MAX_JSON_ENTRY_BYTES} bytes)`, 'file_too_large');
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/** A `media/<key>` entry yauzl could not open or read to the end: a damaged (or forged) bundle, a 400. */
function corruptZip(key: string, err: unknown): BundleError {
  return new BundleError(400, `Corrupt zip: media/${key}: ${err instanceof Error ? err.message : String(err)}`, 'bad_bundle');
}

function parseJsonEntry(buf: Buffer, name: string): unknown {
  try {
    return JSON.parse(buf.toString('utf8')) as unknown;
  } catch {
    throw new BundleError(400, `${name} is not valid JSON`, 'bad_bundle');
  }
}

/**
 * Read the first chunk of a stream (for sniffing) and hand back a stream that replays it before the rest.
 * `abort()` releases the source when the entry turns out to be unwanted; `sourceError()` tells whether the
 * zip itself failed while being read (yauzl: bad CRC, a lying size header…) as opposed to the consumer.
 */
async function peek(stream: Readable): Promise<{ head: Buffer; body: Readable; abort: () => Promise<void>; sourceError: () => Error | null }> {
  let failure: Error | null = null;
  stream.on('error', (err: Error) => {
    failure = failure ?? err;
  });
  const it = stream[Symbol.asyncIterator]();
  const first = await it.next();
  const head = first.done ? Buffer.alloc(0) : typeof first.value === 'string' ? Buffer.from(first.value) : (first.value as Buffer);
  const body = Readable.from(
    (async function* () {
      if (head.length > 0) yield head;
      if (first.done) return;
      for (;;) {
        const next = await it.next();
        if (next.done) return;
        yield typeof next.value === 'string' ? Buffer.from(next.value) : (next.value as Buffer);
      }
    })(),
  );
  return {
    head,
    body,
    abort: async () => {
      await it.return?.();
    },
    sourceError: () => failure,
  };
}

/**
 * Import a bundle from a zip on disk. Validates `manifest.json` and `pack.json`, creates the pack under a
 * **new id**, then writes every `media/<key>` entry the pack references and the store does not already hold.
 * Throws `BundleError` for anything the caller should turn into a 4xx; store/database failures propagate.
 * When a media write fails after the pack was created, the pack and the objects / media rows written by this
 * import are removed again before the error is rethrown: an import either succeeds whole or leaves nothing.
 */
export async function importBundle(
  zipPath: string,
  deps: Pick<AppDeps, 'packs' | 'media' | 'objects'>,
  limits: ImportLimits = defaultLimits(),
  now: Date = new Date(),
): Promise<ImportResult> {
  let zip: yauzl.ZipFile;
  try {
    // decodeStrings: false — yauzl would otherwise abort the whole read at the first `..` / absolute name;
    // we decode ourselves and *ignore* such entries instead (docs/DESKTOP.md §5).
    zip = await yauzl.openPromise(zipPath, { lazyEntries: true, autoClose: false, decodeStrings: false, validateEntrySizes: true });
  } catch (err) {
    throw new BundleError(400, `Not a zip file: ${(err as Error).message}`, 'bad_bundle');
  }
  try {
    const warnings: string[] = [];
    const warn = (msg: string) => {
      if (warnings.length < 50) warnings.push(msg);
    };
    let entries: yauzl.Entry[];
    try {
      entries = await readAllEntries(zip);
    } catch (err) {
      throw new BundleError(400, `Corrupt zip: ${(err as Error).message}`, 'bad_bundle');
    }

    const files = new Map<string, yauzl.Entry>();
    const mediaEntries = new Map<string, yauzl.Entry>();
    for (const entry of entries) {
      const raw = entryName(entry);
      const name = normaliseEntryName(raw);
      if (name === null) {
        if (!raw.endsWith('/') && !raw.endsWith('\\')) warn(`ignored entry "${raw}" (unsafe name)`);
        continue;
      }
      if (name === 'manifest.json' || name === 'pack.json' || name === 'media.json') {
        files.set(name, entry);
        continue;
      }
      const key = mediaKeyOfEntry(name);
      if (key === null) {
        warn(`ignored entry "${name}" (not a media/<key> entry)`);
        continue;
      }
      mediaEntries.set(key, entry);
    }

    const manifestEntry = files.get('manifest.json');
    if (!manifestEntry) throw new BundleError(400, 'manifest.json missing: not an Only Connect pack bundle', 'bad_bundle');
    const manifest = manifestSchema.safeParse(parseJsonEntry(await readEntryBuffer(zip, manifestEntry, 'manifest.json'), 'manifest.json'));
    if (!manifest.success) {
      throw new BundleError(400, `manifest.json: ${manifest.error.issues.map((i) => i.message).join('; ')}`, 'bad_bundle');
    }
    const packEntry = files.get('pack.json');
    if (!packEntry) throw new BundleError(400, 'pack.json missing from the bundle', 'bad_bundle');
    const parsedPack = packInputSchema.safeParse(parseJsonEntry(await readEntryBuffer(zip, packEntry, 'pack.json'), 'pack.json'));
    if (!parsedPack.success) throw new BundleError(400, 'pack.json is not a valid pack', 'validation', parsedPack.error);

    const mediaInfo = new Map<string, { mime?: string; originalName?: string }>();
    const mediaEntry = files.get('media.json');
    if (mediaEntry) {
      const list = mediaListSchema.safeParse(parseJsonEntry(await readEntryBuffer(zip, mediaEntry, 'media.json'), 'media.json'));
      if (list.success) for (const m of list.data) mediaInfo.set(m.key, { mime: m.mime, originalName: m.originalName });
      else warn('media.json is malformed, ignored (types are sniffed instead)');
    }

    const iso = now.toISOString();
    const pack = normalisePackInput(randomUUID(), parsedPack.data, { createdAt: iso, updatedAt: iso });
    const referenced = [...mediaKeysOf(pack)].sort();
    const clues = clueMediaByKey(pack);

    // Size caps are checked against the central directory before anything is written (yauzl verifies the
    // inflated size against it while reading, so a lying header cannot get past this).
    let total = 0;
    for (const key of referenced) {
      const entry = mediaEntries.get(key);
      if (!entry) continue;
      if (entry.uncompressedSize > limits.maxEntryBytes) {
        throw new BundleError(413, `media/${key} is too large (${entry.uncompressedSize} bytes, max ${limits.maxEntryBytes})`, 'file_too_large');
      }
      total += entry.uncompressedSize;
      if (total > limits.maxTotalBytes) throw new BundleError(413, `bundle media exceeds ${limits.maxTotalBytes} bytes in total`, 'bundle_too_large');
    }
    for (const key of mediaEntries.keys()) if (!referenced.includes(key)) warn(`media/${key} is not referenced by the pack, ignored`);

    const stored = await deps.packs.insert(pack);
    let imported = 0;
    let skipped = 0;
    /** Objects written by this import, removed again if a later step fails. */
    const written: string[] = [];
    try {
      for (const key of referenced) {
        const entry = mediaEntries.get(key);
        const exists = (await deps.objects.headObject(key)) !== null;
        if (!entry) {
          if (!exists) warn(`media ${key} is not in the bundle and not on this server`);
          continue;
        }
        if (exists) {
          skipped += 1;
          continue;
        }
        const info = mediaInfo.get(key);
        let peeked: Awaited<ReturnType<typeof peek>>;
        try {
          peeked = await peek(await openEntry(zip, entry));
        } catch (err) {
          // Opening the entry or reading its first chunk failed inside yauzl: the bundle is damaged.
          throw corruptZip(key, err);
        }
        const { head, body, abort, sourceError } = peeked;
        const mime = (info?.mime || sniffMime(head) || clues.get(key)?.mime || 'application/octet-stream').toLowerCase();
        if (!isBundleMediaMime(mime)) {
          await abort();
          skipped += 1;
          warn(`media ${key} skipped: unsupported type "${mime}" (only images and audio)`);
          continue;
        }
        const originalName = (info?.originalName || clues.get(key)?.name || key.slice(key.lastIndexOf('/') + 1)).slice(0, 255);
        let size: number;
        try {
          size = (await deps.objects.putObject(key, body, mime)).size;
        } catch (err) {
          await deps.objects.deleteObject(key).catch(() => undefined);
          // yauzl aborted the entry (CRC mismatch, inflated size not matching the header…): the bundle is damaged.
          const zipErr = sourceError();
          if (zipErr) throw corruptZip(key, zipErr);
          // The fs store cannot hold a key nested under another object (`a` and `a/b`): the bundle's keys are at fault.
          if (err instanceof StorageNotFoundError) throw new BundleError(400, `media/${key} cannot be stored: its key is nested under another object`, 'bad_bundle');
          throw err;
        }
        written.push(key);
        await deps.media.record({ key, mime, size, originalName });
        imported += 1;
      }
    } catch (err) {
      // Undo what this import created so a failed import leaves no pack with missing media behind (a retry
      // would otherwise create a second copy); the original error is what the caller sees.
      await deps.packs.delete(stored.id).catch(() => undefined);
      for (const key of written) {
        await deps.media.delete(key).catch(() => undefined);
        await deps.objects.deleteObject(key).catch(() => undefined);
      }
      throw err;
    }
    return { pack: stored, imported, skipped, warnings };
  } finally {
    zip.close();
  }
}
