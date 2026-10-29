/**
 * Pack bundles (docs/DESKTOP.md §5) against the in-memory stubs: export → import round trip, zip-slip
 * names, size caps, unsupported media types, malformed bundles.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import zlib from 'node:zlib';
import yauzl from 'yauzl';
import yazl from 'yazl';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildDemoPack, type Pack } from '@only-connect/shared';
import { setConfigForTests, type Config } from '../config.js';
import {
  BUNDLE_FORMAT,
  BUNDLE_VERSION,
  BundleError,
  type BundleManifest,
  type BundleMediaEntry,
  bundleFileName,
  exportBundle,
  importBundle,
  isValidObjectKey,
  isZipBuffer,
  mediaKeyOfEntry,
  normaliseEntryName,
  sniffMime,
} from '../packs/bundle.js';
import { mediaKeysOf } from '../packs/repo.js';
import { StorageNotFoundError } from '../storage.js';
import { TEST_CONFIG, createTestDeps, type TestDeps } from './stubs.js';

const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(300, 7)]);
const MP3 = Buffer.concat([Buffer.from('494433', 'hex'), Buffer.alloc(200, 1)]);

let tmpDir: string;
let seq = 0;

beforeAll(async () => {
  setConfigForTests({ ...TEST_CONFIG, MAX_UPLOAD_BYTES: 1024 * 1024, MAX_IMPORT_BYTES: 8 * 1024 * 1024 } as Config);
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-bundle-test-'));
});

afterAll(async () => {
  setConfigForTests(null);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  return Buffer.concat(chunks);
}

async function writeTmp(buf: Buffer): Promise<string> {
  const file = path.join(tmpDir, `bundle-${++seq}.zip`);
  await fs.writeFile(file, buf);
  return file;
}

/** Every entry of a zip buffer (name → bytes), via yauzl with its own name validation on. */
async function readZip(buf: Buffer): Promise<Map<string, Buffer>> {
  const zip = await yauzl.fromBufferPromise(buf, { lazyEntries: true });
  const out = new Map<string, Buffer>();
  await new Promise<void>((resolve, reject) => {
    zip.on('entry', (entry: yauzl.Entry) => {
      zip.openReadStream(entry, (err, stream) => {
        if (err) return reject(err);
        collect(stream).then((data) => {
          out.set(entry.fileName, data);
          zip.readEntry();
        }, reject);
      });
    });
    zip.once('end', () => resolve());
    zip.once('error', reject);
    zip.readEntry();
  });
  return out;
}

/** A zip built with yazl (which refuses unsafe names itself). */
async function yazlZip(entries: Array<[name: string, data: Buffer | string]>): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  for (const [name, data] of entries) zip.addBuffer(Buffer.isBuffer(data) ? data : Buffer.from(data), name);
  zip.end();
  return collect(zip.outputStream as unknown as Readable);
}

/**
 * A hand-written zip (store method) that can carry any entry name, including the ones yazl and well-behaved
 * tools refuse: `../x`, `/abs`, `C:\x`, backslashes.
 */
function rawZip(entries: Array<[name: string, data: Buffer | string]>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, raw] of entries) {
    const data = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = zlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x800, 6); // utf-8 names
    local.writeUInt16LE(0, 8); // store
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x21, 12); // date (1980-01-01)
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // made by
    central.writeUInt16LE(20, 6); // needed
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cd, eocd]);
}

const manifestJson = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ format: BUNDLE_FORMAT, version: BUNDLE_VERSION, exportedAt: new Date().toISOString(), name: 'x', warnings: [], ...extra });

/** A small pack whose first clue is an image stored under `uploads/<uuid>.<ext>`. */
function packWithUpload(key: string, mime = 'image/png', name = 'tile.png'): Pack {
  const pack = buildDemoPack(() => randomUUID(), { media: false });
  pack.name = 'Bundle test';
  pack.questions[0].clues[0] = { kind: 'image', text: 'pic', media: { key, url: `/api/media/${key}`, mime, name } };
  return pack;
}

