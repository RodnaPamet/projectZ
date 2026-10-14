-- P74 (#551): coach reviews, moderated as venue reviews are.
--
-- P71 shaped `coach_review` for "one review per lesson", before the owner
-- decided (2026-10-14, decisions 24 and 25 on #377): ONE review per coach per
-- player, as venues have, and every player on a group lesson may write one.
-- No route has written a row yet.
--
--   coach_review  unique on (coachUserId, authorUserId), not on lessonId: the
--                 lesson stays as the proof, indexed for its foreign key
--                 status defaults to PENDING_REVIEW, as `review` does: a row
--                 written by a path that forgot to moderate is invisible, not
--                 live and unchecked
--                 moderationScoresJson: what the classifier saw, for the
--                 human who judges the case
--                 the text is at most 1000 characters (was 2000)
--   ModerationSubject  COACH_REVIEW: a case about a coach review; the subject
--                 id is the coach_review's id
--
-- Rolling back past P74 parks the COACH_REVIEW reports and cases first
-- (deploy/rollback/p74-park.sql): Prisma refuses to read a value its client
-- does not know, and the previous image's queue reads every open case.
SET lock_timeout = '5s';

DROP INDEX IF EXISTS "coach_review_lessonId_key";
CREATE INDEX "coach_review_lessonId_idx" ON "coach_review"("lessonId");
CREATE UNIQUE INDEX "coach_review_coachUserId_authorUserId_key"
  ON "coach_review"("coachUserId", "authorUserId");

ALTER TABLE "coach_review" ALTER COLUMN "status" SET DEFAULT 'PENDING_REVIEW';
ALTER TABLE "coach_review" ADD COLUMN "moderationScoresJson" JSONB;

ALTER TABLE "coach_review" DROP CONSTRAINT coach_review_body_length;
ALTER TABLE "coach_review"
  ADD CONSTRAINT coach_review_body_length CHECK ("body" IS NULL OR char_length("body") <= 1000);

ALTER TYPE "ModerationSubject" ADD VALUE 'COACH_REVIEW';
