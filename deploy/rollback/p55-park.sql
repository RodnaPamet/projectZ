-- ROLLING BACK PAST P55: park every row the previous image cannot read.
--
-- P55 (#375) added `CONVERSATION` to "ModerationSubject": a person reports a
-- whole conversation. An image built before it was generated without that
-- value, and Prisma 7 REFUSES to read one its client does not know:
--
--     PrismaClientKnownRequestError: Value 'CONVERSATION' not found in enum 'ModerationSubject'
--
-- The previous image's moderation queue reads REVIEW cases only, so today
-- this is a precaution for whatever reads every case next. Run it BEFORE
-- starting the previous image, and `p55-unpark.sql` after rolling forward.
--
-- What it does, in one transaction: every moderation_case and content_report
-- row about a CONVERSATION is copied to a park table and removed. Then every
-- column of type ModerationSubject, found from the catalogue, is checked; if
-- any still holds CONVERSATION, the transaction is rolled back.
--
-- Safe to run twice. Run as the database owner:
--
--   docker exec -i playerz-db psql -U playerz -d playerz_production -v ON_ERROR_STOP=1 \
--     < /opt/playerz/repo/deploy/rollback/p55-park.sql

BEGIN;

CREATE TABLE IF NOT EXISTS "p55_parked_moderation_case" (LIKE "moderation_case");
ALTER TABLE "p55_parked_moderation_case" ALTER COLUMN "subjectType" TYPE TEXT;
CREATE TABLE IF NOT EXISTS "p55_parked_content_report" (LIKE "content_report");
ALTER TABLE "p55_parked_content_report" ALTER COLUMN "subjectType" TYPE TEXT;

INSERT INTO "p55_parked_moderation_case"
SELECT * FROM "moderation_case" WHERE "subjectType"::text = 'CONVERSATION';
DELETE FROM "moderation_case" WHERE "subjectType"::text = 'CONVERSATION';

INSERT INTO "p55_parked_content_report"
SELECT * FROM "content_report" WHERE "subjectType"::text = 'CONVERSATION';
DELETE FROM "content_report" WHERE "subjectType"::text = 'CONVERSATION';

DO $$
DECLARE
  col record;
  n bigint;
BEGIN
  FOR col IN
    SELECT c.table_name, c.column_name
    FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.udt_name = 'ModerationSubject'
  LOOP
    EXECUTE format('SELECT count(*) FROM %I WHERE %I::text = ''CONVERSATION''',
      col.table_name, col.column_name) INTO n;
    IF n > 0 THEN
      RAISE EXCEPTION
        'p55 park: %.% still holds % row(s) of CONVERSATION, which the previous image cannot read. Nothing was parked.',
        col.table_name, col.column_name, n;
    END IF;
  END LOOP;
END $$;

COMMIT;
