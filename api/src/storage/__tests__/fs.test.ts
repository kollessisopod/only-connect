import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StorageNotFoundError, StorageRangeError } from '../../storage.js';
import { FsObjectStore, isValidKey, parseRange, validateKey } from '../fs.js';

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  return Buffer.concat(chunks);
}

describe('fs store key validation', () => {
  it('accepts the keys the app produces', () => {
    expect(isValidKey('uploads/5d1c6f6e-1b1e-4a2c-9a0e-1f2e3d4c5b6a.png')).toBe(true);
    expect(isValidKey('demo/lion.svg')).toBe(true);
    expect(isValidKey('a')).toBe(true);
    expect(isValidKey('A1/b-2/c_3.d')).toBe(true);
  });

  it('refuses anything that could leave the directory or is not a plain relative path', () => {
    for (const bad of [
      '',
      '/abs/x.png',
      '../x.png',
      'uploads/../x.png',
      'uploads/./x.png',
      'uploads//x.png',
      'uploads/',
      '.hidden',
      'uploads/.hidden',
      'uploads/x y.png',
      'uploads\\x.png',
      'uploads/x.png?x=1',
      'uploads/ünïcode.png',
      `${'a'.repeat(201)}`,
    ]) {
      expect(isValidKey(bad), bad).toBe(false);
      expect(() => validateKey(bad), bad).toThrow(StorageNotFoundError);
    }
    expect(isValidKey('a'.repeat(200))).toBe(true);
  });
});

describe('fs store range parsing (S3 semantics)', () => {
  it('serves the whole object without a header or with a malformed one', () => {
    expect(parseRange(undefined, 10)).toBeNull();
    expect(parseRange('', 10)).toBeNull();
    expect(parseRange('bytes=-', 10)).toBeNull();
    expect(parseRange('items=0-1', 10)).toBeNull();
    expect(parseRange('bytes=0-1,3-4', 10)).toBeNull();
  });

  it('resolves a-b, a- and -n', () => {
    expect(parseRange('bytes=0-3', 10)).toEqual({ start: 0, end: 3 });
    expect(parseRange('bytes=2-99', 10)).toEqual({ start: 2, end: 9 });
    expect(parseRange('bytes=4-', 10)).toEqual({ start: 4, end: 9 });
    expect(parseRange('bytes=-3', 10)).toEqual({ start: 7, end: 9 });
    expect(parseRange('bytes=-30', 10)).toEqual({ start: 0, end: 9 });
    expect(parseRange(' bytes=0-0 ', 10)).toEqual({ start: 0, end: 0 });
  });

  it('throws StorageRangeError for unsatisfiable ranges', () => {
    for (const bad of ['bytes=10-', 'bytes=10-12', 'bytes=5-2', 'bytes=-0']) {
      expect(() => parseRange(bad, 10, 'k'), bad).toThrow(StorageRangeError);
    }
    expect(() => parseRange('bytes=0-', 0)).toThrow(StorageRangeError);
    expect(() => parseRange('bytes=-5', 0)).toThrow(StorageRangeError);
  });
});

