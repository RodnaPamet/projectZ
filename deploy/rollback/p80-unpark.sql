-- ROLLING FORWARD AGAIN AFTER p80-park.sql: put the parked rows back.
--
-- Run once the image with P80 is running again: every notification and
-- email_outbox row p80-park.sql moved aside goes back where it was, and the
-- two parking tables are dropped. Safe to run twice; a row already back is
-- skipped (ON CONFLICT DO NOTHING).
--
--   docker exec -i playerz-db psql -U playerz -d playerz_production -v ON_ERROR_STOP=1 \
--     < /opt/playerz/repo/deploy/rollback/p80-unpark.sql

BEGIN;

CREATE TABLE IF NOT EXISTS "p80_parked_notification" (LIKE "notification");
ALTER TABLE "p80_parked_notification" ALTER COLUMN "kind" TYPE TEXT;
CREATE TABLE IF NOT EXISTS "p80_parked_email_outbox" (LIKE "email_outbox");
ALTER TABLE "p80_parked_email_outbox" ALTER COLUMN "kind" TYPE TEXT;

-- Column by column, in each table's own order, through a cast: the park
-- tables hold the kind as text.
DO $$
DECLARE
  t text;
  cols text;
  vals text;
BEGIN
  FOREACH t IN ARRAY ARRAY['notification', 'email_outbox'] LOOP
    SELECT string_agg(format('%I', column_name), ', ' ORDER BY ordinal_position),
           string_agg(
             CASE WHEN column_name = 'kind'
                  THEN format('%I::"NotificationKind"', column_name)
                  ELSE format('%I', column_name) END,
             ', ' ORDER BY ordinal_position)
    INTO cols, vals
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = t;
    EXECUTE format('INSERT INTO %I (%s) SELECT %s FROM %I ON CONFLICT DO NOTHING',
      t, cols, vals, 'p80_parked_' || t);
  END LOOP;
END $$;

DROP TABLE "p80_parked_notification";
DROP TABLE "p80_parked_email_outbox";

COMMIT;
