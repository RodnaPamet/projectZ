-- ROLLING BACK PAST P80: park every row the previous image cannot read.
--
-- P80 (#579, a club's tournament) added four values to "NotificationKind":
-- TOURNAMENT_ENTRY_RECEIVED, TOURNAMENT_PARTNER_NAMED, TOURNAMENT_ENTRY_DECIDED
-- and TOURNAMENT_ENTRY_WITHDRAWN. An image built before P80 was generated
-- without them, and Prisma 7 REFUSES a whole query that reads one:
--
--     PrismaClientKnownRequestError: Value 'TOURNAMENT_ENTRY_RECEIVED' not found in enum 'NotificationKind'
--
-- The bell reads a person's notifications on every page, so one such row
-- would break the previous image's bell for that person. Run this BEFORE
-- starting the previous image, and `p80-unpark.sql` after rolling forward
-- again (docs/deploy-gcp.md, "Rolling back past p80").
--
-- The four are named, not matched by prefix: TOURNAMENT_ROUND is older than
-- P80, and the previous image reads it.
--
-- What it does, in one transaction: every notification row of those kinds is
-- copied to p80_parked_notification and removed, and every email_outbox row of
-- those kinds to p80_parked_email_outbox. Then every column of type
-- NotificationKind, found from the catalogue, is checked; if any still holds
-- one of the four, the transaction is rolled back. P80's four TournamentFormatKind
-- values, its columns, types and triggers stay: the previous image never
-- queries a tournament.
--
-- Safe to run twice. Run as the database owner:
--
--   docker exec -i playerz-db psql -U playerz -d playerz_production -v ON_ERROR_STOP=1 \
--     < /opt/playerz/repo/deploy/rollback/p80-park.sql

BEGIN;

CREATE TABLE IF NOT EXISTS "p80_parked_notification" (LIKE "notification");
ALTER TABLE "p80_parked_notification" ALTER COLUMN "kind" TYPE TEXT;

INSERT INTO "p80_parked_notification"
SELECT * FROM "notification"
WHERE "kind"::text IN ('TOURNAMENT_ENTRY_RECEIVED', 'TOURNAMENT_PARTNER_NAMED', 'TOURNAMENT_ENTRY_DECIDED', 'TOURNAMENT_ENTRY_WITHDRAWN');
DELETE FROM "notification"
WHERE "kind"::text IN ('TOURNAMENT_ENTRY_RECEIVED', 'TOURNAMENT_PARTNER_NAMED', 'TOURNAMENT_ENTRY_DECIDED', 'TOURNAMENT_ENTRY_WITHDRAWN');

CREATE TABLE IF NOT EXISTS "p80_parked_email_outbox" (LIKE "email_outbox");
ALTER TABLE "p80_parked_email_outbox" ALTER COLUMN "kind" TYPE TEXT;

INSERT INTO "p80_parked_email_outbox"
SELECT * FROM "email_outbox"
WHERE "kind"::text IN ('TOURNAMENT_ENTRY_RECEIVED', 'TOURNAMENT_PARTNER_NAMED', 'TOURNAMENT_ENTRY_DECIDED', 'TOURNAMENT_ENTRY_WITHDRAWN');
DELETE FROM "email_outbox"
WHERE "kind"::text IN ('TOURNAMENT_ENTRY_RECEIVED', 'TOURNAMENT_PARTNER_NAMED', 'TOURNAMENT_ENTRY_DECIDED', 'TOURNAMENT_ENTRY_WITHDRAWN');

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
      'SELECT count(*) FROM %I WHERE %I::text IN (''TOURNAMENT_ENTRY_RECEIVED'', ''TOURNAMENT_PARTNER_NAMED'', ''TOURNAMENT_ENTRY_DECIDED'', ''TOURNAMENT_ENTRY_WITHDRAWN'')',
      col.table_name, col.column_name) INTO n;
    IF n > 0 THEN
      RAISE EXCEPTION
        'p80 park: %.% still holds % row(s) of a kind P80 added, which the previous image cannot read. Nothing was parked.',
        col.table_name, col.column_name, n;
    END IF;
  END LOOP;
END $$;

COMMIT;
