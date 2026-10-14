-- P79 (#575, Module 4 #378): telling people about results, and no new result
-- in a deleted account's name.
--
--   1. three NotificationKind values   to the other side: a result was
--                                      reported and waits for them
--                                      (RESULT_REPORTED); to the club's staff:
--                                      a result was rejected and waits for the
--                                      club (RESULT_DISPUTED, decision 34); to
--                                      the players: the club decided or voided
--                                      it (RESULT_DECIDED).
--   2. account_not_deleted on the two  who reported a result and who answered
--      player columns of match_report  it: a deleted account reports and
--                                      answers nothing (#465). The club's
--                                      decidedByUserId is an actor, as
--                                      deletion-plan.ts says.
--
-- ═══ ROLLING BACK ═══
--
-- The image before this one was generated without the three enum values, and
-- Prisma refuses a whole query that reads one (#450). Run
-- deploy/rollback/p79-park.sql before starting it and p79-unpark.sql after
-- rolling forward again: docs/deploy-gcp.md, "Rolling back past p79".

-- ─── 1. The notification kinds ─────────────────────────────────────────────
--
-- ADD VALUE cannot be used in the transaction that adds it, and nothing below
-- uses one.
ALTER TYPE "NotificationKind" ADD VALUE 'RESULT_REPORTED';
ALTER TYPE "NotificationKind" ADD VALUE 'RESULT_DISPUTED';
ALTER TYPE "NotificationKind" ADD VALUE 'RESULT_DECIDED';

-- ─── 2. A deleted account reports and answers nothing ─────────────────────
DROP TRIGGER IF EXISTS match_report_reporter_account_not_deleted_trg ON "match_report";
CREATE TRIGGER match_report_reporter_account_not_deleted_trg
  BEFORE INSERT OR UPDATE OF "reportedByUserId" ON "match_report"
  FOR EACH ROW EXECUTE FUNCTION account_not_deleted('reportedByUserId');

DROP TRIGGER IF EXISTS match_report_answerer_account_not_deleted_trg ON "match_report";
CREATE TRIGGER match_report_answerer_account_not_deleted_trg
  BEFORE INSERT OR UPDATE OF "answeredByUserId" ON "match_report"
  FOR EACH ROW EXECUTE FUNCTION account_not_deleted('answeredByUserId');
