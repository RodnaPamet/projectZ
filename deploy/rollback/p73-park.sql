-- ROLLING BACK PAST P73: park every row the previous image cannot read.
--
-- P73 (#550, telling people about lessons) added seven values to
-- "NotificationKind": LESSON_BOOKED, LESSON_CANCELLED, LESSON_REMINDER,
-- COACH_LINK_REQUESTED, COACH_LINK_ACCEPTED, COACH_LINK_DECLINED and
-- COACH_LINK_ENDED. An image built before P73 was generated without them, and
-- Prisma 7 REFUSES a whole query that reads one:
--
--     PrismaClientKnownRequestError: Value 'LESSON_BOOKED' not found in enum 'NotificationKind'
--
-- The bell reads a person's notifications on every page, so one such row
-- would break the previous image's bell for that coach or that club's owner.
-- Run this BEFORE starting the previous image, and `p73-unpark.sql` after
-- rolling forward again (docs/deploy-gcp.md, "Rolling back past p73").
--
-- What it does, in one transaction: every notification row of those kinds is
-- copied to p73_parked_notification and removed, and every email_outbox row of
-- those kinds (queued or already sent: the outbox keeps a row after it goes)
-- to p73_parked_email_outbox. Then every column of type NotificationKind,
-- found from the catalogue, is checked; if any still holds one of the seven,
-- the transaction is rolled back. The column app_user."emailLessonsTaught"
-- stays: the previous image does not map it.
--
-- Safe to run twice. Run as the database owner:
--
--   docker exec -i playerz-db psql -U playerz -d playerz_production -v ON_ERROR_STOP=1 \
--     < /opt/playerz/repo/deploy/rollback/p73-park.sql

BEGIN;

CREATE TABLE IF NOT EXISTS "p73_parked_notification" (LIKE "notification");
ALTER TABLE "p73_parked_notification" ALTER COLUMN "kind" TYPE TEXT;

INSERT INTO "p73_parked_notification"
SELECT * FROM "notification"
WHERE "kind"::text LIKE 'LESSON\_%' OR "kind"::text LIKE 'COACH\_LINK\_%';
DELETE FROM "notification"
WHERE "kind"::text LIKE 'LESSON\_%' OR "kind"::text LIKE 'COACH\_LINK\_%';

CREATE TABLE IF NOT EXISTS "p73_parked_email_outbox" (LIKE "email_outbox");
ALTER TABLE "p73_parked_email_outbox" ALTER COLUMN "kind" TYPE TEXT;

INSERT INTO "p73_parked_email_outbox"
SELECT * FROM "email_outbox"
WHERE "kind"::text LIKE 'LESSON\_%' OR "kind"::text LIKE 'COACH\_LINK\_%';
DELETE FROM "email_outbox"
WHERE "kind"::text LIKE 'LESSON\_%' OR "kind"::text LIKE 'COACH\_LINK\_%';

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
      'SELECT count(*) FROM %I WHERE %I::text LIKE ''LESSON\_%%'' OR %I::text LIKE ''COACH\_LINK\_%%''',
      col.table_name, col.column_name, col.column_name) INTO n;
    IF n > 0 THEN
      RAISE EXCEPTION
        'p73 park: %.% still holds % row(s) of a kind P73 added, which the previous image cannot read. Nothing was parked.',
        col.table_name, col.column_name, n;
    END IF;
  END LOOP;
END $$;

COMMIT;
