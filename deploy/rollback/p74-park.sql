-- ROLLING BACK PAST P74: park every row the previous image cannot read.
--
-- P74 (#551) added `COACH_REVIEW` to "ModerationSubject": a case about a
-- player's review of a coach, opened by the classifier or by a report. An
-- image built before it was generated without that value, and Prisma 7
-- REFUSES to read one its client does not know:
--
--     PrismaClientKnownRequestError: Value 'COACH_REVIEW' not found in enum 'ModerationSubject'
--
-- The previous image's moderation queue reads every OPEN case, whatever its
-- subject, so ONE such case would break the whole platform queue. Run this
-- BEFORE starting the previous image, and `p74-unpark.sql` after rolling
-- forward.
--
-- What it does, in one transaction: every moderation_case and content_report
-- row about a COACH_REVIEW is copied to a park table and removed. Then every
-- column of type ModerationSubject, found from the catalogue, is checked; if
-- any still holds COACH_REVIEW, the transaction is rolled back.
--
-- Safe to run twice. Run as the database owner:
--
--   docker exec -i playerz-db psql -U playerz -d playerz_production -v ON_ERROR_STOP=1 \
--     < /opt/playerz/repo/deploy/rollback/p74-park.sql

BEGIN;

CREATE TABLE IF NOT EXISTS "p74_parked_moderation_case" (LIKE "moderation_case");
ALTER TABLE "p74_parked_moderation_case" ALTER COLUMN "subjectType" TYPE TEXT;
CREATE TABLE IF NOT EXISTS "p74_parked_content_report" (LIKE "content_report");
ALTER TABLE "p74_parked_content_report" ALTER COLUMN "subjectType" TYPE TEXT;

INSERT INTO "p74_parked_moderation_case"
SELECT * FROM "moderation_case" WHERE "subjectType"::text = 'COACH_REVIEW';
DELETE FROM "moderation_case" WHERE "subjectType"::text = 'COACH_REVIEW';

INSERT INTO "p74_parked_content_report"
SELECT * FROM "content_report" WHERE "subjectType"::text = 'COACH_REVIEW';
DELETE FROM "content_report" WHERE "subjectType"::text = 'COACH_REVIEW';

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
    EXECUTE format('SELECT count(*) FROM %I WHERE %I::text = ''COACH_REVIEW''',
      col.table_name, col.column_name) INTO n;
    IF n > 0 THEN
      RAISE EXCEPTION
        'p74 park: %.% still holds % row(s) of COACH_REVIEW, which the previous image cannot read. Nothing was parked.',
        col.table_name, col.column_name, n;
    END IF;
  END LOOP;
END $$;

COMMIT;
