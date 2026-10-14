-- P75 (#482): finding a player by name, in either alphabet, on an index.
--
-- `searchPlayers` was `name ILIKE '%q%'`: a sequential scan, and "Ivan" did
-- not find «Иван». Now both the name and the query are FOLDED to one form,
-- lower-case Latin by the Bulgarian streamlined transliteration (also the
-- Russian letters a Sofia player may type), and the folded name has a trigram
-- index, so `LIKE '%ivan%'` reads the index.
--
--   playerz_name_fold(text)  IMMUTABLE; the same mapping as
--                            src/lib/text/name-fold.ts, checked against it
--                            by tests/integration/player-name-search.test.ts
--   app_user_name_fold_trgm_idx  GIN (gin_trgm_ops) on the folded name, for
--                            the rows search can return
--
-- Prisma models neither, so `migrate diff` would propose dropping the index:
-- the migration-safety ratchet protects it, as it does venue_geog_idx.
-- Additive: the image before P75 never calls the function and ignores the
-- index, so rolling back needs nothing.
SET lock_timeout = '5s';

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE OR REPLACE FUNCTION playerz_name_fold(input text) RETURNS text
  LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
AS $$
  SELECT translate(
    replace(replace(replace(replace(replace(replace(replace(replace(replace(
      translate(
        lower(input),
        'АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЬЮЯЁЫЭЍ',
        'абвгдежзийклмнопрстуфхцчшщъьюяёыэѝ'
      ),
      'щ', 'sht'), 'ж', 'zh'), 'ч', 'ch'), 'ш', 'sh'), 'ц', 'ts'),
      'ю', 'yu'), 'я', 'ya'), 'х', 'h'), 'ё', 'yo'),
    'абвгдезийклмнопрстуфъьыэѝ',
    'abvgdeziyklmnoprstufayyei'
  )
$$;

CREATE INDEX IF NOT EXISTS app_user_name_fold_trgm_idx
  ON "app_user" USING gin (playerz_name_fold("name") gin_trgm_ops)
  WHERE "searchable" = true AND "deletedAt" IS NULL;
