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

DROP TABLE "p61_parked_notification";

COMMIT;