/** Puts the demo pack's `demo/` media into a store the way the seeder does. */
async function seedDemoMedia(deps: TestDeps, pack: Pack): Promise<void> {
  for (const q of pack.questions) {
    for (const c of q.clues) {
      if (!c.media || !c.media.key.startsWith('demo/') || deps.objects.objects.has(c.media.key)) continue;
      const body = c.media.mime.startsWith('audio/') ? Buffer.from('RIFF....WAVEfmt demo', 'latin1') : Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
      await deps.objects.putObject(c.media.key, body, c.media.mime);
      await deps.media.record({ key: c.media.key, mime: c.media.mime, size: body.length, originalName: c.media.name });
    }
  }
}

describe('helpers', () => {
  it('validates object keys like the fs store', () => {
    for (const ok of ['uploads/a.png', 'demo/x/y.wav', 'a', 'A1.b-c_d']) expect(isValidObjectKey(ok), ok).toBe(true);
    for (const bad of ['', '/uploads/a.png', 'uploads//a.png', '../a.png', 'uploads/../a', '.hidden', 'uploads/.x', 'a b', 'ü', 'x'.repeat(201)]) {
      expect(isValidObjectKey(bad), bad).toBe(false);
    }
  });

  it('normalises entry names and ignores unsafe ones', () => {
    expect(normaliseEntryName('media\\uploads\\a.png')).toBe('media/uploads/a.png');
    for (const bad of ['../x', '/abs', 'C:\\evil', 'media/../x', 'media/./x', 'media//x', 'dir/', '']) expect(normaliseEntryName(bad), bad).toBeNull();
    expect(mediaKeyOfEntry('media/uploads/a.png')).toBe('uploads/a.png');
    expect(mediaKeyOfEntry('pack.json')).toBeNull();
    expect(mediaKeyOfEntry('media/.hidden')).toBeNull();
  });

  it('sniffs the usual formats and recognises a zip header', () => {
    expect(sniffMime(PNG)).toBe('image/png');
    expect(sniffMime(MP3)).toBe('audio/mpeg');
    expect(sniffMime(Buffer.from('RIFFxxxxWAVE'))).toBe('audio/wav');
    expect(sniffMime(Buffer.from('hello'))).toBeNull();
    expect(isZipBuffer(Buffer.from('504b0304', 'hex'))).toBe(true);
    expect(isZipBuffer(Buffer.from('{"a":1}'))).toBe(false);
    expect(bundleFileName('Quiz night: série 2', 'zip')).toBe('Quiz_night_s_rie_2.only-connect.zip');
  });
});

