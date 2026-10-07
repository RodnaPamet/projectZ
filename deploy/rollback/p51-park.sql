-- ROLLING BACK PAST P51: park every row the previous image cannot read.
--
-- An image built before P51 (squash, karting, TRACK) was generated with the
-- old enums, and Prisma 7 REFUSES to read a value its client does not know:
--
--     PrismaClientKnownRequestError: Value 'SQUASH' not found in enum 'SportType'
--
-- That is not one broken row. `/venues` reads every public court of its page and
-- its filters read the sport of every court, so ONE squash court at a public
-- venue fails the previous image's venue index for everybody. A player with a
-- squash level fails `/me`. Run this BEFORE starting the previous image, and
-- `p51-unpark.sql` after rolling forward again (docs/deploy-gcp.md, "Rolling
-- back past p51").
--
-- What it does, in one transaction:
--
--   court               every squash or karting court and every TRACK is
--                       remembered in p51_parked_court, then CLOSED (archived:
--                       off the public pages, not bookable, its bookings kept)
--                       and relabelled TENNIS / COURT, which the old image
--                       can read. Its name still says what it is.
--   player_sport_level  squash and karting levels move to p51_parked_sport_level.
--
-- Then it checks EVERY column of type SportType, SportType[] or ResourceType,
-- found from the catalogue rather than listed, and refuses — rolling the whole
-- transaction back — if any still holds a P51 value: that table was written by
-- something this script does not know about, and the old image would fail on it.
--
-- Safe to run twice. Run as the database owner:
--
--   docker exec -i playerz-db psql -U playerz -d playerz_production -v ON_ERROR_STOP=1 \
--     < /opt/playerz/repo/deploy/rollback/p51-park.sql

BEGIN;

CREATE TABLE IF NOT EXISTS "p51_parked_court" (
  "id" TEXT PRIMARY KEY,
  "sport" TEXT NOT NULL,
  "resourceType" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "parkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "p51_parked_sport_level" (
  "userId" TEXT NOT NULL,
  "sport" TEXT NOT NULL,
  "level" SMALLINT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  PRIMARY KEY ("userId", "sport")
);

-- Remembered first, as they are now. A second run finds nothing new to keep:
-- what it parked the first time already reads TENNIS / COURT.
INSERT INTO "p51_parked_court" ("id", "sport", "resourceType", "status")
SELECT "id", "sport"::text, "resourceType"::text, "status"::text
FROM "court"
WHERE "sport"::text IN ('SQUASH', 'KARTING') OR "resourceType"::text = 'TRACK'
ON CONFLICT ("id") DO NOTHING;

UPDATE "court"
SET "sport" = 'TENNIS', "resourceType" = 'COURT', "status" = 'CLOSED'
WHERE "id" IN (SELECT "id" FROM "p51_parked_court");

INSERT INTO "p51_parked_sport_level" ("userId", "sport", "level", "createdAt", "updatedAt")
SELECT "userId", "sport"::text, "level", "createdAt", "updatedAt"
FROM "player_sport_level"
WHERE "sport"::text IN ('SQUASH', 'KARTING')
ON CONFLICT ("userId", "sport") DO NOTHING;

DELETE FROM "player_sport_level" WHERE "sport"::text IN ('SQUASH', 'KARTING');

DO $$
DECLARE
  col record;
  n bigint;
BEGIN
  FOR col IN
    SELECT c.table_name, c.column_name, c.udt_name
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.udt_name IN ('SportType', '_SportType', 'ResourceType')
  LOOP
    IF col.udt_name = '_SportType' THEN
      EXECUTE format(
        'SELECT count(*) FROM %I WHERE %I::text[] && ARRAY[''SQUASH'', ''KARTING'']',
        col.table_name, col.column_name) INTO n;
    ELSIF col.udt_name = 'SportType' THEN
      EXECUTE format(
        'SELECT count(*) FROM %I WHERE %I::text IN (''SQUASH'', ''KARTING'')',
        col.table_name, col.column_name) INTO n;
    ELSE
      EXECUTE format(
        'SELECT count(*) FROM %I WHERE %I::text = ''TRACK''',
        col.table_name, col.column_name) INTO n;
    END IF;
    IF n > 0 THEN
      RAISE EXCEPTION
        'p51 park: %.% still holds % row(s) with a P51 value, which the previous image cannot read. Nothing was parked.',
        col.table_name, col.column_name, n;
    END IF;
  END LOOP;
END $$;

COMMIT;
