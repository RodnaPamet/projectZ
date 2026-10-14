-- ROLLING FORWARD AGAIN AFTER p73-park.sql: give back what it parked.
--
-- The lesson and coach-link bell rows return to "notification", the queued
-- and sent emails of those kinds to "email_outbox", and the park tables go.
-- Run it once the P73 (or later) image is running again. Safe when nothing
-- was parked: the tables are created empty first. A row a person's bell got
-- again in the meantime (same person and dedupe key) is not duplicated.
--
--   docker exec -i playerz-db psql -U playerz -d playerz_production -v ON_ERROR_STOP=1 \
--     < /opt/playerz/repo/deploy/rollback/p73-unpark.sql

BEGIN;

CREATE TABLE IF NOT EXISTS "p73_parked_notification" (LIKE "notification");
ALTER TABLE "p73_parked_notification" ALTER COLUMN "kind" TYPE TEXT;
CREATE TABLE IF NOT EXISTS "p73_parked_email_outbox" (LIKE "email_outbox");
ALTER TABLE "p73_parked_email_outbox" ALTER COLUMN "kind" TYPE TEXT;

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
      t, cols, vals, 'p73_parked_' || t);
  END LOOP;
END $$;

DROP TABLE "p73_parked_notification";
DROP TABLE "p73_parked_email_outbox";

COMMIT;
