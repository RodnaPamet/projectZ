-- P82 (#590, Module 4 #378): Americano and Mexicano. Players sign up alone
-- and are partnered round by round (decision 60), so each side of a match is
-- two entries; a match is played to the points the club sets (56).
--
--   1. tournament         the rounds the club sets, and the points a match is
--                         played to.
--   2. tournament_match   the second entry on each side, for these formats.
--
-- ═══ ROLLING BACK ═══
--
-- Nothing to park: new nullable columns, and the previous image reads none
-- of them. An Americano's matches are GROUP-stage rows the previous image
-- reads as a group's, without the partners.

ALTER TABLE "tournament" ADD COLUMN     "pointsPerMatch" INTEGER,
ADD COLUMN     "rounds" INTEGER;

ALTER TABLE "tournament" ADD CONSTRAINT tournament_rotating_partners CHECK (
  ("rounds" IS NULL OR "rounds" BETWEEN 1 AND 30)
  AND ("pointsPerMatch" IS NULL OR "pointsPerMatch" BETWEEN 4 AND 100)
);

ALTER TABLE "tournament_match" ADD COLUMN     "entryA2Id" TEXT,
ADD COLUMN     "entryB2Id" TEXT;

CREATE INDEX "tournament_match_entryA2Id_idx" ON "tournament_match"("entryA2Id");
CREATE INDEX "tournament_match_entryB2Id_idx" ON "tournament_match"("entryB2Id");

-- Four different people: a pair's two, and nobody on both sides.
ALTER TABLE "tournament_match" ADD CONSTRAINT tournament_match_distinct_partners CHECK (
  ("entryA2Id" IS NULL OR ("entryA2Id" <> "entryAId" AND "entryA2Id" IS DISTINCT FROM "entryBId" AND "entryA2Id" IS DISTINCT FROM "entryB2Id"))
  AND ("entryB2Id" IS NULL OR ("entryB2Id" <> "entryBId" AND "entryB2Id" IS DISTINCT FROM "entryAId"))
);
