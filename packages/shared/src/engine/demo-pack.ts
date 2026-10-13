/**
 * A complete, genuinely playable demo pack. The API seeds the database with it on first boot and the engine
 * tests use it as their fixture.
 *
 * Media clues reference objects under `demo/` in the bucket (`/api/media/demo/...`). Pass
 * `{ media: false }` to turn them into plain text clues (useful when the bucket has not been seeded).
 */
import type { Clue, Hieroglyph, MediaRef, Pack, Question, VowelGroup, Wall } from '../types.js';
import { stripVowels } from './vowels-text.js';

export interface DemoPackOptions {
  /** Include image/audio clues (default true). */
  media?: boolean;
  /** Pack name (default "Demo pack"). */
  name?: string;
  /** ISO timestamp for createdAt/updatedAt (default: fixed, for determinism). */
  timestamp?: string;
}

export const DEMO_MEDIA_PREFIX = 'demo/';

function media(file: string, mime: string): MediaRef {
  const key = `${DEMO_MEDIA_PREFIX}${file}`;
  return { key, url: `/api/media/${key}`, mime, name: file };
}

function text(t: string): Clue {
  return { kind: 'text', text: t };
}

function image(caption: string, file: string): Clue {
  return { kind: 'image', text: caption, media: media(file, 'image/svg+xml') };
}

/** The API seeds these as WAV files synthesised in code (sine/additive tones — no recordings). */
function audio(caption: string, file: string): Clue {
  return { kind: 'audio', text: caption, media: media(file, 'audio/wav') };
}

interface QuestionSpec {
  hieroglyph: Hieroglyph;
  clues: Clue[];
  answer: string;
  note?: string;
}

const CONNECTIONS: QuestionSpec[] = [
  {
    hieroglyph: 'twoReeds',
    clues: [text('A whip'), text('A code'), text('A joke'), text('An egg')],
    answer: 'Things you can crack',
    note: 'Also: a safe, a smile, knuckles.',
  },
  {
    hieroglyph: 'lion',
    clues: [text('Dash'), text('Skate'), text('Cup'), text('Key')],
    answer: 'Words before "board"',
    note: 'Dashboard, skateboard, cupboard, keyboard.',
  },
  {
    hieroglyph: 'twistedFlax',
    clues: [
      image('Flag of Palau', 'flag-palau.svg'),
      image('Flag of Bangladesh', 'flag-bangladesh.svg'),
      image('Flag of Laos', 'flag-laos.svg'),
      image('Flag of Japan', 'flag-japan.svg'),
    ],
    answer: 'Flags with a single disc on them',
    note: 'Yellow moon (Palau), red sun (Bangladesh), white moon (Laos), red sun (Japan).',
  },
  {
    hieroglyph: 'hornedViper',
    clues: [
      audio('William Tell Overture (Rossini)', 'william-tell.wav'),
      audio('Flight of the Bumblebee (Rimsky-Korsakov)', 'bumblebee.wav'),
      audio('Ride of the Valkyries (Wagner)', 'valkyries.wav'),
      audio('Habanera (Bizet)', 'habanera.wav'),
    ],
    answer: 'Music from operas',
    note: 'William Tell, The Tale of Tsar Saltan, Die Walküre, Carmen.',
  },
  {
    hieroglyph: 'water',
    clues: [text('Piquet'), text('Rockefeller'), text('Mandela'), text('Horatio')],
    answer: 'Famous Nelsons',
    note: 'Nelson Piquet (F1), Nelson Rockefeller, Nelson Mandela, Horatio Nelson.',
  },
  {
    hieroglyph: 'eyeOfHorus',
    clues: [text('Canaveral'), text('Horn'), text('Cod'), text('Town')],
    answer: 'Cape ___',
  },
];

