import { describe, expect, it } from 'vitest';
import { DEMO_MEDIA_PREFIX, buildDemoPack, validatePack } from '@only-connect/shared';
import { DEMO_MELODIES } from '../melodies.js';
import { generateDemoAsset, mediaRefs, seedDemo } from '../index.js';
import { DEMO_IMAGES, moonPhase } from '../svg.js';
import { encodeWav, noteFrequency, parseWavHeader, renderMelody, tone, DEFAULT_SAMPLE_RATE } from '../wav.js';
import { InMemoryMediaRepository, InMemoryObjectStore, InMemoryPackRepository } from '../../__tests__/stubs.js';

const silent = { info() {}, warn() {}, error() {}, debug() {} };

describe('WAV encoder', () => {
  it('writes a canonical 44-byte PCM header with consistent sizes', () => {
    const samples = tone(440, 0.5, { sampleRate: 8000 });
    expect(samples.length).toBe(4000);
    const wav = encodeWav(samples, 8000);
    expect(wav.length).toBe(44 + 4000 * 2);
    const h = parseWavHeader(wav);
    expect(h).toEqual({
      riffSize: 36 + 8000,
      audioFormat: 1,
      channels: 1,
      sampleRate: 8000,
      byteRate: 16000,
      blockAlign: 2,
      bitsPerSample: 16,
      dataSize: 8000,
    });
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.toString('ascii', 8, 12)).toBe('WAVE');
  });

  it('encodes samples as clamped little-endian int16', () => {
    const wav = encodeWav(new Float32Array([0, 1, -1, 2, -2, 0.5]), 8000);
    const data = wav.subarray(44);
    expect([data.readInt16LE(0), data.readInt16LE(2), data.readInt16LE(4), data.readInt16LE(6), data.readInt16LE(8)]).toEqual([0, 32767, -32768, 32767, -32768]);
    expect(data.readInt16LE(10)).toBe(Math.round(0.5 * 32767));
  });

  it('tones stay within the gain and start/end near silence (no clicks)', () => {
    const t = tone(261.63, 0.8, { gain: 0.5 });
    expect(t.length).toBe(Math.round(0.8 * DEFAULT_SAMPLE_RATE));
    let peak = 0;
    for (const s of t) peak = Math.max(peak, Math.abs(s));
    expect(peak).toBeLessThanOrEqual(0.5);
    expect(peak).toBeGreaterThan(0.3);
    expect(Math.abs(t[0])).toBeLessThan(0.01);
    expect(Math.abs(t[t.length - 1])).toBeLessThan(0.02);
  });

  it('maps note names to equal-temperament frequencies', () => {
    expect(noteFrequency('A4')).toBeCloseTo(440, 5);
    expect(noteFrequency('C4')).toBeCloseTo(261.63, 1);
    expect(noteFrequency('C#5')).toBeCloseTo(554.37, 1);
    expect(noteFrequency('Bb3')).toBeCloseTo(233.08, 1);
    expect(() => noteFrequency('H2')).toThrow();
  });

  it('renders every demo melody to a few seconds of audio', () => {
    for (const [file, melody] of Object.entries(DEMO_MELODIES)) {
      const samples = renderMelody(melody.notes, melody.options);
      const seconds = samples.length / DEFAULT_SAMPLE_RATE;
      expect(seconds, file).toBeGreaterThan(0.7);
      expect(seconds, file).toBeLessThan(12);
    }
    const solfege = renderMelody(DEMO_MELODIES['solfege-do.wav'].notes, DEMO_MELODIES['solfege-do.wav'].options);
    expect(solfege.length).toBe(Math.round(0.8 * DEFAULT_SAMPLE_RATE));
  });
});

describe('demo assets', () => {
  it('has a generator for every media file the demo pack references', () => {
    const pack = buildDemoPack(() => 'x');
    const refs = mediaRefs(pack);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(ref.key.startsWith(DEMO_MEDIA_PREFIX)).toBe(true);
      const asset = generateDemoAsset(ref.key.slice(DEMO_MEDIA_PREFIX.length));
      expect(asset, ref.key).not.toBeNull();
      expect(asset?.mime, ref.key).toBe(ref.mime);
      expect(asset?.body.length).toBeGreaterThan(100);
    }
  });

  it('produces well-formed SVG and WAV bodies', () => {
    for (const file of Object.keys(DEMO_IMAGES)) {
      const svg = generateDemoAsset(file)?.body.toString('utf8') ?? '';
      expect(svg.startsWith('<?xml')).toBe(true);
      expect(svg).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
      expect(svg.trimEnd().endsWith('</svg>')).toBe(true);
    }
    expect(moonPhase(0)).not.toContain('<path');
    expect(moonPhase(0.5)).toContain('<path');
    expect(moonPhase(0.5)).not.toContain('<ellipse');
    expect(moonPhase(0.25)).toContain('<ellipse');
    const wav = generateDemoAsset('solfege-do.wav');
    expect(wav?.mime).toBe('audio/wav');
    expect(parseWavHeader(wav!.body).sampleRate).toBe(DEFAULT_SAMPLE_RATE);
  });
});

describe('seedDemo', () => {
  it('inserts the demo pack once, uploads media once, and survives a broken bucket', async () => {
    const packs = new InMemoryPackRepository();
    const objects = new InMemoryObjectStore();
    const media = new InMemoryMediaRepository();

    objects.failPuts = true;
    const first = await seedDemo({ packs, objects, media }, silent);
    expect(first.packInserted).toBe(true);
    expect(await packs.count()).toBe(1);
    expect(first.uploaded).toEqual([]);
    expect(first.failed.length).toBeGreaterThan(0);

    objects.failPuts = false;
    const second = await seedDemo({ packs, objects, media }, silent);
    expect(second.packInserted).toBe(false);
    expect(await packs.count()).toBe(1);
    expect(second.uploaded.length).toBe(first.failed.length);
    expect(media.records.length).toBe(second.uploaded.length);

    const third = await seedDemo({ packs, objects, media }, silent);
    expect(third.uploaded).toEqual([]);
    expect(third.skipped.length).toBe(second.uploaded.length);

    const stored = (await packs.list())[0];
    expect(validatePack(stored)).toEqual([]);
    for (const ref of mediaRefs(stored)) expect(objects.objects.get(ref.key)?.mime).toBe(ref.mime);
  });
});
