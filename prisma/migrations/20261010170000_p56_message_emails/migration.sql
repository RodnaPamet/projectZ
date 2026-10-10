-- P56: «Съобщения», the email preference for messages (#375).
--
-- One column with a default: an email about a message still unread after
-- about ten minutes, at most one an hour per conversation. On by default, as
-- the other email preferences are. Additive; the previous image does not map
-- it. It waits five seconds at most for its lock on app_user, then fails, and
-- the deploy is run again.
SET lock_timeout = '5s';

ALTER TABLE "app_user" ADD COLUMN "emailMessages" BOOLEAN NOT NULL DEFAULT true;
