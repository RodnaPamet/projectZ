-- P55: reporting a message or a conversation, and a moderator closing one (#375).
--
--   ModerationSubject  CONVERSATION, beside CHAT_MESSAGE: a person reports a
--                      whole conversation from its screen.
--   conversation       blockedSide may be PLATFORM: a moderator closed it after
--                      a report, and nobody in it can lift that.
--
-- Additive: a new enum value and a wider CHECK. Rolling back past P55 parks the
-- CONVERSATION reports first (deploy/rollback/p55-park.sql), because Prisma
-- refuses to read a value its client does not know. A PLATFORM block needs no
-- parking: `blockedSide` is text, and the previous image reads it as a block by
-- the other side, which is what it is.
SET lock_timeout = '5s';

ALTER TYPE "ModerationSubject" ADD VALUE 'CONVERSATION';

-- Widened in place: dropped and added back with one more value, in the same
-- transaction, so no moment exists without it. Every row passes (PLATFORM is
-- new), and the table is small enough to validate at once.
ALTER TABLE "conversation" DROP CONSTRAINT "conversation_blocked_side_valid";
ALTER TABLE "conversation" ADD CONSTRAINT "conversation_blocked_side_valid"
  CHECK ("blockedSide" IS NULL OR "blockedSide" IN ('CLUB', 'PLAYER', 'PLATFORM'));
