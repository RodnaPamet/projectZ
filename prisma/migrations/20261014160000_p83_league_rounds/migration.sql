-- P83 (#591, Module 4 #378): a league over weeks. Everyone in a division plays
-- everyone, round by round, each round by a deadline (decision 44); a match
-- not played by then waits for the club (58).
--
--   1. tournament         the days between one round's deadline and the next.
--   2. tournament_match   its round's deadline.
--
-- A match the club records as a loss for both (58) is a group-stage WALKOVER
-- with no winner: P81's CHECK already allows it there.
--
-- ═══ ROLLING BACK ═══
--
-- Nothing to park: new nullable columns the previous image never reads.

ALTER TABLE "tournament" ADD COLUMN     "roundDays" INTEGER;
ALTER TABLE "tournament" ADD CONSTRAINT tournament_round_days CHECK (
  "roundDays" IS NULL OR "roundDays" BETWEEN 1 AND 60
);

ALTER TABLE "tournament_match" ADD COLUMN     "deadline" TIMESTAMP(3);
CREATE INDEX "tournament_match_status_deadline_idx" ON "tournament_match"("status", "deadline");
