-- P69 (#465): a deleted account gains nothing new, in the modules that have
-- shipped since P52.
--
-- P52 gave seven tables the `account_not_deleted` trigger: bookings, places,
-- series, memberships, notifications, the email outbox and sessions. Messages
-- (#375) and open play (#376) went live afterwards, and nothing made their
-- pull requests add theirs. So in the instant a deletion commits, a request
-- already in flight could still leave a message, a request to join a game, a
-- block, a report, a push token or a recovery code on the tombstone: personal
-- data on an account that has none, which nothing would ever clean up.
--
-- The function is P52's, unchanged. It reads the account under FOR KEY SHARE,
-- which conflicts with the deletion's FOR UPDATE and with nothing else: a
-- writer that comes first makes the deletion wait and see the row; a writer
-- that comes second waits, re-reads, and is refused.
--
-- The list is not a guess. `NEW_ROWS` in src/lib/account/deletion-plan.ts
-- decides every column that names a user, and
-- tests/guardrails/account-deletion-new-rows.test.ts holds that list to these
-- triggers, to the schema, and to what a request can reach.
--
-- A column that records WHO ACTED on somebody else's row (a moderator, a
-- staff member) has no trigger, on purpose: the plan says why.
--
-- What the app does today is unchanged: every one of these writes is already
-- refused in code for an account that is deleted (it has no session). This is
-- the backstop for the race.
--
-- Rollback: additive. The previous image runs with the triggers in place; they
-- only refuse rows that name a deleted account. To remove one:
--   DROP TRIGGER <name> ON "<table>";
SET lock_timeout = '5s';

DROP TRIGGER IF EXISTS open_game_request_account_not_deleted_trg ON "open_game_request";
CREATE TRIGGER open_game_request_account_not_deleted_trg
  BEFORE INSERT OR UPDATE OF "userId" ON "open_game_request"
  FOR EACH ROW EXECUTE FUNCTION account_not_deleted('userId');

DROP TRIGGER IF EXISTS conversation_creator_account_not_deleted_trg ON "conversation";
CREATE TRIGGER conversation_creator_account_not_deleted_trg
  BEFORE INSERT OR UPDATE OF "createdById" ON "conversation"
  FOR EACH ROW EXECUTE FUNCTION account_not_deleted('createdById');

DROP TRIGGER IF EXISTS conversation_player_account_not_deleted_trg ON "conversation";
CREATE TRIGGER conversation_player_account_not_deleted_trg
  BEFORE INSERT OR UPDATE OF "playerUserId" ON "conversation"
  FOR EACH ROW EXECUTE FUNCTION account_not_deleted('playerUserId');

DROP TRIGGER IF EXISTS conversation_participant_account_not_deleted_trg ON "conversation_participant";
CREATE TRIGGER conversation_participant_account_not_deleted_trg
  BEFORE INSERT OR UPDATE OF "userId" ON "conversation_participant"
  FOR EACH ROW EXECUTE FUNCTION account_not_deleted('userId');

DROP TRIGGER IF EXISTS chat_message_account_not_deleted_trg ON "chat_message";
CREATE TRIGGER chat_message_account_not_deleted_trg
  BEFORE INSERT OR UPDATE OF "senderId" ON "chat_message"
  FOR EACH ROW EXECUTE FUNCTION account_not_deleted('senderId');

DROP TRIGGER IF EXISTS user_block_blocker_account_not_deleted_trg ON "user_block";
CREATE TRIGGER user_block_blocker_account_not_deleted_trg
  BEFORE INSERT OR UPDATE OF "blockerId" ON "user_block"
  FOR EACH ROW EXECUTE FUNCTION account_not_deleted('blockerId');

DROP TRIGGER IF EXISTS user_block_blocked_account_not_deleted_trg ON "user_block";
CREATE TRIGGER user_block_blocked_account_not_deleted_trg
  BEFORE INSERT OR UPDATE OF "blockedId" ON "user_block"
  FOR EACH ROW EXECUTE FUNCTION account_not_deleted('blockedId');

DROP TRIGGER IF EXISTS review_account_not_deleted_trg ON "review";
CREATE TRIGGER review_account_not_deleted_trg
  BEFORE INSERT OR UPDATE OF "authorUserId" ON "review"
  FOR EACH ROW EXECUTE FUNCTION account_not_deleted('authorUserId');

DROP TRIGGER IF EXISTS content_report_account_not_deleted_trg ON "content_report";
CREATE TRIGGER content_report_account_not_deleted_trg
  BEFORE INSERT OR UPDATE OF "reporterUserId" ON "content_report"
  FOR EACH ROW EXECUTE FUNCTION account_not_deleted('reporterUserId');

DROP TRIGGER IF EXISTS moderation_case_reporter_account_not_deleted_trg ON "moderation_case";
CREATE TRIGGER moderation_case_reporter_account_not_deleted_trg
  BEFORE INSERT OR UPDATE OF "reportedByUserId" ON "moderation_case"
  FOR EACH ROW EXECUTE FUNCTION account_not_deleted('reportedByUserId');

DROP TRIGGER IF EXISTS account_security_event_account_not_deleted_trg ON "account_security_event";
CREATE TRIGGER account_security_event_account_not_deleted_trg
  BEFORE INSERT OR UPDATE OF "userId" ON "account_security_event"
  FOR EACH ROW EXECUTE FUNCTION account_not_deleted('userId');

DROP TRIGGER IF EXISTS mfa_recovery_code_account_not_deleted_trg ON "mfa_recovery_code";
CREATE TRIGGER mfa_recovery_code_account_not_deleted_trg
  BEFORE INSERT OR UPDATE OF "userId" ON "mfa_recovery_code"
  FOR EACH ROW EXECUTE FUNCTION account_not_deleted('userId');

DROP TRIGGER IF EXISTS device_token_account_not_deleted_trg ON "device_token";
CREATE TRIGGER device_token_account_not_deleted_trg
  BEFORE INSERT OR UPDATE OF "userId" ON "device_token"
  FOR EACH ROW EXECUTE FUNCTION account_not_deleted('userId');

DROP TRIGGER IF EXISTS push_subscription_account_not_deleted_trg ON "push_subscription";
CREATE TRIGGER push_subscription_account_not_deleted_trg
  BEFORE INSERT OR UPDATE OF "userId" ON "push_subscription"
  FOR EACH ROW EXECUTE FUNCTION account_not_deleted('userId');

DROP TRIGGER IF EXISTS player_sport_level_account_not_deleted_trg ON "player_sport_level";
CREATE TRIGGER player_sport_level_account_not_deleted_trg
  BEFORE INSERT OR UPDATE OF "userId" ON "player_sport_level"
  FOR EACH ROW EXECUTE FUNCTION account_not_deleted('userId');

DROP TRIGGER IF EXISTS player_venue_relationship_account_not_deleted_trg ON "player_venue_relationship";
CREATE TRIGGER player_venue_relationship_account_not_deleted_trg
  BEFORE INSERT OR UPDATE OF "playerUserId" ON "player_venue_relationship"
  FOR EACH ROW EXECUTE FUNCTION account_not_deleted('playerUserId');

DROP TRIGGER IF EXISTS no_show_carry_inheritor_account_not_deleted_trg ON "no_show_carry";
CREATE TRIGGER no_show_carry_inheritor_account_not_deleted_trg
  BEFORE INSERT OR UPDATE OF "inheritedByUserId" ON "no_show_carry"
  FOR EACH ROW EXECUTE FUNCTION account_not_deleted('inheritedByUserId');

DROP TRIGGER IF EXISTS booking_invite_link_account_not_deleted_trg ON "booking_invite_link";
CREATE TRIGGER booking_invite_link_account_not_deleted_trg
  BEFORE INSERT OR UPDATE OF "createdByUserId" ON "booking_invite_link"
  FOR EACH ROW EXECUTE FUNCTION account_not_deleted('createdByUserId');

DROP TRIGGER IF EXISTS booking_split_account_not_deleted_trg ON "booking_split";
CREATE TRIGGER booking_split_account_not_deleted_trg
  BEFORE INSERT OR UPDATE OF "userId" ON "booking_split"
  FOR EACH ROW EXECUTE FUNCTION account_not_deleted('userId');
