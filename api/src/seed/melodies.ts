/**
 * Note data for the demo pack's audio clues. Everything here is synthesised from scratch at seed time:
 *  - the solfège clues are single 0.8 s sine notes (Do Re Mi Fa = C4 D4 E4 F4);
 *  - the "music from operas" clues are short monophonic sketches of the opening motifs of four
 *    public-domain compositions (Rossini 1829, Rimsky-Korsakov 1900, Wagner 1856, Bizet 1875), transcribed
 *    as note lists and rendered with the tone generator. No recordings are involved.
 */
import type { Note, RenderOptions } from './wav.js';

export interface Melody {
  notes: Note[];
  options: RenderOptions;
}

const n = (note: string | null, beats: number): Note => ({ note, beats });

/** A single sustained note (the solfège clues). */
function single(note: string, seconds = 0.8): Melody {
  return { notes: [n(note, 1)], options: { bpm: 60 / seconds, timbre: 'sine', gain: 0.5 } };
}

/** William Tell Overture, finale (galop): the trumpet fanfare rhythm on the dominant, then the E-major arpeggio. */
const williamTell: Melody = {
  options: { bpm: 168, timbre: 'bright', gain: 0.45 },
  notes: [
    ...[0, 1].flatMap(() => [n('B3', 0.5), n('B3', 0.5), n('B3', 1), n('B3', 0.5), n('B3', 0.5), n('B3', 1), n('B3', 0.5), n('B3', 0.5), n('B3', 0.5), n('B3', 0.5), n('B3', 1), n(null, 0.5)]),
    n('E4', 0.5), n('E4', 0.5), n('E4', 1),
    n('G#4', 0.5), n('G#4', 0.5), n('G#4', 1),
    n('B4', 0.5), n('B4', 0.5), n('B4', 0.5), n('B4', 0.5), n('B4', 1),
    n(null, 1),
  ],
};

/** Flight of the Bumblebee: the chromatic sixteenth-note run down and back up. */
const bumblebee: Melody = {
  options: { bpm: 150, timbre: 'bright', gain: 0.45 },
  notes: [
    ...['E5', 'D#5', 'D5', 'C#5', 'C5', 'B4', 'A#4', 'A4', 'G#4', 'A4', 'A#4', 'B4', 'C5', 'C#5', 'D5', 'D#5'].map((x) => n(x, 0.25)),
    ...['E5', 'D#5', 'D5', 'C#5', 'C5', 'B4', 'A#4', 'A4', 'G#4', 'G4', 'F#4', 'F4', 'E4', 'D#4', 'D4', 'C#4'].map((x) => n(x, 0.25)),
    ...['C4', 'C#4', 'D4', 'D#4', 'E4', 'F4', 'F#4', 'G4', 'G#4', 'A4', 'A#4', 'B4', 'C5', 'C#5', 'D5', 'D#5'].map((x) => n(x, 0.25)),
    n('E5', 1),
    n(null, 0.5),
  ],
};

/** Ride of the Valkyries: the rising B-minor arpeggio motif with its dotted pick-up rhythm. */
const valkyries: Melody = {
  options: { bpm: 112, timbre: 'bright', gain: 0.45 },
  notes: [
    n('F#3', 0.25), n('B3', 0.25), n('B3', 0.75), n('D4', 0.25), n('F#4', 1.5),
    n('F#4', 0.25), n('D4', 0.25), n('D4', 0.75), n('F#4', 0.25), n('B4', 1.5),
    n('B4', 0.25), n('F#4', 0.25), n('F#4', 0.75), n('B4', 0.25), n('D5', 1.5),
    n(null, 0.5),
  ],
};

/** Habanera from Carmen: the descending chromatic line over the habanera rhythm. */
const habanera: Melody = {
  options: { bpm: 96, timbre: 'bright', gain: 0.45 },
  notes: [
    n('D5', 0.75), n('D5', 0.25), n('C#5', 0.5), n('C5', 0.5),
    n('B4', 0.75), n('B4', 0.25), n('B4', 0.5), n('A#4', 0.5),
    n('A4', 0.75), n('A4', 0.25), n('G#4', 0.5), n('G4', 0.5),
    n('F#4', 0.75), n('F4', 0.25), n('E4', 0.5), n('D4', 0.5),
    n('D4', 1.5),
    n(null, 0.5),
  ],
};

/** Demo audio clues keyed by the file name used in the demo pack (see packages/shared engine/demo-pack.ts). */
export const DEMO_MELODIES: Record<string, Melody> = {
  'solfege-do.wav': single('C4'),
  'solfege-re.wav': single('D4'),
  'solfege-mi.wav': single('E4'),
  'solfege-fa.wav': single('F4'),
  'william-tell.wav': williamTell,
  'bumblebee.wav': bumblebee,
  'valkyries.wav': valkyries,
  'habanera.wav': habanera,
};