const SEQUENCES: QuestionSpec[] = [
  {
    hieroglyph: 'twoReeds',
    clues: [text('Mercury'), text('Venus'), text('Earth'), text('Mars')],
    answer: 'Mars (planets outward from the Sun)',
  },
  {
    hieroglyph: 'lion',
    clues: [text('25th: Silver'), text('40th: Ruby'), text('50th: Golden'), text('60th: Diamond')],
    answer: '60th: Diamond (wedding anniversaries)',
  },
  {
    hieroglyph: 'twistedFlax',
    clues: [
      image('New moon', 'moon-new.svg'),
      image('Waxing crescent', 'moon-waxing-crescent.svg'),
      image('First quarter', 'moon-first-quarter.svg'),
      image('Waxing gibbous', 'moon-waxing-gibbous.svg'),
    ],
    answer: 'Waxing gibbous (phases of the Moon)',
  },
  {
    hieroglyph: 'hornedViper',
    clues: [text('Tony Blair'), text('Gordon Brown'), text('David Cameron'), text('Theresa May')],
    answer: 'Theresa May (UK prime ministers in order)',
  },
  {
    hieroglyph: 'water',
    clues: [text('Hydrogen'), text('Helium'), text('Lithium'), text('Beryllium')],
    answer: 'Beryllium (elements by atomic number)',
    note: 'Accept "Be".',
  },
  {
    hieroglyph: 'eyeOfHorus',
    clues: [audio('Do', 'solfege-do.wav'), audio('Re', 'solfege-re.wav'), audio('Mi', 'solfege-mi.wav'), audio('Fa', 'solfege-fa.wav')],
    answer: 'Fa (the solfège scale)',
  },
];

const WALLS: Wall['groups'][] = [
  [
    { connection: 'Shakespeare plays', clues: ['Macbeth', 'Othello', 'Pericles', 'Cymbeline'] },
    { connection: 'Pasta shapes', clues: ['Penne', 'Orzo', 'Farfalle', 'Fusilli'] },
    { connection: 'Moons of Jupiter', clues: ['Io', 'Europa', 'Ganymede', 'Callisto'] },
    { connection: 'Characters in The Tempest', clues: ['Prospero', 'Miranda', 'Caliban', 'Ariel'] },
  ],
  [
    { connection: 'Chess pieces', clues: ['Rook', 'Bishop', 'Knight', 'Pawn'] },
    { connection: 'Members of the crow family', clues: ['Raven', 'Jackdaw', 'Magpie', 'Jay'] },
    { connection: 'Poker hands', clues: ['Flush', 'Straight', 'Full House', 'Pair'] },
    { connection: '___fish', clues: ['Sword', 'Cat', 'Jelly', 'Star'] },
  ],
];

const VOWEL_GROUPS: Array<{ category: string; answers: string[] }> = [
  { category: 'Capital cities', answers: ['Paris', 'Buenos Aires', 'Copenhagen', 'Kuala Lumpur'] },
  { category: 'Breakfast cereals', answers: ['Corn Flakes', 'Rice Krispies', 'Shredded Wheat', 'Coco Pops'] },
  { category: 'Rivers of Europe', answers: ['Danube', 'Thames', 'Rhine', 'Seine'] },
];

function toTextClue(clue: Clue): Clue {
  return { kind: 'text', text: clue.text };
}

/**
 * Builds the demo pack. `idFactory` supplies ids (uuids in the API; anything unique in tests).
 */
export function buildDemoPack(idFactory: () => string, options: DemoPackOptions = {}): Pack {
  const useMedia = options.media !== false;
  const timestamp = options.timestamp ?? '2024-01-01T00:00:00.000Z';
  const makeQuestion = (round: Question['round'], spec: QuestionSpec, position: number): Question => {
    // No `media: undefined` keys, so the object round-trips through JSON unchanged.
    const clues: Clue[] = spec.clues.map((c) =>
      useMedia && c.media ? { kind: c.kind, text: c.text, media: { ...c.media } } : toTextClue(c),
    );
    const q: Question = { id: idFactory(), round, hieroglyph: spec.hieroglyph, position, clues, answer: spec.answer };
    if (spec.note) q.note = spec.note;
    return q;
  };
  const questions: Question[] = [
    ...CONNECTIONS.map((spec, i) => makeQuestion('connections', spec, i)),
    ...SEQUENCES.map((spec, i) => makeQuestion('sequences', spec, i)),
  ];
  const walls: Wall[] = WALLS.map((groups, i) => ({
    id: idFactory(),
    position: i,
    groups: groups.map((g) => ({ connection: g.connection, clues: [...g.clues] })),
  }));
  const vowelGroups: VowelGroup[] = VOWEL_GROUPS.map((g, i) => ({
    id: idFactory(),
    position: i,
    category: g.category,
    clues: g.answers.map((answer) => ({ answer: answer.toUpperCase(), display: stripVowels(answer) })),
  }));
  return {
    id: idFactory(),
    name: options.name ?? 'Demo pack',
    questions,
    walls,
    vowelGroups,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
