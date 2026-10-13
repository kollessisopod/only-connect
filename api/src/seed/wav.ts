/**
 * A tiny PCM WAV encoder and tone synthesiser, used to generate the demo pack's audio clues at seed time
 * (no recordings are shipped or downloaded). 16-bit, mono, little-endian RIFF/WAVE.
 */

export const DEFAULT_SAMPLE_RATE = 22050;

const SEMITONES: Record<string, number> = { C: -9, D: -7, E: -5, F: -4, G: -2, A: 0, B: 2 };

/** Frequency in Hz of a note name such as `A4`, `C#5` or `Bb3` (A4 = 440 Hz, equal temperament). */
export function noteFrequency(note: string): number {
  const m = /^([A-Ga-g])([#b]?)(-?\d)$/.exec(note.trim());
  if (!m) throw new Error(`bad note "${note}"`);
  const base = SEMITONES[m[1].toUpperCase()];
  const accidental = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0;
  const octave = Number(m[3]);
  const semis = base + accidental + (octave - 4) * 12;
  return 440 * 2 ** (semis / 12);
}

export type Timbre = 'sine' | 'bright';

export interface Note {
  /** Note name (`C4`) or null for a rest. */
  note: string | null;
  /** Length in beats (quarter notes). */
  beats: number;
}

export interface RenderOptions {
  bpm: number;
  sampleRate?: number;
  /** Peak amplitude 0..1 (default 0.5). */
  gain?: number;
  timbre?: Timbre;
}

/** Additive waveform: a sine, or a sine plus two softer harmonics for a brighter, more "instrumental" sound. */
function waveform(phase: number, timbre: Timbre): number {
  if (timbre === 'sine') return Math.sin(phase);
  return (Math.sin(phase) + 0.35 * Math.sin(2 * phase) + 0.15 * Math.sin(3 * phase)) / 1.5;
}

/** One tone with a short attack and release so notes never click, as Float32 samples in -1..1. */
export function tone(freq: number, seconds: number, opts: { sampleRate?: number; gain?: number; timbre?: Timbre } = {}): Float32Array {
  const sampleRate = opts.sampleRate ?? DEFAULT_SAMPLE_RATE;
  const gain = opts.gain ?? 0.5;
  const timbre = opts.timbre ?? 'sine';
  const n = Math.max(0, Math.round(seconds * sampleRate));
  const out = new Float32Array(n);
  const attack = Math.min(n, Math.round(0.008 * sampleRate));
  const release = Math.min(n, Math.round(Math.max(0.04 * sampleRate, n * 0.12)));
  for (let i = 0; i < n; i++) {
    let env = 1;
    if (i < attack) env = i / attack;
    if (i >= n - release) env = Math.min(env, (n - i) / release);
    // Gentle decay towards 70% so repeated notes stay articulated.
    env *= 1 - 0.3 * (i / n);
    out[i] = gain * env * waveform((2 * Math.PI * freq * i) / sampleRate, timbre);
  }
  return out;
}

/** Render a melody (notes + rests) to samples. */
export function renderMelody(notes: readonly Note[], opts: RenderOptions): Float32Array {
  const sampleRate = opts.sampleRate ?? DEFAULT_SAMPLE_RATE;
  const secondsPerBeat = 60 / opts.bpm;
  const parts: Float32Array[] = notes.map((n) => {
    const seconds = n.beats * secondsPerBeat;
    if (n.note === null) return new Float32Array(Math.round(seconds * sampleRate));
    return tone(noteFrequency(n.note), seconds, { sampleRate, gain: opts.gain, timbre: opts.timbre });
  });
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** Encode mono Float32 samples (-1..1) as a 16-bit PCM WAV file. */
export function encodeWav(samples: Float32Array, sampleRate = DEFAULT_SAMPLE_RATE): Buffer {
  const channels = 1;
  const bitsPerSample = 16;
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.length * blockAlign;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16); // PCM fmt chunk size
  buf.writeUInt16LE(1, 20); // audio format 1 = PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(bitsPerSample, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);
  let o = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), o);
    o += 2;
  }
  return buf;
}

export interface WavHeader {
  riffSize: number;
  audioFormat: number;
  channels: number;
  sampleRate: number;
  byteRate: number;
  blockAlign: number;
  bitsPerSample: number;
  dataSize: number;
}

/** Parse the 44-byte canonical header (used by tests and sanity checks). Throws when malformed. */
export function parseWavHeader(buf: Buffer): WavHeader {
  if (buf.length < 44) throw new Error('too short for a WAV header');
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a RIFF/WAVE file');
  if (buf.toString('ascii', 12, 16) !== 'fmt ') throw new Error('missing fmt chunk');
  if (buf.toString('ascii', 36, 40) !== 'data') throw new Error('missing data chunk');
  return {
    riffSize: buf.readUInt32LE(4),
    audioFormat: buf.readUInt16LE(20),
    channels: buf.readUInt16LE(22),
    sampleRate: buf.readUInt32LE(24),
    byteRate: buf.readUInt32LE(28),
    blockAlign: buf.readUInt16LE(32),
    bitsPerSample: buf.readUInt16LE(34),
    dataSize: buf.readUInt32LE(40),
  };
}