describe('FsObjectStore', () => {
  let root: string;
  let store: FsObjectStore;

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'oc-fs-store-'));
    store = new FsObjectStore(root);
    await store.ensure();
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('creates the layout', async () => {
    expect((await stat(path.join(root, 'objects'))).isDirectory()).toBe(true);
    expect((await stat(path.join(root, 'meta'))).isDirectory()).toBe(true);
  });

  it('puts a buffer, reads it back with metadata, heads and deletes it', async () => {
    const body = Buffer.from('hello object store');
    const put = await store.putObject('uploads/a.txt', body, 'text/plain');
    expect(put).toEqual({ key: 'uploads/a.txt', size: body.length });

    expect(await readFile(path.join(root, 'objects', 'uploads', 'a.txt'))).toEqual(body);
    const meta = JSON.parse(await readFile(path.join(root, 'meta', 'uploads', 'a.txt.json'), 'utf8'));
    expect(meta).toMatchObject({ mime: 'text/plain', size: body.length });
    expect(new Date(meta.createdAt).getTime()).toBeGreaterThan(0);
    // No temp file left behind.
    expect((await readdir(path.join(root, 'objects', 'uploads'))).filter((f) => f.endsWith('.tmp'))).toEqual([]);

    const got = await store.getObjectStream('uploads/a.txt');
    expect(got.mime).toBe('text/plain');
    expect(got.size).toBe(body.length);
    expect(got.contentRange).toBeNull();
    expect(got.etag).toMatch(/^"\d+-\d+"$/);
    expect(got.lastModified).toBeInstanceOf(Date);
    expect(await readAll(got.stream)).toEqual(body);

    expect(await store.headObject('uploads/a.txt')).toEqual({ mime: 'text/plain', size: body.length });

    await store.deleteObject('uploads/a.txt');
    expect(await store.headObject('uploads/a.txt')).toBeNull();
    await expect(store.getObjectStream('uploads/a.txt')).rejects.toBeInstanceOf(StorageNotFoundError);
    await expect(stat(path.join(root, 'meta', 'uploads', 'a.txt.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    // Deleting again is not an error.
    await store.deleteObject('uploads/a.txt');
  });

  it('puts a stream and honours ranges', async () => {
    const body = Buffer.from('0123456789');
    await store.putObject('demo/digits.bin', Readable.from([body.subarray(0, 4), body.subarray(4)]), 'application/octet-stream');

    const part = await store.getObjectStream('demo/digits.bin', { range: 'bytes=2-5' });
    expect(part.size).toBe(4);
    expect(part.contentRange).toBe('bytes 2-5/10');
    expect((await readAll(part.stream)).toString()).toBe('2345');

    const tail = await store.getObjectStream('demo/digits.bin', { range: 'bytes=-3' });
    expect(tail.contentRange).toBe('bytes 7-9/10');
    expect((await readAll(tail.stream)).toString()).toBe('789');

    const open = await store.getObjectStream('demo/digits.bin', { range: 'bytes=8-' });
    expect(open.contentRange).toBe('bytes 8-9/10');
    expect((await readAll(open.stream)).toString()).toBe('89');

    await expect(store.getObjectStream('demo/digits.bin', { range: 'bytes=10-' })).rejects.toBeInstanceOf(StorageRangeError);
  });

  it('never touches the disk for an invalid key', async () => {
    await expect(store.putObject('../escape.txt', Buffer.from('x'), 'text/plain')).rejects.toBeInstanceOf(StorageNotFoundError);
    await expect(store.getObjectStream('uploads/../../escape.txt')).rejects.toBeInstanceOf(StorageNotFoundError);
    expect(await store.headObject('/etc/passwd')).toBeNull();
    await store.deleteObject('../escape.txt'); // no throw, nothing deleted
    await expect(stat(path.join(root, 'escape.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(path.join(path.dirname(root), 'escape.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('treats a key whose path runs through an existing object as not found, like S3 does', async () => {
    await store.putObject('uploads/parent', Buffer.from('I am a file'), 'image/png');
    // stat() on <file>/x.png is ENOTDIR on Linux (ENOENT on Windows): both are "no such object".
    await expect(store.getObjectStream('uploads/parent/x.png')).rejects.toBeInstanceOf(StorageNotFoundError);
    expect(await store.headObject('uploads/parent/x.png')).toBeNull();
    expect(await store.headObject('uploads/parent/deeper/x.png')).toBeNull();
    await store.deleteObject('uploads/parent/x.png'); // no throw, nothing deleted
    expect(await store.headObject('uploads/parent')).toEqual({ mime: 'image/png', size: 11 });

    // Writing under such a key cannot succeed on a file system (mkdir → EEXIST / ENOTDIR): a client error, not a 500.
    await expect(store.putObject('uploads/parent/child.png', Buffer.from('x'), 'image/png')).rejects.toBeInstanceOf(StorageNotFoundError);
    await expect(store.putObject('uploads/parent/a/b.png', Buffer.from('x'), 'image/png')).rejects.toBeInstanceOf(StorageNotFoundError);
    expect(await readFile(path.join(root, 'objects', 'uploads', 'parent'), 'utf8')).toBe('I am a file');

    // The reverse: the key names the directory other objects live in.
    await store.putObject('uploads/dir/child.png', Buffer.from('child'), 'image/png');
    await expect(store.putObject('uploads/dir', Buffer.from('x'), 'image/png')).rejects.toBeInstanceOf(StorageNotFoundError);
    expect(await store.headObject('uploads/dir')).toBeNull();
    expect(await store.headObject('uploads/dir/child.png')).toEqual({ mime: 'image/png', size: 5 });
    expect((await readdir(path.join(root, 'objects', 'uploads', 'dir'))).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('falls back to octet-stream when the metadata is missing', async () => {
    await store.putObject('uploads/nometa.bin', Buffer.from('abc'), 'image/png');
    await rm(path.join(root, 'meta', 'uploads', 'nometa.bin.json'));
    expect(await store.headObject('uploads/nometa.bin')).toEqual({ mime: 'application/octet-stream', size: 3 });
  });
});
