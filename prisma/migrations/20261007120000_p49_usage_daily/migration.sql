-- P49 (#371): server-side usage counts. ADDITIVE only: one enum and one table.
--
-- The previous image never names `usage_daily` or `UsageEvent`, so it keeps
-- working against this schema unchanged; rows counted before a rollback stay,
-- and counting resumes when the image comes back.

-- CreateEnum
CREATE TYPE "UsageEvent" AS ENUM ('VENUES_VIEW', 'VENUE_VIEW', 'SLOTS_VIEW', 'SLOT_PICKED', 'SHEET_OPENED', 'BOOKING_CREATED');

-- CreateTable
--
-- One row per (day, event, venue): a daily counter, never one row per hit.
-- No column names a person (no user id, IP address, user agent or session):
-- tests/guardrails/usage-no-personal-data.test.ts holds that, and
-- tests/integration/usage-counts.test.ts asks the catalogue.
CREATE TABLE "usage_daily" (
    "day" DATE NOT NULL,
    "event" "UsageEvent" NOT NULL,
    "venueId" TEXT NOT NULL DEFAULT '',
    "clubId" TEXT,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "usage_daily_pkey" PRIMARY KEY ("day","event","venueId")
);

-- CreateIndex: the platform view's per-club funnel over a range of days.
CREATE INDEX "usage_daily_clubId_day_idx" ON "usage_daily"("clubId", "day");

ALTER TABLE "usage_daily" ADD CONSTRAINT usage_daily_count_non_negative
  CHECK ("count" >= 0);

-- ─── RLS: denied to app_user outright ────────────────────────────────
--
-- The shape of mfa_recovery_code (P38): an explicit USING (false), and the
-- companion policy named literally `superuser_bypass`. The writer
-- (src/lib/usage/record.ts) runs as app_superuser; the reader is the platform
-- usage route, through asPlatformAdmin, which audits every read.
ALTER TABLE "usage_daily" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "usage_daily" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS usage_daily_deny_all ON "usage_daily";
CREATE POLICY usage_daily_deny_all ON "usage_daily"
  USING (false)
  WITH CHECK (false);

DROP POLICY IF EXISTS superuser_bypass ON "usage_daily";
CREATE POLICY superuser_bypass ON "usage_daily"
  TO app_superuser
  USING (true)
  WITH CHECK (true);

-- ─── Privileges ──────────────────────────────────────────────────────
--
-- Counting needs INSERT and UPDATE (the upsert), reading needs SELECT. No
-- DELETE: the counters are aggregates with nothing personal in them, and they
-- are kept (docs/usage-counts.md).
GRANT SELECT, INSERT, UPDATE ON "usage_daily" TO app_superuser;
REVOKE ALL ON "usage_daily" FROM app_user;
