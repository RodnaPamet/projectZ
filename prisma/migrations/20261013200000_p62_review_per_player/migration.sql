-- P62 (#416): every player on a played booking may review the venue for that
-- visit (owner decision 2026-10-13), not only the booker. A review was unique
-- per BOOKING, so the second player on one booking could never write theirs.
-- It is now unique per booking AND author: still one review per person per
-- visit, and the use case still allows one per person per venue.
--
-- Rollback: the previous image only lets the booker review, so it never
-- writes two reviews on one booking; it runs unchanged on this index.
SET lock_timeout = '5s';

DROP INDEX IF EXISTS "review_bookingId_key";
CREATE UNIQUE INDEX "review_bookingId_authorUserId_key" ON "review"("bookingId", "authorUserId");
