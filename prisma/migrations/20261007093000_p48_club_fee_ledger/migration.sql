-- P48: the club fee (#372). A per-club percentage of the court price on
-- ONLINE bookings that end COMPLETED, a free period per club, and an
-- append-only ledger the monthly statements are summed from.
--
-- ═══ ADDITIVE ONLY ═══
--
-- Production rolls back by re-tagging the previous image, which must keep
-- working against this schema:
--
--   - two new columns on `venue_org`: `feePercent` with a constant default (a
--     catalogue change on Postgres 11+, not a rewrite) and a nullable
--     `feeStartsOn`. The previous image never names them; a club it creates
--     gets 0% and a NULL start, which the application reads as createdAt + 2
--     months.
--   - one new enum, one new enum value and one new table, which the previous
--     image never touches. Its completion sweep keeps completing bookings
--     without writing fee lines; the new image's sweep writes the missing ones
--     (`recordMissingFeeCharges`), so a rollback loses no fee.

-- ─── The club's terms ───────────────────────────────────────────────

ALTER TABLE "venue_org" ADD COLUMN "feePercent" DECIMAL(4,2) NOT NULL DEFAULT 0;
ALTER TABLE "venue_org" ADD COLUMN "feeStartsOn" DATE;

-- 0..30: a percentage of a court price beyond 30 is not a deal anybody made,
-- and a negative one would pay the club. Two decimals by the column type.
ALTER TABLE "venue_org" ADD CONSTRAINT venue_org_fee_percent_range
  CHECK ("feePercent" >= 0 AND "feePercent" <= 30);

-- Every club that exists gets its free period: two months from the day it was
-- created, as a calendar date at the club. `createdAt` is a timestamp(3)
-- WITHOUT time zone holding UTC (Prisma's default), so it is read as UTC
-- first and then converted to Sofia.
UPDATE "venue_org"
   SET "feeStartsOn" = ((("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Sofia')::date
                        + INTERVAL '2 months')::date
 WHERE "feeStartsOn" IS NULL;

-- ─── Who may set it ─────────────────────────────────────────────────
--
-- `ALTER TYPE … ADD VALUE` runs inside a transaction on Postgres 12+ as long as
-- the new value is not USED in the same transaction (see P36). It is only
-- declared here; grants carrying it are issued later by the CLI.
ALTER TYPE "PlatformCapability" ADD VALUE 'CLUB_FEE_MANAGE';

-- ─── The ledger ─────────────────────────────────────────────────────

CREATE TYPE "ClubFeeLineKind" AS ENUM ('CHARGE', 'REVERSAL');

CREATE TABLE "club_fee_line" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "kind" "ClubFeeLineKind" NOT NULL,
    "venueId" TEXT NOT NULL,
    "venueName" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "courtName" TEXT NOT NULL,
    "bookingStartTs" TIMESTAMPTZ(3) NOT NULL,
    "statementMonth" TEXT NOT NULL,
    "priceCents" INTEGER NOT NULL,
    "feeBps" INTEGER NOT NULL,
    "freePeriod" BOOLEAN NOT NULL,
    "feeCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "club_fee_line_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "club_fee_line_bookingId_kind_key" ON "club_fee_line"("bookingId", "kind");
CREATE INDEX "club_fee_line_tenantId_statementMonth_idx" ON "club_fee_line"("tenantId", "statementMonth");
CREATE INDEX "club_fee_line_statementMonth_idx" ON "club_fee_line"("statementMonth");

-- What the code promises, held by the database as well.
ALTER TABLE "club_fee_line" ADD CONSTRAINT club_fee_line_month_shape
  CHECK ("statementMonth" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');
ALTER TABLE "club_fee_line" ADD CONSTRAINT club_fee_line_bps_range
  CHECK ("feeBps" BETWEEN 0 AND 3000);
-- A charge is never negative and a reversal never positive.
ALTER TABLE "club_fee_line" ADD CONSTRAINT club_fee_line_sign
  CHECK (
    ("kind" = 'CHARGE' AND "priceCents" >= 0 AND "feeCents" >= 0)
    OR ("kind" = 'REVERSAL' AND "priceCents" <= 0 AND "feeCents" <= 0)
  );
-- The free period means no fee, whatever the rate.
ALTER TABLE "club_fee_line" ADD CONSTRAINT club_fee_line_free_is_zero
  CHECK (NOT "freePeriod" OR "feeCents" = 0);

-- ═══ APPEND-ONLY ═══
--
-- The same shape as the credit ledger's (P16). A fee line that can be edited
-- is a statement that can change after it was invoiced. A correction is a
-- REVERSAL line; nothing is ever rewritten. TRUNCATE (the test harness) does
-- not fire row triggers.
CREATE OR REPLACE FUNCTION club_fee_line_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'club_fee_line is APPEND-ONLY: % is not permitted. A statement that can be rewritten after it was invoiced is not a statement. To correct a fee, INSERT a REVERSAL line.',
    TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS club_fee_line_append_only_trg ON "club_fee_line";
CREATE TRIGGER club_fee_line_append_only_trg
  BEFORE UPDATE OR DELETE ON "club_fee_line"
  FOR EACH ROW EXECUTE FUNCTION club_fee_line_append_only();

-- ─── Row security ───────────────────────────────────────────────────
--
-- A club reads its own lines (its statement) and writes them only through the
-- no-show path, which runs under its tenant binding. The completion sweep and
-- the platform read as app_superuser. No UPDATE or DELETE is granted at all:
-- the trigger is the second lock, not the only one.
ALTER TABLE "club_fee_line" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "club_fee_line" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "club_fee_line"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

CREATE POLICY superuser_bypass ON "club_fee_line" TO app_superuser
  USING (true) WITH CHECK (true);

GRANT SELECT, INSERT ON "club_fee_line" TO app_user, app_superuser;