describe('export → import round trip', () => {
  it('bundles the pack with its uploads and seeded media, imports under a new id and dedupes by object', async () => {
    const source = createTestDeps([]);
    const pack = buildDemoPack(() => randomUUID(), { media: true });
    pack.name = 'Round trip';
    const uploadKey = `uploads/${randomUUID()}.png`;
    pack.questions[1].clues[0] = { kind: 'image', text: 'uploaded', media: { key: uploadKey, url: `/api/media/${uploadKey}`, mime: 'image/png', name: 'photo.png' } };
    await seedDemoMedia(source, pack);
    await source.objects.putObject(uploadKey, PNG, 'image/png');
    await source.media.record({ key: uploadKey, mime: 'image/png', size: PNG.length, originalName: 'photo.png' });
    const stored = await source.packs.insert(pack);

    const zipBuf = await collect(exportBundle(stored, source.objects, new Date('2026-10-29T10:00:00Z')));
    expect(isZipBuffer(zipBuf)).toBe(true);
    const entries = await readZip(zipBuf);
    const manifest = JSON.parse(entries.get('manifest.json')!.toString()) as BundleManifest;
    expect(manifest).toEqual({ format: 'only-connect-pack', version: 1, exportedAt: '2026-10-29T10:00:00.000Z', name: 'Round trip', warnings: [] });
    expect(JSON.parse(entries.get('pack.json')!.toString())).toEqual(stored);
    const media = JSON.parse(entries.get('media.json')!.toString()) as BundleMediaEntry[];
    const referenced = [...mediaKeysOf(stored)].sort();
    expect(referenced.some((k) => k.startsWith('demo/'))).toBe(true);
    expect(media.map((m) => m.key)).toEqual(referenced);
    expect(media.find((m) => m.key === uploadKey)).toEqual({ key: uploadKey, mime: 'image/png', size: PNG.length, originalName: 'photo.png' });
    for (const key of referenced) expect(entries.has(`media/${key}`), key).toBe(true);
    expect(entries.get(`media/${uploadKey}`)).toEqual(PNG);
    expect(entries.size).toBe(3 + referenced.length);

    // The target already has the seeded demo media (every instance does) but not the upload.
    const target = createTestDeps([]);
    await seedDemoMedia(target, pack);
    const result = await importBundle(await writeTmp(zipBuf), target);
    expect(result.warnings).toEqual([]);
    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(referenced.length - 1);
    expect(result.pack.id).not.toBe(stored.id);
    expect(result.pack.name).toBe('Round trip');
    const strip = (p: Pack) => ({
      questions: p.questions.map((q) => ({ round: q.round, hieroglyph: q.hieroglyph, answer: q.answer, clues: q.clues })),
      walls: p.walls.map((w) => ({ hieroglyph: w.hieroglyph, groups: w.groups })),
      vowelGroups: p.vowelGroups.map((g) => ({ category: g.category, clues: g.clues })),
    });
    expect(strip(result.pack)).toEqual(strip(stored));
    // Content ids are kept on another instance (the repository only reassigns ids a pack there already owns).
    expect(await target.packs.get(result.pack.id)).toEqual(result.pack);
    expect(target.objects.objects.get(uploadKey)).toEqual({ body: PNG, mime: 'image/png' });
    expect(target.media.records.find((r) => r.key === uploadKey)).toMatchObject({ key: uploadKey, mime: 'image/png', size: PNG.length, originalName: 'photo.png' });
    // Nothing else was written: the demo objects were already there.
    expect(target.objects.objects.size).toBe(referenced.length);

    // Importing the same bundle again on the same target: everything is already present.
    const again = await importBundle(await writeTmp(zipBuf), target);
    expect(again).toMatchObject({ imported: 0, skipped: referenced.length, warnings: [] });
    expect(again.pack.id).not.toBe(result.pack.id);
  });

  it('skips a missing object on export and lists it in the manifest warnings', async () => {
    const source = createTestDeps([]);
    const gone = `uploads/${randomUUID()}.png`;
    const here = `uploads/${randomUUID()}.png`;
    const pack = packWithUpload(gone);
    pack.questions[0].clues[1] = { kind: 'image', text: 'pic', media: { key: here, url: `/api/media/${here}`, mime: 'image/png', name: 'here.png' } };
    await source.objects.putObject(here, PNG, 'image/png');
    const stored = await source.packs.insert(pack);
    const entries = await readZip(await collect(exportBundle(stored, source.objects)));
    const manifest = JSON.parse(entries.get('manifest.json')!.toString()) as BundleManifest;
    expect(manifest.warnings).toEqual([`media ${gone} not found`]);
    expect(entries.has(`media/${gone}`)).toBe(false);
    expect(entries.has(`media/${here}`)).toBe(true);
    const media = JSON.parse(entries.get('media.json')!.toString()) as BundleMediaEntry[];
    expect(media.map((m) => m.key)).toEqual([here]);
  });
});

