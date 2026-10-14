-- P81 (#580, Module 4 #378): a club tournament's draw, its matches on the
-- diary, and how they move on. `tournament_match` is P21's, never written
-- (0 rows on both databases on 2026-10-14), and reshaped here.
--
--   1. two enum types                  where a match sits (group, knockout,
--                                      third place: 61) and how far it has
--                                      got (pending, ready, played, walkover).
--   2. tournament                      the club's group setup (55), a match
--                                      for third (61), when the draw was made.
--   3. tournament_entry                its group and its seed (54, 55).
--   4. tournament_match                its sides are entries, not players
--                                      (a pair is one side); its place in the
--                                      draw; where its winner goes, and a
--                                      semi-final's loser; the booking that
--                                      puts it on a court (40); its result,
--                                      and who recorded a walkover (58, 59).
--
-- ═══ ROLLING BACK ═══
--
-- Nothing to park: the new types are new types, not values added to one the
-- previous image reads, and the previous image never queries a tournament.
-- Its columns dropped here were never written.

CREATE TYPE "TournamentStage" AS ENUM ('GROUP', 'KNOCKOUT', 'THIRD_PLACE');
CREATE TYPE "TournamentMatchStatus" AS ENUM ('PENDING', 'READY', 'PLAYED', 'WALKOVER');

-- ─── 2. tournament ─────────────────────────────────────────────────────────
ALTER TABLE "tournament" ADD COLUMN     "drawnAt" TIMESTAMP(3),
ADD COLUMN     "groupCount" INTEGER,
ADD COLUMN     "qualifiersPerGroup" INTEGER,
ADD COLUMN     "thirdPlace" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "tournament" ADD CONSTRAINT tournament_groups CHECK (
  ("groupCount" IS NULL AND "qualifiersPerGroup" IS NULL)
  OR ("groupCount" BETWEEN 1 AND 32 AND "qualifiersPerGroup" BETWEEN 1 AND 8)
);

-- ─── 3. tournament_entry ───────────────────────────────────────────────────
ALTER TABLE "tournament_entry" ADD COLUMN     "groupNo" INTEGER,
ADD COLUMN     "seed" INTEGER;

-- ─── 4. tournament_match ───────────────────────────────────────────────────
DROP INDEX "tournament_match_tournamentId_round_homeUserId_key";
DROP INDEX "tournament_match_tournamentId_round_idx";

-- The player columns go, and P21's CHECK on them with them.
ALTER TABLE "tournament_match" DROP COLUMN "awayScore",
DROP COLUMN "awayUserId",
DROP COLUMN "homeScore",
DROP COLUMN "homeUserId",
DROP COLUMN "reportedAt",
ADD COLUMN     "bookingId" TEXT,
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "decidedByUserId" TEXT,
ADD COLUMN     "entryAId" TEXT,
ADD COLUMN     "entryBId" TEXT,
ADD COLUMN     "groupNo" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "loserNextMatchId" TEXT,
ADD COLUMN     "loserNextSide" INTEGER,
ADD COLUMN     "nextMatchId" TEXT,
ADD COLUMN     "nextSide" INTEGER,
ADD COLUMN     "playedAt" TIMESTAMP(3),
ADD COLUMN     "scoreJson" JSONB,
ADD COLUMN     "slot" INTEGER NOT NULL,
ADD COLUMN     "stage" "TournamentStage" NOT NULL,
ADD COLUMN     "status" "TournamentMatchStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "winnerSide" INTEGER;

CREATE UNIQUE INDEX "tournament_match_bookingId_key" ON "tournament_match"("bookingId");
CREATE INDEX "tournament_match_entryAId_idx" ON "tournament_match"("entryAId");
CREATE INDEX "tournament_match_entryBId_idx" ON "tournament_match"("entryBId");
CREATE UNIQUE INDEX "tournament_match_tournamentId_stage_groupNo_round_slot_key" ON "tournament_match"("tournamentId", "stage", "groupNo", "round", "slot");

ALTER TABLE "tournament_match" ADD CONSTRAINT "tournament_match_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "booking"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A group's match is in a group; a knockout's is not.
ALTER TABLE "tournament_match" ADD CONSTRAINT tournament_match_group_stage CHECK (
  ("stage" = 'GROUP') = ("groupNo" >= 1)
);
-- An entry does not meet itself.
ALTER TABLE "tournament_match" ADD CONSTRAINT tournament_match_distinct_entries CHECK (
  "entryAId" IS NULL OR "entryBId" IS NULL OR "entryAId" <> "entryBId"
);
ALTER TABLE "tournament_match" ADD CONSTRAINT tournament_match_sides CHECK (
  ("winnerSide" IS NULL OR "winnerSide" IN (0, 1))
  AND ("nextSide" IS NULL OR "nextSide" IN (0, 1))
  AND ("loserNextSide" IS NULL OR "loserNextSide" IN (0, 1))
  AND "slot" >= 0
);
-- Played or walked over: it says when. A knockout's has a winner.
ALTER TABLE "tournament_match" ADD CONSTRAINT tournament_match_decided CHECK (
  "status" NOT IN ('PLAYED', 'WALKOVER')
  OR ("playedAt" IS NOT NULL AND ("stage" = 'GROUP' OR "winnerSide" IS NOT NULL))
);
