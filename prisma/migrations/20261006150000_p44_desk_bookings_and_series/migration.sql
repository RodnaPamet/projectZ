-- P44 (#364): desk bookings and weekly recurring series.
--
-- Owner decisions Q30/Q41 (2026-10-04): staff enter a booking from the diary
-- for a customer known by name and phone, optionally linked to a playerz
-- account, and can repeat it every week for a regular until a date or for N
-- weeks. Each occurrence is an ordinary booking.
--
-- ═══ WHAT ALREADY EXISTED ═══
--
-- `booking.guestName` and `booking.guestPhone` (P05) carry the desk customer,
-- and `booking.channel = 'DESK'` (P40) marks the booking as the club's. So a
-- single desk booking needs no new column. Only the series is new: a rule row
-- (`booking_series`) and the link from each occurrence back to it.
--
-- ═══ ADDITIVE ONLY ═══
--
-- Production rolls back by re-tagging the previous image. That image never
-- names `booking_series` or `booking.seriesId`: a nullable column with no
-- default is a catalogue change, and its INSERTs leave it null. A series made
-- before a rollback keeps its occurrences, which the old image shows and
-- cancels as the plain DESK bookings they are.

CREATE TABLE "booking_series" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "startTime" TEXT NOT NULL,
    "durationMinutes" INTEGER NOT NULL,
    "timezone" TEXT NOT NULL,
    "firstDate" DATE NOT NULL,
    "lastDate" DATE NOT NULL,
    "customerName" TEXT NOT NULL,
    "customerPhone" TEXT NOT NULL,
    "customerUserId" TEXT,
    "priceCents" INTEGER,
    "notes" TEXT,
    "createdByUserId" TEXT,
    "cancelledFrom" DATE,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "booking_series_pkey" PRIMARY KEY ("id")
);

-- The database's own sanity on the rule, beside the API's zod: a write that
-- skipped the schema (a script, a future route) still cannot store a 25:00
-- start, a zero-length slot, a series that ends before it starts, or a
-- negative price.
ALTER TABLE "booking_series" ADD CONSTRAINT booking_series_start_time_shape
  CHECK ("startTime" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');
ALTER TABLE "booking_series" ADD CONSTRAINT booking_series_duration_range
  CHECK ("durationMinutes" BETWEEN 15 AND 1440);
ALTER TABLE "booking_series" ADD CONSTRAINT booking_series_dates_ordered
  CHECK ("lastDate" >= "firstDate");
ALTER TABLE "booking_series" ADD CONSTRAINT booking_series_price_non_negative
  CHECK ("priceCents" IS NULL OR "priceCents" >= 0);

CREATE INDEX "booking_series_tenantId_resourceId_idx" ON "booking_series"("tenantId", "resourceId");
CREATE INDEX "booking_series_resourceId_idx" ON "booking_series"("resourceId");
CREATE UNIQUE INDEX "booking_series_tenantId_idempotencyKey_key" ON "booking_series"("tenantId", "idempotencyKey");

ALTER TABLE "booking_series" ADD CONSTRAINT "booking_series_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "court"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Each occurrence points back at its series. SET NULL, not CASCADE: nothing
-- deletes a series today, and if something ever does, the bookings it made are
-- still bookings somebody is coming to play.
ALTER TABLE "booking" ADD COLUMN "seriesId" TEXT;

CREATE INDEX "booking_seriesId_startTs_idx" ON "booking"("seriesId", "startTs");

ALTER TABLE "booking" ADD CONSTRAINT "booking_seriesId_fkey" FOREIGN KEY ("seriesId") REFERENCES "booking_series"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─── RLS ─────────────────────────────────────────────────────────────
--
-- Tenant-scoped like `booking`, with the same two policies P05 gives every
-- tenant table: the club bound in `app.tenant_id` (two-argument
-- current_setting, so an unbound session sees nothing), and the superuser
-- bypass for the cross-club paths.
ALTER TABLE "booking_series" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "booking_series" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "booking_series"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

CREATE POLICY superuser_bypass ON "booking_series" TO app_superuser
  USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON "booking_series" TO app_user, app_superuser;