describe('import safety', () => {
  it('ignores ../, absolute and non-media entries, and reads backslash names as paths', async () => {
    const key = `uploads/${randomUUID()}.png`;
    const pack = packWithUpload(key);
    const zip = rawZip([
      ['manifest.json', manifestJson()],
      ['pack.json', JSON.stringify(pack)],
      ['media.json', JSON.stringify([{ key, mime: 'image/png', size: PNG.length, originalName: 'tile.png' }])],
      ['../evil.png', PNG],
      ['/etc/evil.png', PNG],
      ['C:\\Windows\\evil.png', PNG],
      ['media/../../evil.png', PNG],
      ['media/uploads/../evil.png', PNG],
      ['__MACOSX/._pack.json', Buffer.from('junk')],
      [`media\\${key.replace('/', '\\')}`, PNG],
    ]);
    const deps = createTestDeps([]);
    const result = await importBundle(await writeTmp(zip), deps);
    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(0);
    expect([...deps.objects.objects.keys()]).toEqual([key]);
    expect(deps.objects.objects.get(key)).toEqual({ body: PNG, mime: 'image/png' });
    expect(result.warnings.filter((w) => w.startsWith('ignored entry'))).toHaveLength(6);
    expect(result.warnings.some((w) => w.includes('"../evil.png"'))).toBe(true);
    expect(result.warnings.some((w) => w.includes('"/etc/evil.png"'))).toBe(true);
    expect(await deps.packs.count()).toBe(1);
  });

  it('refuses an entry above the per-file cap and a bundle above the total cap before writing anything', async () => {
    const big = `uploads/${randomUUID()}.png`;
    const zip = await yazlZip([
      ['manifest.json', manifestJson()],
      ['pack.json', JSON.stringify(packWithUpload(big))],
      [`media/${big}`, Buffer.concat([PNG, Buffer.alloc(2000)])],
    ]);
    const deps = createTestDeps([]);
    const err = await importBundle(await writeTmp(zip), deps, { maxEntryBytes: 1024, maxTotalBytes: 1024 * 1024 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BundleError);
    expect(err as BundleError).toMatchObject({ status: 413, code: 'file_too_large' });
    expect(await deps.packs.count()).toBe(0);
    expect(deps.objects.objects.size).toBe(0);

    const a = `uploads/${randomUUID()}.png`;
    const b = `uploads/${randomUUID()}.png`;
    const two = packWithUpload(a);
    two.questions[0].clues[1] = { kind: 'image', text: 'pic', media: { key: b, url: `/api/media/${b}`, mime: 'image/png', name: 'b.png' } };
    const zip2 = await yazlZip([
      ['manifest.json', manifestJson()],
      ['pack.json', JSON.stringify(two)],
      [`media/${a}`, Buffer.concat([PNG, Buffer.alloc(300)])],
      [`media/${b}`, Buffer.concat([PNG, Buffer.alloc(300)])],
    ]);
    const err2 = await importBundle(await writeTmp(zip2), deps, { maxEntryBytes: 1024, maxTotalBytes: 1000 }).catch((e: unknown) => e);
    expect(err2 as BundleError).toMatchObject({ status: 413, code: 'bundle_too_large' });
    expect(await deps.packs.count()).toBe(0);
  });

  it('skips a media entry that is neither image nor audio, with a warning; sniffs the type when media.json has none', async () => {
    const text = `uploads/${randomUUID()}.txt`;
    const sniffed = `uploads/${randomUUID()}.bin`;
    const svg = `uploads/${randomUUID()}.svg`;
    const pack = packWithUpload(text, 'text/plain', 'notes.txt');
    pack.questions[0].clues[1] = { kind: 'image', text: 'pic', media: { key: sniffed, url: `/api/media/${sniffed}`, mime: 'application/octet-stream', name: 'sniffed' } };
    pack.questions[0].clues[2] = { kind: 'image', text: 'pic', media: { key: svg, url: `/api/media/${svg}`, mime: 'image/svg+xml', name: 'evil.svg' } };
    const zip = await yazlZip([
      ['manifest.json', manifestJson()],
      ['pack.json', JSON.stringify(pack)],
      ['media.json', JSON.stringify([{ key: text, mime: 'text/plain', size: 5, originalName: 'notes.txt' }, { key: sniffed }])],
      [`media/${text}`, 'hello'],
      [`media/${sniffed}`, MP3],
      [`media/${svg}`, '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>'],
    ]);
    const deps = createTestDeps([]);
    const result = await importBundle(await writeTmp(zip), deps);
    expect(result.imported).toBe(1);
    expect(result.skipped).toBe(2);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings.every((w) => w.includes('skipped: unsupported type'))).toBe(true);
    expect(result.warnings.some((w) => w.includes(text) && w.includes('text/plain'))).toBe(true);
    expect(result.warnings.some((w) => w.includes(svg) && w.includes('image/svg+xml'))).toBe(true);
    expect(deps.objects.objects.has(text)).toBe(false);
    expect(deps.objects.objects.has(svg)).toBe(false);
    expect(deps.objects.objects.get(sniffed)).toEqual({ body: MP3, mime: 'audio/mpeg' });
    expect(deps.media.records.map((r) => r.key)).toEqual([sniffed]);
    expect(deps.media.records[0].originalName).toBe('sniffed');
  });

  it('warns about referenced media that is neither in the bundle nor on the server', async () => {
    const key = `uploads/${randomUUID()}.png`;
    const zip = await yazlZip([
      ['manifest.json', manifestJson()],
      ['pack.json', JSON.stringify(packWithUpload(key))],
    ]);
    const result = await importBundle(await writeTmp(zip), createTestDeps([]));
    expect(result).toMatchObject({ imported: 0, skipped: 0, warnings: [`media ${key} is not in the bundle and not on this server`] });
  });

  it('rejects bundles without a manifest, with the wrong version, with bad JSON or an invalid pack', async () => {
    const deps = createTestDeps([]);
    const cases: Array<[Array<[string, Buffer | string]>, string, string]> = [
      [[['pack.json', JSON.stringify(packWithUpload('uploads/a.png'))]], 'bad_bundle', 'manifest.json missing'],
      [[['manifest.json', manifestJson({ version: 2 })], ['pack.json', '{}']], 'bad_bundle', 'version must be 1'],
      [[['manifest.json', manifestJson({ format: 'zip-of-cats' })], ['pack.json', '{}']], 'bad_bundle', 'format must be'],
      [[['manifest.json', manifestJson()]], 'bad_bundle', 'pack.json missing'],
      [[['manifest.json', manifestJson()], ['pack.json', '{not json']], 'bad_bundle', 'not valid JSON'],
      [[['manifest.json', manifestJson()], ['pack.json', JSON.stringify({ questions: 'nope' })]], 'validation', 'not a valid pack'],
    ];
    for (const [entries, code, message] of cases) {
      const err = (await importBundle(await writeTmp(await yazlZip(entries)), deps).catch((e: unknown) => e)) as BundleError;
      expect(err, message).toBeInstanceOf(BundleError);
      expect(err.status, message).toBe(400);
      expect(err.code, message).toBe(code);
      expect(err.message, message).toContain(message);
    }
    expect(((await importBundle(await writeTmp(await yazlZip([['manifest.json', manifestJson()], ['pack.json', '{}']])), deps).catch((e: unknown) => e)) as BundleError).validation).toBeDefined();
    const notZip = (await importBundle(await writeTmp(Buffer.from('{"name":"x"}')), deps).catch((e: unknown) => e)) as BundleError;
    expect(notZip).toMatchObject({ status: 400, code: 'bad_bundle' });
    expect(await deps.packs.count()).toBe(0);
  });
});

