-- ROLLING BACK PAST P91: park every row the previous image cannot read.
--
-- P91 (#714, the statement of reasons for a refused review) added one value
-- to "NotificationKind": REVIEW_REFUSED. An image built before P91 was
-- generated without it, and Prisma 7 REFUSES a whole query that reads one:
--
--     PrismaClientKnownRequestError: Value 'REVIEW_REFUSED' not found in enum 'NotificationKind'
--
-- The bell reads a person's notifications on every page, so one refused review
-- would break the previous image's bell for its author. Run this BEFORE
-- starting the previous image, and `p91-unpark.sql` after rolling forward
-- again (docs/deploy-gcp.md, "Rolling back past p91").
--
-- What it does, in one transaction: every notification and email_outbox row
-- of that kind is copied to a park table and removed. Then every column of
-- type NotificationKind, found from the catalogue, is checked, and if any
-- still holds the value the transaction is rolled back. The new review and
-- coach_review columns stay: the previous image does not map them, and they
-- are nullable, so its inserts still succeed.
--
-- Safe to run twice. Run as the database owner:
--
--   docker exec -i playerz-db psql -U playerz -d playerz_production -v ON_ERROR_STOP=1 \
--     < /opt/playerz/repo/deploy/rollback/p91-park.sql

BEGIN;

CREATE TABLE IF NOT EXISTS "p91_parked_notification" (LIKE "notification");
ALTER TABLE "p91_parked_notification" ALTER COLUMN "kind" TYPE TEXT;
CREATE TABLE IF NOT EXISTS "p91_parked_email_outbox" (LIKE "email_outbox");
ALTER TABLE "p91_parked_email_outbox" ALTER COLUMN "kind" TYPE TEXT;

INSERT INTO "p91_parked_notification"
SELECT * FROM "notification" WHERE "kind"::text = 'REVIEW_REFUSED';
DELETE FROM "notification" WHERE "kind"::text = 'REVIEW_REFUSED';

INSERT INTO "p91_parked_email_outbox"
SELECT * FROM "email_outbox" WHERE "kind"::text = 'REVIEW_REFUSED';
DELETE FROM "email_outbox" WHERE "kind"::text = 'REVIEW_REFUSED';

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
      'SELECT count(*) FROM %I WHERE %I::text = ''REVIEW_REFUSED''',
      col.table_name, col.column_name) INTO n;
    IF n > 0 THEN
      RAISE EXCEPTION
        'p91 park: %.% still holds % row(s) of the kind P91 added, which the previous image cannot read. Nothing was parked.',
        col.table_name, col.column_name, n;
    END IF;
  END LOOP;
END $$;

COMMIT;
