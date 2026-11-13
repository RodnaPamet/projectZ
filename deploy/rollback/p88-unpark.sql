-- ROLLING FORWARD AGAIN AFTER p88-park.sql: put the parked rows back.
--
-- Run once the image with P88 is running again: every notification row
-- p88-park.sql moved aside goes back where it was, and the parking table is
-- dropped. Safe to run twice; a row already back is skipped (ON CONFLICT DO
-- NOTHING). A day's fact the job wrote again while the rows were parked keeps
-- the new row: the dedupe key is unique per person, so the parked one is the
-- row skipped.
--
--   docker exec -i playerz-db psql -U playerz -d playerz_production -v ON_ERROR_STOP=1 \
--     < /opt/playerz/repo/deploy/rollback/p88-unpark.sql

BEGIN;

CREATE TABLE IF NOT EXISTS "p88_parked_notification" (LIKE "notification");
ALTER TABLE "p88_parked_notification" ALTER COLUMN "kind" TYPE TEXT;

-- Column by column, in the table's own order, through a cast: the park table
-- holds the kind as text.
DO $$
DECLARE
  cols text;
  vals text;
BEGIN
  SELECT string_agg(format('%I', column_name), ', ' ORDER BY ordinal_position),
         string_agg(
           CASE WHEN column_name = 'kind'
                THEN format('%I::"NotificationKind"', column_name)
                ELSE format('%I', column_name) END,
           ', ' ORDER BY ordinal_position)
  INTO cols, vals
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'notification';
  EXECUTE format('INSERT INTO "notification" (%s) SELECT %s FROM "p88_parked_notification" ON CONFLICT DO NOTHING',
    cols, vals);
END $$;

DROP TABLE "p88_parked_notification";

COMMIT;
