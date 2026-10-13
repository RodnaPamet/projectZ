-- ROLLING FORWARD AGAIN AFTER p61-park.sql: give back what it parked.
--
-- The open-play bell rows return to "notification", and the park table goes.
-- Run it once the P61 (or later) image is running again. Safe when nothing
-- was parked: the table is created empty first. A row the person's bell got
-- again in the meantime (same person and dedupe key) is not duplicated.
--
--   docker exec -i playerz-db psql -U playerz -d playerz_production -v ON_ERROR_STOP=1 \
--     < /opt/playerz/repo/deploy/rollback/p61-unpark.sql

BEGIN;

CREATE TABLE IF NOT EXISTS "p61_parked_notification" (LIKE "notification");
ALTER TABLE "p61_parked_notification" ALTER COLUMN "kind" TYPE TEXT;

INSERT INTO "notification" ("id", "tenantId", "userId", "kind", "title", "body", "href",
                            "refType", "refId", "readAt", "dedupeKey", "createdAt")
SELECT "id", "tenantId", "userId", "kind"::"NotificationKind", "title", "body", "href",
       "refType", "refId", "readAt", "dedupeKey", "createdAt"
FROM "p61_parked_notification"
ON CONFLICT DO NOTHING;

-- The queued and sent emails of those kinds (#555). Column by column, in the
-- table's own order, through a cast: the park table holds the kind as text.
CREATE TABLE IF NOT EXISTS "p61_parked_email_outbox" (LIKE "email_outbox");
ALTER TABLE "p61_parked_email_outbox" ALTER COLUMN "kind" TYPE TEXT;

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
  WHERE table_schema = 'public' AND table_name = 'email_outbox';
  EXECUTE format(
    'INSERT INTO "email_outbox" (%s) SELECT %s FROM "p61_parked_email_outbox" ON CONFLICT DO NOTHING',
    cols, vals);
END $$;

DROP TABLE "p61_parked_notification";
DROP TABLE "p61_parked_email_outbox";

COMMIT;
