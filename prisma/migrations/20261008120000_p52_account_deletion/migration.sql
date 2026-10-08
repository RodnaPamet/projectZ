-- P52: account deletion (#370, owner decisions 2026-10-08).
--
-- A player or coach deletes their account themselves, at once and for good,
-- once they have no upcoming bookings. Their past bookings stay in the club's
-- records under "Изтрит потребител", because the club's statements and the
-- platform fee are computed from them. The rules are in
-- src/app-layer/usecases/account-deletion.ts; this file holds the ones the
-- database keeps, so that no writer the application does not know about can
-- break them.
--
-- ═══ A TOMBSTONE, NOT A DELETE ═══
--
-- `app_user` cannot simply be deleted. `platform_admin_grant` hangs off it ON
-- DELETE CASCADE, and its own trigger refuses every DELETE (P31: the history
-- of who held platform authority is the point), so deleting a former admin
-- fails outright. Bookings, places, the credit ledger and the audit logs name
-- the id with no foreign key, so a deleted row would leave them pointing at
-- nothing, and every screen would have to guess what a missing person means.
--
-- So the row stays, as a tombstone: `deletedAt` set, the address replaced by
-- `deleted-<id>@deleted.playerz.invalid` (`.invalid` is reserved, RFC 2606, and
-- never delivers), everything else personal null. Sign-in finds accounts by
-- address, so the next sign-in with the same Google or Facebook address
-- creates a new account and never finds this one.
--
-- ═══ ADDITIVE, AND QUICK TO GIVE UP ═══
--
-- One nullable column, a CHECK every existing row passes (added NOT VALID here
-- and validated by P52b, in its own transaction), triggers and a column grant.
-- The previous image runs against it unchanged: it never sets `deletedAt`, and
-- a tombstone it reads is a row with no name and an address nobody signs in as.
--
-- Every statement below needs a lock on a table the app is using: app_user,
-- booking, notification and the rest. Waiting behind a long transaction would
-- queue every request behind this migration. So it waits five seconds at most
-- and then fails. The file is one transaction, so a failure changes nothing,
-- and the deploy is simply run again.
SET lock_timeout = '5s';

-- 1. When the account was deleted, or null.
ALTER TABLE "app_user" ADD COLUMN "deletedAt" TIMESTAMP(3);

-- 2. A deleted account holds nothing personal. The address is pinned to the id
--    rather than merely "not the old one", so it is unique without a second
--    index and cannot be set to somebody's real address by mistake.
--
--    NOT VALID: enforced from this statement on for every row written, without
--    scanning the table under this file's exclusive lock. P52b validates the
--    existing rows (every one of which has `deletedAt` null) in a transaction
--    of its own, which blocks no writer.
ALTER TABLE "app_user" ADD CONSTRAINT app_user_deleted_is_scrubbed CHECK (
  "deletedAt" IS NULL OR (
    "email" = 'deleted-' || "id" || '@deleted.playerz.invalid'
    AND "name" IS NULL
    AND "phone" IS NULL
    AND "avatarUrl" IS NULL
    AND "passwordHash" IS NULL
    AND "emailVerified" IS NULL
    AND "mfaSecret" IS NULL
    AND "mfaEnabledAt" IS NULL
    AND "mfaLastUsedStep" IS NULL
  )
) NOT VALID;

-- 3. And it stays deleted: `deletedAt`, once set, never changes, so a deleted
--    account is never revived.
--
--    Nothing else needs a trigger. While `deletedAt` is set, the CHECK above
--    keeps every personal column null, so nobody can rename a tombstone, give
--    it an address or a password. Its other columns (the language, the email
--    settings, `sessionVersion`) may still be written, and that is on purpose:
--    a maintenance UPDATE across `app_user`, like P37's backfill, must not pass
--    CI, where no tombstones exist, and then abort in production, where they
--    do.
CREATE OR REPLACE FUNCTION app_user_tombstone_final() RETURNS trigger AS $$
BEGIN
  IF OLD."deletedAt" IS NOT NULL AND NEW."deletedAt" IS DISTINCT FROM OLD."deletedAt" THEN
    RAISE EXCEPTION
      'app_user_tombstone_final: account % was deleted at %, and a deleted account is never revived (#370). Signing in again with the same address creates a new account.',
      OLD."id", OLD."deletedAt"
      USING ERRCODE = 'check_violation', CONSTRAINT = 'app_user_tombstone_final';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS app_user_tombstone_final_trg ON "app_user";
CREATE TRIGGER app_user_tombstone_final_trg
  BEFORE UPDATE OF "deletedAt" ON "app_user"
  FOR EACH ROW EXECUTE FUNCTION app_user_tombstone_final();

-- 4. Nothing new is written for a deleted account: no booking, no place on
--    one, no series, no membership, no notification, no email, no session.
--
-- ═══ AND IT IS WHAT MAKES "NO UPCOMING BOOKINGS" HOLD UNDER CONCURRENCY ═══
--
-- The deletion checks for upcoming bookings and then scrubs, in one
-- transaction. A booking made for the same person in between (another tab,
-- the club's desk linking them, an invite link accepted) would commit after
-- the check and leave a deleted account with a game next week. So the two
-- sides take conflicting locks on the person's `app_user` row:
--
--   the deletion      SELECT … FOR UPDATE, before it looks for bookings
--   every writer      SELECT … FOR KEY SHARE, here
--
-- A writer that comes first makes the deletion wait, and the deletion then
-- sees its booking and refuses. A writer that comes second waits for the
-- deletion to commit, re-reads the row, finds `deletedAt` and is refused.
-- FOR KEY SHARE, not FOR SHARE: it does not conflict with an ordinary update
-- of the row (a name, a language), only with the deletion's FOR UPDATE.
--
-- A session is in the list for the same reason: a sign-in that read the
-- account just before the deletion committed must not leave a session row,
-- with its IP address and user agent, on the tombstone (createUserSession
-- refuses a deleted account in so many words; this is what makes it hold
-- under the race).
--
-- SECURITY DEFINER with a pinned search_path, as P37's account-kind check: the
-- row lock needs a privilege the bound role's policy should not decide.
CREATE OR REPLACE FUNCTION account_not_deleted() RETURNS trigger AS $$
DECLARE
  uid text;
  gone timestamp(3);
BEGIN
  uid := to_jsonb(NEW) ->> TG_ARGV[0];
  IF uid IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT u."deletedAt" INTO gone
  FROM "app_user" AS u
  WHERE u."id" = uid
  FOR KEY SHARE;

  IF gone IS NOT NULL THEN
    RAISE EXCEPTION
      'account_deleted: % would name account %, which was deleted (#370). A deleted account gains no bookings, places, memberships, notifications or sessions.',
      TG_TABLE_NAME, uid
      USING ERRCODE = 'check_violation', CONSTRAINT = 'account_deleted';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp;

REVOKE ALL ON FUNCTION account_not_deleted() FROM PUBLIC;

DROP TRIGGER IF EXISTS booking_account_not_deleted_trg ON "booking";
CREATE TRIGGER booking_account_not_deleted_trg
  BEFORE INSERT OR UPDATE OF "bookedByUserId" ON "booking"
  FOR EACH ROW EXECUTE FUNCTION account_not_deleted('bookedByUserId');

DROP TRIGGER IF EXISTS booking_participant_account_not_deleted_trg ON "booking_participant";
CREATE TRIGGER booking_participant_account_not_deleted_trg
  BEFORE INSERT OR UPDATE OF "userId" ON "booking_participant"
  FOR EACH ROW EXECUTE FUNCTION account_not_deleted('userId');

DROP TRIGGER IF EXISTS booking_series_account_not_deleted_trg ON "booking_series";
CREATE TRIGGER booking_series_account_not_deleted_trg
  BEFORE INSERT OR UPDATE OF "customerUserId" ON "booking_series"
  FOR EACH ROW EXECUTE FUNCTION account_not_deleted('customerUserId');

DROP TRIGGER IF EXISTS tenant_membership_account_not_deleted_trg ON "tenant_membership";
CREATE TRIGGER tenant_membership_account_not_deleted_trg
  BEFORE INSERT OR UPDATE OF "userId" ON "tenant_membership"
  FOR EACH ROW EXECUTE FUNCTION account_not_deleted('userId');

DROP TRIGGER IF EXISTS notification_account_not_deleted_trg ON "notification";
CREATE TRIGGER notification_account_not_deleted_trg
  BEFORE INSERT OR UPDATE OF "userId" ON "notification"
  FOR EACH ROW EXECUTE FUNCTION account_not_deleted('userId');

DROP TRIGGER IF EXISTS email_outbox_account_not_deleted_trg ON "email_outbox";
CREATE TRIGGER email_outbox_account_not_deleted_trg
  BEFORE INSERT OR UPDATE OF "userId" ON "email_outbox"
  FOR EACH ROW EXECUTE FUNCTION account_not_deleted('userId');

DROP TRIGGER IF EXISTS user_session_account_not_deleted_trg ON "user_session";
CREATE TRIGGER user_session_account_not_deleted_trg
  BEFORE INSERT OR UPDATE OF "userId" ON "user_session"
  FOR EACH ROW EXECUTE FUNCTION account_not_deleted('userId');

-- 5. The security log keeps the event and loses the address (#370).
--
-- `account_security_event` is append-only (P38), and it is the one log that
-- stores an IP address and a user agent: every second-factor event of a
-- platform admin. A deleted account keeps its events — who enrolled, stepped
-- up or spent a recovery code, and when — and loses those two columns. The
-- trigger admits exactly that and nothing else: an UPDATE that sets
-- `ipAddress` and `userAgent` to NULL and changes no other column, on a row
-- whose account is DELETED (its tombstone written first, in the same
-- transaction) and is the one named by `app.erasure_user_id`, which only the
-- deletion sets (SET LOCAL). Both, because a setting any session can set is a
-- statement of intent, and `deletedAt` is the fact. Every other UPDATE, and
-- every DELETE, is refused as before.
--
-- `audit_entry` and `platform_audit_entry` have the same two columns and no
-- writer that fills them (nothing passes them to `appendAuditEntry` or
-- `runAsPlatformAdmin`; tests/guardrails/account-deletion-plan.test.ts keeps
-- it so), so their triggers are unchanged.
CREATE OR REPLACE FUNCTION account_security_event_append_only() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND current_setting('app.erasure_user_id', true) = OLD."userId"
     AND EXISTS (
       SELECT 1 FROM "app_user" AS u
        WHERE u."id" = OLD."userId" AND u."deletedAt" IS NOT NULL
     )
     AND NEW."ipAddress" IS NULL
     AND NEW."userAgent" IS NULL
     AND NEW."id" = OLD."id"
     AND NEW."userId" = OLD."userId"
     AND NEW."userSessionId" IS NOT DISTINCT FROM OLD."userSessionId"
     AND NEW."action" = OLD."action"
     AND NEW."detailsJson" = OLD."detailsJson"
     AND NEW."requestId" IS NOT DISTINCT FROM OLD."requestId"
     AND NEW."createdAt" = OLD."createdAt" THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'account_security_event is APPEND-ONLY: % is not permitted. It is the record of who enrolled, stepped up or spent a recovery code; a record that can be edited is not evidence.',
    TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

-- The erasure is an UPDATE of exactly these two columns. P38 granted
-- app_superuser SELECT and INSERT on this table; the UPDATE it has besides
-- comes from P03's default privileges, which a later tightening could take
-- away without anyone thinking of the deletion. Stated here, for these two
-- columns only.
GRANT UPDATE ("ipAddress", "userAgent") ON "account_security_event" TO app_superuser;
