-- ROLLING BACK PAST P79: park every row the previous image cannot read.
--
-- P79 (#575, results of bookings) added three values to "NotificationKind":
-- RESULT_REPORTED, RESULT_DISPUTED and RESULT_DECIDED. An image built before
-- P79 was generated without them, and Prisma 7 REFUSES a whole query that
-- reads one:
--
--     PrismaClientKnownRequestError: Value 'RESULT_REPORTED' not found in enum 'NotificationKind'
--
-- The bell reads a person's notifications on every page, so one such row
-- would break the previous image's bell for that person. Run this BEFORE
-- starting the previous image, and `p79-unpark.sql` after rolling forward
-- again (docs/deploy-gcp.md, "Rolling back past p79").
--
-- What it does, in one transaction: every notification row of those kinds is
-- copied to p79_parked_notification and removed, and every email_outbox row of
-- those kinds to p79_parked_email_outbox. Then every column of type
-- NotificationKind, found from the catalogue, is checked; if any still holds
-- one of the three, the transaction is rolled back. The match_report table and
-- its triggers stay: the previous image does not map them.
--
-- Safe to run twice. Run as the database owner:
--
--   docker exec -i playerz-db psql -U playerz -d playerz_production -v ON_ERROR_STOP=1 \
--     < /opt/playerz/repo/deploy/rollback/p79-park.sql

BEGIN;

CREATE TABLE IF NOT EXISTS "p79_parked_notification" (LIKE "notification");
ALTER TABLE "p79_parked_notification" ALTER COLUMN "kind" TYPE TEXT;

INSERT INTO "p79_parked_notification"
SELECT * FROM "notification"
WHERE "kind"::text LIKE 'RESULT\_%';
DELETE FROM "notification"
WHERE "kind"::text LIKE 'RESULT\_%';

CREATE TABLE IF NOT EXISTS "p79_parked_email_outbox" (LIKE "email_outbox");
ALTER TABLE "p79_parked_email_outbox" ALTER COLUMN "kind" TYPE TEXT;

INSERT INTO "p79_parked_email_outbox"
SELECT * FROM "email_outbox"
WHERE "kind"::text LIKE 'RESULT\_%';
DELETE FROM "email_outbox"
WHERE "kind"::text LIKE 'RESULT\_%';

DO $$
DECLARE
  col record;
  n bigint;
BEGIN
  FOR col IN
    SELECT c.table_name, c.column_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public'
      AND t.table_type = 'BASE TABLE'
      AND c.udt_name = 'NotificationKind'
  LOOP
    EXECUTE format(
      'SELECT count(*) FROM %I WHERE %I::text LIKE ''RESULT\_%%''',
      col.table_name, col.column_name) INTO n;
    IF n > 0 THEN
      RAISE EXCEPTION
        'p79 park: %.% still holds % row(s) of a kind P79 added, which the previous image cannot read. Nothing was parked.',
        col.table_name, col.column_name, n;
    END IF;
  END LOOP;
END $$;

COMMIT;
