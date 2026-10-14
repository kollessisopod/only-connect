-- Only Connect — twelve hieroglyphs and walls chosen by hieroglyph (SPEC §3.1, §3.3, §6).
--
-- 1. questions.hieroglyph: the inline CHECK from 001 only allowed the show's six glyphs; rounds may now hold up
--    to twelve questions, one per glyph. The constraint in 001 was unnamed, so its generated name
--    (questions_hieroglyph_check in practice) is looked up in pg_constraint rather than assumed.
-- 2. walls.hieroglyph: the glyph a team chooses a wall by (unique among a pack's walls). Existing rows are
--    backfilled in pack order: the first wall gets 'lion', the second 'water' (the show's two wall glyphs), any
--    further ones the rest of HIEROGLYPHS in grid order.

DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE rel.relname = 'questions'
      AND nsp.nspname = current_schema()
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%hieroglyph%'
  LOOP
    EXECUTE format('ALTER TABLE questions DROP CONSTRAINT IF EXISTS %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE questions DROP CONSTRAINT IF EXISTS questions_hieroglyph_check;
ALTER TABLE questions ADD CONSTRAINT questions_hieroglyph_check CHECK (
  hieroglyph IN ('twoReeds', 'lion', 'twistedFlax', 'hornedViper', 'water', 'eyeOfHorus',
                 'ankh', 'scarab', 'feather', 'owl', 'cobra', 'sun')
);

ALTER TABLE walls ADD COLUMN IF NOT EXISTS hieroglyph text NOT NULL DEFAULT 'lion';

-- Backfill rows that predate the column (every row got the default 'lion' when the column was added; this
-- migration runs once, so all of them are pre-contract rows): wall 1 -> lion, wall 2 -> water, then the rest.
WITH ordered AS (
  SELECT id, row_number() OVER (PARTITION BY pack_id ORDER BY position, created_at, id) AS n
  FROM walls
)
UPDATE walls w
SET hieroglyph = (ARRAY['lion', 'water', 'twoReeds', 'twistedFlax', 'hornedViper', 'eyeOfHorus',
                        'ankh', 'scarab', 'feather', 'owl', 'cobra', 'sun'])[((o.n - 1) % 12) + 1]
FROM ordered o
WHERE w.id = o.id;

ALTER TABLE walls DROP CONSTRAINT IF EXISTS walls_hieroglyph_check;
ALTER TABLE walls ADD CONSTRAINT walls_hieroglyph_check CHECK (
  hieroglyph IN ('twoReeds', 'lion', 'twistedFlax', 'hornedViper', 'water', 'eyeOfHorus',
                 'ankh', 'scarab', 'feather', 'owl', 'cobra', 'sun')
);
CREATE INDEX IF NOT EXISTS walls_pack_position_idx ON walls (pack_id, position);
