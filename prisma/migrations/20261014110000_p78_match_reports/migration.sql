-- P78 (#574, Module 4 #378): the result of a booking, and who may see a rating.
--
-- Owner decisions 29–48 (2026-10-14). Only playerz bookings count (29): a
-- player on a completed booking reports its result within 7 days (45),
-- picking the sides from the booking's players (30) and entering the score as
-- sets and games, points or goals (46). The other side confirms, or after 48 h
-- it confirms itself (Q23); a rejected result goes to the club (34). Karting is
-- a finishing order the track enters (33).
--
--   match_report      one per booking, a club's row like the booking: the
--                     sides, the score or the order, where it stands, and
--                     who did what when. Once it counts it is written to
--                     match_result (P05/P19) and moves the ratings there,
--                     idempotent by the booking.
--   app_user.ratingPublic
--                     decision 36: off, results still move the rating and it
--                     is used privately; nobody else is shown it.
--
-- Rollback: additive. The previous image reads none of it; the two enum types
-- are new, so no value needs parking.
SET lock_timeout = '5s';

CREATE TYPE "ResultStatus" AS ENUM ('REPORTED', 'CONFIRMED', 'REJECTED', 'DECIDED', 'VOIDED');
CREATE TYPE "ResultKind" AS ENUM ('SCORE', 'ORDER');

ALTER TABLE "app_user" ADD COLUMN "ratingPublic" BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE "match_report" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "sport" "SportType" NOT NULL,
    "kind" "ResultKind" NOT NULL,
    "status" "ResultStatus" NOT NULL DEFAULT 'REPORTED',
    "sidesJson" JSONB NOT NULL,
    "scoreJson" JSONB,
    "winnerSide" INTEGER,
    "reportedByUserId" TEXT NOT NULL,
    "reportedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "autoConfirmAt" TIMESTAMPTZ(3),
    "answeredByUserId" TEXT,
    "answeredAt" TIMESTAMPTZ(3),
    "rejectNote" TEXT,
    "decidedByUserId" TEXT,
    "decidedAt" TIMESTAMPTZ(3),
    "matchResultId" TEXT,

    CONSTRAINT "match_report_pkey" PRIMARY KEY ("id"),
    -- A side index, never negative; a race has no winner side, and no score.
    CONSTRAINT match_report_winner_side CHECK ("winnerSide" IS NULL OR "winnerSide" >= 0),
    CONSTRAINT match_report_order_has_no_score CHECK (
      "kind" <> 'ORDER' OR ("scoreJson" IS NULL AND "winnerSide" IS NULL)
    ),
    CONSTRAINT match_report_sides_are_a_list CHECK (jsonb_typeof("sidesJson") = 'array'),
    CONSTRAINT match_report_reject_note_length CHECK (
      "rejectNote" IS NULL OR char_length("rejectNote") <= 500
    )
);

CREATE UNIQUE INDEX "match_report_bookingId_key" ON "match_report"("bookingId");
CREATE UNIQUE INDEX "match_report_matchResultId_key" ON "match_report"("matchResultId");
CREATE INDEX "match_report_tenantId_status_idx" ON "match_report"("tenantId", "status");
CREATE INDEX "match_report_status_autoConfirmAt_idx" ON "match_report"("status", "autoConfirmAt");

ALTER TABLE "match_report" ADD CONSTRAINT "match_report_bookingId_fkey"
  FOREIGN KEY ("bookingId") REFERENCES "booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A club's row, as the booking is: the club's binding reads and writes it. A
-- player's view of their own results across clubs goes through a use case
-- that names them, as "my bookings" does.
ALTER TABLE "match_report" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "match_report" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "match_report"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
CREATE POLICY superuser_bypass ON "match_report" TO app_superuser
  USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON "match_report" TO app_user, app_superuser;
