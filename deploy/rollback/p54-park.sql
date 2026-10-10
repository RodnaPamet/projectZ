-- ROLLING BACK PAST P54: park every row the previous image cannot read.
--
-- P54 (#375, messaging) added `CLUB` to "ConversationType". An image built
-- before P54 was generated without it, and Prisma 7 REFUSES to read a value its
-- client does not know:
--
--     PrismaClientKnownRequestError: Value 'CLUB' not found in enum 'ConversationType'
--
-- The previous image never reads a conversation (nothing called its messaging
-- use case), so today this is a precaution rather than a repair. It is here
-- because the next image that does read one must not find out the hard way.
-- Run it BEFORE starting the previous image, and `p54-unpark.sql` after rolling
-- forward again (docs/deploy-gcp.md, "Rolling back past p51" has the steps;
-- they are the same).
--
-- What it does, in one transaction:
--
--   conversation   every CLUB conversation is remembered in
--                  p54_parked_conversation and relabelled VENUE_CHANNEL, which
--                  the old image can read. Its rows, participants and messages
--                  are untouched. The trigger that keeps a conversation's kind
--                  fixed is switched off for exactly this UPDATE.
--
-- Then it checks EVERY column of type ConversationType, found from the
-- catalogue rather than listed, and refuses — rolling the whole transaction
-- back — if any still holds CLUB.
--
-- Safe to run twice. Run as the database owner:
--
--   docker exec -i playerz-db psql -U playerz -d playerz_production -v ON_ERROR_STOP=1 \
--     < /opt/playerz/repo/deploy/rollback/p54-park.sql

BEGIN;

CREATE TABLE IF NOT EXISTS "p54_parked_conversation" (
  "id" TEXT PRIMARY KEY,
  "type" TEXT NOT NULL,
  "parkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO "p54_parked_conversation" ("id", "type")
SELECT "id", "type"::text FROM "conversation" WHERE "type"::text = 'CLUB'
ON CONFLICT ("id") DO NOTHING;

ALTER TABLE "conversation" DISABLE TRIGGER "conversation_identity_immutable_trg";
UPDATE "conversation" SET "type" = 'VENUE_CHANNEL'
WHERE "id" IN (SELECT "id" FROM "p54_parked_conversation");
ALTER TABLE "conversation" ENABLE TRIGGER "conversation_identity_immutable_trg";

DO $$
DECLARE
  col record;
  n bigint;
BEGIN
  FOR col IN
    SELECT c.table_name, c.column_name
    FROM information_schema.columns c
    WHERE c.table_schema = 'public' AND c.udt_name = 'ConversationType'
  LOOP
    EXECUTE format('SELECT count(*) FROM %I WHERE %I::text = ''CLUB''', col.table_name, col.column_name)
      INTO n;
    IF n > 0 THEN
      RAISE EXCEPTION
        'p54 park: %.% still holds % row(s) of CLUB, which the previous image cannot read. Nothing was parked.',
        col.table_name, col.column_name, n;
    END IF;
  END LOOP;
END $$;

COMMIT;
