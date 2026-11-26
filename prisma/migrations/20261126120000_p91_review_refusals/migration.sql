-- P91: telling the author why a review was refused (#714, DSA Art. 17).
--
--   1. NotificationKind 'REVIEW_REFUSED'   the bell row (and the `account`
--                                          email) that tells the author their
--                                          review of a venue or a coach was
--                                          not published, or was removed:
--                                          why, whether it was automatic, and
--                                          how to object.
--   2. review / coach_review
--      "refusalReason"      a RefusalReason code (src/lib/moderation/
--                           refusal.ts), never the classifier's raw output
--      "refusalAutomated"   true: the classifier; false: a moderator
--      "refusalRemoved"     true: it was published, then taken down
--      "refusedAt"          when
--                           Set together when a review becomes REJECTED,
--                           cleared together when a moderator publishes it.
--                           What the author's own review reads return as
--                           `refusal` (v1: ReviewRefusal).
--
-- ═══ ROLLING BACK ═══
--
-- The image before this one was generated without 'REVIEW_REFUSED', and
-- Prisma refuses a whole query that reads one (#450). Run
-- deploy/rollback/p91-park.sql before starting it and p91-unpark.sql after
-- rolling forward again: docs/deploy-gcp.md, "Rolling back past p91". The
-- columns are additive and nullable: the previous image neither maps nor
-- writes them.
SET lock_timeout = '5s';

-- ADD VALUE cannot be used in the transaction that adds it, and nothing below
-- uses it.
ALTER TYPE "NotificationKind" ADD VALUE 'REVIEW_REFUSED';

ALTER TABLE "review"
  ADD COLUMN "refusalReason" TEXT,
  ADD COLUMN "refusalAutomated" BOOLEAN,
  ADD COLUMN "refusalRemoved" BOOLEAN,
  ADD COLUMN "refusedAt" TIMESTAMP(3);

ALTER TABLE "coach_review"
  ADD COLUMN "refusalReason" TEXT,
  ADD COLUMN "refusalAutomated" BOOLEAN,
  ADD COLUMN "refusalRemoved" BOOLEAN,
  ADD COLUMN "refusedAt" TIMESTAMP(3);
