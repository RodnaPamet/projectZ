-- ROLLING BACK PAST P67: park every row the previous image cannot read.
--
-- P67 (#526) added `OPEN_GAME_NOTE` to "ModerationSubject": a person reports
-- the public note on a game. An image built before it was generated without
-- that value, and Prisma 7 REFUSES to read one its client does not know:
--
--     PrismaClientKnownRequestError: Value 'OPEN_GAME_NOTE' not found in enum 'ModerationSubject'
--
-- The previous image's moderation queue reads every OPEN case, whatever its
-- subject, so ONE such case would break the whole platform queue. Run this
-- BEFORE starting the previous image, and `p67-unpark.sql` after rolling
-- forward.
--
-- What it does, in one transaction: every moderation_case and content_report
-- row about an OPEN_GAME_NOTE is copied to a park table and removed. Then every
-- column of type ModerationSubject, found from the catalogue, is checked; if
-- any still holds OPEN_GAME_NOTE, the transaction is rolled back.
--
-- Safe to run twice. Run as the database owner:
--
--   docker exec -i playerz-db psql -U playerz -d playerz_production -v ON_ERROR_STOP=1 \
--     < /opt/playerz/repo/deploy/rollback/p67-park.sql

BEGIN;

CREATE TABLE IF NOT EXISTS "p67_parked_moderation_case" (LIKE "moderation_case");
ALTER TABLE "p67_parked_moderation_case" ALTER COLUMN "subjectType" TYPE TEXT;
CREATE TABLE IF NOT EXISTS "p67_parked_content_report" (LIKE "content_report");
ALTER TABLE "p67_parked_content_report" ALTER COLUMN "subjectType" TYPE TEXT;

INSERT INTO "p67_parked_moderation_case"
SELECT * FROM "moderation_case" WHERE "subjectType"::text = 'OPEN_GAME_NOTE';
DELETE FROM "moderation_case" WHERE "subjectType"::text = 'OPEN_GAME_NOTE';

INSERT INTO "p67_parked_content_report"
SELECT * FROM "content_report" WHERE "subjectType"::text = 'OPEN_GAME_NOTE';
DELETE FROM "content_report" WHERE "subjectType"::text = 'OPEN_GAME_NOTE';

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
    EXECUTE format('SELECT count(*) FROM %I WHERE %I::text = ''OPEN_GAME_NOTE''',
      col.table_name, col.column_name) INTO n;
    IF n > 0 THEN
      RAISE EXCEPTION
        'p67 park: %.% still holds % row(s) of OPEN_GAME_NOTE, which the previous image cannot read. Nothing was parked.',
        col.table_name, col.column_name, n;
    END IF;
  END LOOP;
END $$;

COMMIT;
