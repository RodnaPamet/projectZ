-- ROLLING FORWARD AGAIN AFTER p54-park.sql: give back what it parked.
--
-- Every conversation p54-park.sql relabelled VENUE_CHANNEL becomes CLUB again,
-- and the park table goes. Run it once the P54 (or later) image is running
-- again. Safe when nothing was parked: the table is created empty first.
--
--   docker exec -i playerz-db psql -U playerz -d playerz_production -v ON_ERROR_STOP=1 \
--     < /opt/playerz/repo/deploy/rollback/p54-unpark.sql

BEGIN;

CREATE TABLE IF NOT EXISTS "p54_parked_conversation" (
  "id" TEXT PRIMARY KEY,
  "type" TEXT NOT NULL,
  "parkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE "conversation" DISABLE TRIGGER "conversation_identity_immutable_trg";
UPDATE "conversation" c
SET "type" = p."type"::"ConversationType"
FROM "p54_parked_conversation" p
WHERE c."id" = p."id";
ALTER TABLE "conversation" ENABLE TRIGGER "conversation_identity_immutable_trg";

DROP TABLE "p54_parked_conversation";

COMMIT;