describe('import is all-or-nothing', () => {
  /** A pack whose first clues reference `keys` as PNG images. */
  function packWithUploads(keys: string[]): Pack {
    const pack = packWithUpload(keys[0]);
    keys.slice(1).forEach((key, i) => {
      pack.questions[0].clues[i + 1] = { kind: 'image', text: 'pic', media: { key, url: `/api/media/${key}`, mime: 'image/png', name: `t${i}.png` } };
    });
    return pack;
  }

  it('removes the new pack and the media it already wrote when the store fails half-way (the error is the store\'s)', async () => {
    const a = `uploads/${randomUUID()}.png`;
    const b = `uploads/${randomUUID()}.png`;
    const zip = await yazlZip([
      ['manifest.json', manifestJson()],
      ['pack.json', JSON.stringify(packWithUploads([a, b]))],
      [`media/${a}`, PNG],
      [`media/${b}`, PNG],
    ]);
    const deps = createTestDeps([]);
    const realPut = deps.objects.putObject.bind(deps.objects);
    let puts = 0;
    deps.objects.putObject = async (key, body, mime) => {
      puts += 1;
      if (puts === 2) {
        for await (const _chunk of body as Readable) {
          // drain, then fail like a full disk would
        }
        throw new Error('disk full');
      }
      return realPut(key, body, mime);
    };
    const err = (await importBundle(await writeTmp(zip), deps).catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(BundleError);
    expect(err.message).toBe('disk full');
    expect(await deps.packs.count()).toBe(0);
    expect(deps.objects.objects.size).toBe(0);
    expect(await deps.media.list()).toEqual([]);
  });

  it('answers 400 for a media entry whose header lies about its size, leaving nothing behind', async () => {
    const key = `uploads/${randomUUID()}.png`;
    const big = Buffer.concat([PNG, Buffer.alloc(200 * 1024, 9)]);
    // Deflated entry whose central directory claims 1000 uncompressed bytes: it passes the pre-write size cap,
    // then yauzl aborts the stream while inflating ("too many bytes in the stream").
    const zip = deflatedZip(
      [
        ['manifest.json', Buffer.from(manifestJson())],
        ['pack.json', Buffer.from(JSON.stringify(packWithUploads([key])))],
        [`media/${key}`, big],
      ],
      { [`media/${key}`]: 1000 },
    );
    const deps = createTestDeps([]);
    const err = (await importBundle(await writeTmp(zip), deps).catch((e: unknown) => e)) as BundleError;
    expect(err).toBeInstanceOf(BundleError);
    expect(err).toMatchObject({ status: 400, code: 'bad_bundle' });
    expect(err.message).toContain('Corrupt zip');
    expect(await deps.packs.count()).toBe(0);
    expect(deps.objects.objects.size).toBe(0);
  });

  it('answers 400 when the store refuses a key nested under another object', async () => {
    const key = `uploads/${randomUUID()}/nested.png`;
    const zip = await yazlZip([
      ['manifest.json', manifestJson()],
      ['pack.json', JSON.stringify(packWithUploads([key]))],
      [`media/${key}`, PNG],
    ]);
    const deps = createTestDeps([]);
    deps.objects.putObject = async () => {
      throw new StorageNotFoundError(key);
    };
    const err = (await importBundle(await writeTmp(zip), deps).catch((e: unknown) => e)) as BundleError;
    expect(err).toBeInstanceOf(BundleError);
    expect(err).toMatchObject({ status: 400, code: 'bad_bundle' });
    expect(err.message).toContain('nested under another object');
    expect(await deps.packs.count()).toBe(0);
  });
});

/**
 * A hand-written zip with DEFLATED entries; `lies` maps an entry name to the uncompressed size written into
 * its headers instead of the real one (a damaged or forged bundle).
 */
function deflatedZip(entries: Array<[name: string, data: Buffer]>, lies: Record<string, number> = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const deflated = zlib.deflateRawSync(data);
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = zlib.crc32(data);
    const uncompressedSize = lies[name] ?? data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(uncompressedSize, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(deflated.length, 20);
    central.writeUInt32LE(uncompressedSize, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, deflated);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + deflated.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cd, eocd]);
}
