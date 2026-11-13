-- ROLLING BACK PAST P88: park every row the previous image cannot read.
--
-- P88 («Факт на седмицата») added one value to "NotificationKind": SPORT_FACT. An
-- image built before P88 was generated without it, and Prisma 7 REFUSES a
-- whole query that reads one:
--
--     PrismaClientKnownRequestError: Value 'SPORT_FACT' not found in enum 'NotificationKind'
--
-- The bell reads a person's notifications on every page, and every player with
-- a phone gets one such row a week, so the previous image's bell would break
-- for nearly everyone. Run this BEFORE starting the previous image, and
-- `p88-unpark.sql` after rolling forward again (docs/deploy-gcp.md, "Rolling
-- back past p88").
--
-- What it does, in one transaction: every notification row of that kind is
-- copied to p88_parked_notification and removed. The fact is never emailed, so
-- email_outbox holds none; it is checked anyway, with every other column of
-- type NotificationKind, found from the catalogue, and if any still holds the
-- value the transaction is rolled back. app_user."pushSportFacts" stays: the
-- previous image does not map it, and its default keeps that image's inserts
-- working.
--
-- Safe to run twice. Run as the database owner:
--
--   docker exec -i playerz-db psql -U playerz -d playerz_production -v ON_ERROR_STOP=1 \
--     < /opt/playerz/repo/deploy/rollback/p88-park.sql

BEGIN;

CREATE TABLE IF NOT EXISTS "p88_parked_notification" (LIKE "notification");
ALTER TABLE "p88_parked_notification" ALTER COLUMN "kind" TYPE TEXT;

INSERT INTO "p88_parked_notification"
SELECT * FROM "notification"
WHERE "kind"::text = 'SPORT_FACT';
DELETE FROM "notification"
WHERE "kind"::text = 'SPORT_FACT';

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
      'SELECT count(*) FROM %I WHERE %I::text = ''SPORT_FACT''',
      col.table_name, col.column_name) INTO n;
    IF n > 0 THEN
      RAISE EXCEPTION
        'p88 park: %.% still holds % row(s) of the kind P88 added, which the previous image cannot read. Nothing was parked.',
        col.table_name, col.column_name, n;
    END IF;
  END LOOP;
END $$;

COMMIT;
