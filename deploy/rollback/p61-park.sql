-- ROLLING BACK PAST P61: park every row the previous image cannot read.
--
-- P61 (#376, open play) added five values to "NotificationKind":
-- OPEN_PLAY_REQUESTED, OPEN_PLAY_ACCEPTED, OPEN_PLAY_DECLINED,
-- OPEN_PLAY_LAPSED and OPEN_PLAY_CLOSED. An image built before P61 was
-- generated without them, and Prisma 7 REFUSES a whole query that reads one:
--
--     PrismaClientKnownRequestError: Value 'OPEN_PLAY_REQUESTED' not found in enum 'NotificationKind'
--
-- The bell reads a person's notifications on every page, so one open-play row
-- would break the previous image's bell for that person. Run this BEFORE
-- starting the previous image, and `p61-unpark.sql` after rolling forward
-- again (docs/deploy-gcp.md, "Rolling back past p61").
--
-- What it does, in one transaction: every notification row of those kinds is
-- copied to p61_parked_notification and removed. Then every column of type
-- NotificationKind, found from the catalogue, is checked; if any still holds
-- an OPEN_PLAY_ value, the transaction is rolled back. The open-play tables
-- and columns stay: the previous image does not map them.
--
-- Safe to run twice. Run as the database owner:
--
--   docker exec -i playerz-db psql -U playerz -d playerz_production -v ON_ERROR_STOP=1 \
--     < /opt/playerz/repo/deploy/rollback/p61-park.sql

BEGIN;

CREATE TABLE IF NOT EXISTS "p61_parked_notification" (LIKE "notification");
ALTER TABLE "p61_parked_notification" ALTER COLUMN "kind" TYPE TEXT;

INSERT INTO "p61_parked_notification"
SELECT * FROM "notification" WHERE "kind"::text LIKE 'OPEN\_PLAY\_%';
DELETE FROM "notification" WHERE "kind"::text LIKE 'OPEN\_PLAY\_%';

DO $$
DECLARE
  col record;
  n bigint;
BEGIN
  FOR col IN
    SELECT c.table_name, c.column_name
    FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.udt_name = 'NotificationKind'
  LOOP
    EXECUTE format('SELECT count(*) FROM %I WHERE %I::text LIKE ''OPEN\_PLAY\_%%''',
      col.table_name, col.column_name) INTO n;
    IF n > 0 THEN
      RAISE EXCEPTION
        'p61 park: %.% still holds % row(s) of an OPEN_PLAY_ kind, which the previous image cannot read. Nothing was parked.',
        col.table_name, col.column_name, n;
    END IF;
  END LOOP;
END $$;

COMMIT;
