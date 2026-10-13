-- P72 — WHO MAY TEACH HERE: the owner's approval of a coach (#545, #377).
--
-- Owner decision 13: a coach fills in a profile and uploads a certificate, and
-- the platform owner approves or declines. P71 made the tables; this adds what
-- the approval itself needs.
--
--   1. PlatformCapability.COACH_APPROVE     the grant that opens the queue
--   2. three NotificationKind values        submitted (to the operator),
--                                           approved and declined (to the coach)
--   3. the email category 'account'         a letter about one's own account;
--                                           it has no switch to turn off
--   4. coach_profile_decision_by_platform   a decision is written by a platform
--                                           admin's audited transaction, and by
--                                           nothing else
--
-- ═══ ROLLING BACK ═══
--
-- The image before this one was generated without the four enum values, and
-- Prisma refuses a whole query that reads one (#450). Run
-- deploy/rollback/p72-park.sql before starting it and p72-unpark.sql after
-- rolling forward again: docs/deploy-gcp.md, "Rolling back past p72".

-- ─── 1. The capability ─────────────────────────────────────────────────────
--
-- ADD VALUE cannot be used in the transaction that adds it, and nothing below
-- uses it: the grant that carries it is written later, by
-- scripts/grant-platform-admin.ts.
ALTER TYPE "PlatformCapability" ADD VALUE 'COACH_APPROVE';

-- ─── 2. The notification kinds ─────────────────────────────────────────────
ALTER TYPE "NotificationKind" ADD VALUE 'COACH_PROFILE_SUBMITTED';
ALTER TYPE "NotificationKind" ADD VALUE 'COACH_PROFILE_APPROVED';
ALTER TYPE "NotificationKind" ADD VALUE 'COACH_PROFILE_DECLINED';

-- ─── 3. The email category ─────────────────────────────────────────────────
--
-- 'account': the answer to something the person asked of the platform about
-- their own account (here, whether they may teach). There is no setting for
-- it, as there is none for a password reset. The previous image's drain reads
-- the category as text and sends what it does not know, so a row of it left
-- behind by a rollback still goes out.
ALTER TABLE "email_outbox" DROP CONSTRAINT email_outbox_category_known;
ALTER TABLE "email_outbox" ADD CONSTRAINT email_outbox_category_known
  CHECK ("category" IN (
    'confirmation', 'reminder', 'clubChanges', 'messages', 'openPlay', 'contact', 'account'
  ));

-- ─── 4. A decision is the platform's ───────────────────────────────────────
--
-- coach_profile's row security is owner-only: a coach reads and writes their
-- own row, and row security says nothing about WHICH columns. So without this
-- a bug in any code path that runs as the coach could write status = APPROVED
-- on the coach's own profile.
--
-- A profile BECOMES approved or declined only inside a transaction bound to a
-- platform admin (`app.platform_admin_id`, set by runAsPlatformAdmin, which
-- has by then written its audit row), and the row names that admin. The same
-- GUC the audit trail's own trigger trusts (P31). Triggers fire for the table
-- owner and for a superuser alike.
--
-- Leaving a decided state is the coach's: a declined coach corrects and sends
-- again. Editing the text of an approved profile does not change its status,
-- so it does not come through here.
CREATE OR REPLACE FUNCTION coach_profile_decision_by_platform() RETURNS trigger AS $$
DECLARE
  bound text;
BEGIN
  IF NEW."status" NOT IN ('APPROVED', 'DECLINED') THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE'
     AND OLD."status" = NEW."status"
     AND OLD."decidedByUserId" IS NOT DISTINCT FROM NEW."decidedByUserId"
     AND OLD."decidedAt" IS NOT DISTINCT FROM NEW."decidedAt"
     AND OLD."decisionNote" IS NOT DISTINCT FROM NEW."decisionNote" THEN
    -- The decision is untouched: a coach editing an approved profile's text.
    RETURN NEW;
  END IF;

  bound := current_setting('app.platform_admin_id', true);
  IF bound IS NULL OR bound = '' THEN
    RAISE EXCEPTION
      'coach_profile: a profile is approved or declined by a platform admin, inside runAsPlatformAdmin. This transaction is bound to none.'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."decidedByUserId" IS DISTINCT FROM bound THEN
    RAISE EXCEPTION
      'coach_profile: the decision names % but the transaction is bound to %.',
      NEW."decidedByUserId", bound
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS coach_profile_decision_by_platform_trg ON "coach_profile";
CREATE TRIGGER coach_profile_decision_by_platform_trg
  BEFORE INSERT OR UPDATE ON "coach_profile"
  FOR EACH ROW EXECUTE FUNCTION coach_profile_decision_by_platform();
