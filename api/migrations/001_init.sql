-- Only Connect — initial schema (see docs/SPEC.md §6).
-- gen_random_uuid() is built into Postgres 13+.

CREATE TABLE IF NOT EXISTS packs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS questions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pack_id     uuid NOT NULL REFERENCES packs(id) ON DELETE CASCADE,
  round       text NOT NULL CHECK (round IN ('connections', 'sequences')),
  hieroglyph  text NOT NULL CHECK (hieroglyph IN ('twoReeds', 'lion', 'twistedFlax', 'hornedViper', 'water', 'eyeOfHorus')),
  position    integer NOT NULL DEFAULT 0,
  clues       jsonb NOT NULL DEFAULT '[]'::jsonb,
  answer      text NOT NULL DEFAULT '',
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS questions_pack_id_idx ON questions (pack_id);
CREATE INDEX IF NOT EXISTS questions_pack_round_position_idx ON questions (pack_id, round, position);

CREATE TABLE IF NOT EXISTS walls (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pack_id     uuid NOT NULL REFERENCES packs(id) ON DELETE CASCADE,
  position    integer NOT NULL DEFAULT 0,
  groups      jsonb NOT NULL DEFAULT '[]'::jsonb,   -- WallGroup[4]
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS walls_pack_id_idx ON walls (pack_id);

CREATE TABLE IF NOT EXISTS vowel_groups (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pack_id     uuid NOT NULL REFERENCES packs(id) ON DELETE CASCADE,
  position    integer NOT NULL DEFAULT 0,
  category    text NOT NULL DEFAULT '',
  clues       jsonb NOT NULL DEFAULT '[]'::jsonb,   -- VowelClue[]
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vowel_groups_pack_id_idx ON vowel_groups (pack_id);

CREATE TABLE IF NOT EXISTS games (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pack_id     uuid REFERENCES packs(id) ON DELETE SET NULL,   -- the game keeps its own pack snapshot in state
  state       jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS games_pack_id_idx ON games (pack_id);
CREATE INDEX IF NOT EXISTS games_updated_at_idx ON games (updated_at DESC);

CREATE TABLE IF NOT EXISTS media (
  key            text PRIMARY KEY,
  mime           text NOT NULL,
  size           bigint NOT NULL DEFAULT 0,
  original_name  text NOT NULL DEFAULT '',
  created_at     timestamptz NOT NULL DEFAULT now()
);
