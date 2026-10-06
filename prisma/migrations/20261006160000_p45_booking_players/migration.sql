-- P45 (#358): players on a booking. ADDITIVE only: one new table, one new
-- unique index and one CHECK on a table nothing has written to yet.
--
-- The booker adds players up to the court's capacity, by a shareable link or
-- by picking somebody they have played with before. Added players are rows of
-- the existing `booking_participant` (P05), positions 2..capacity; the booker
-- is position 1 and is NOT a row, because every booking made before this
-- migration has a booker and no participant rows, and "the booker is
-- `booking.bookedByUserId`" stays true for all of them without a backfill.
--
-- The previous image keeps working against this schema: it never reads the
-- new table, and it never writes `booking_participant`.

-- ─── The invite link ─────────────────────────────────────────────────
--
-- Only an HMAC of the token is stored (`hashForLookup`, the scheme staff
-- invites and sessions use), so a copy of this table is not a set of working
-- links. `expiresAt` is the booking's start, written when the link is made.

-- CreateTable
CREATE TABLE "booking_invite_link" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),
    "revokedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "booking_invite_link_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "booking_invite_link_tenantId_idx" ON "booking_invite_link"("tenantId");

-- CreateIndex
CREATE INDEX "booking_invite_link_bookingId_idx" ON "booking_invite_link"("bookingId");

-- CreateIndex
CREATE UNIQUE INDEX "booking_invite_link_tokenHash_key" ON "booking_invite_link"("tokenHash");

-- AddForeignKey
ALTER TABLE "booking_invite_link" ADD CONSTRAINT "booking_invite_link_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─── A person is on a booking once ───────────────────────────────────
--
-- The use case checks first, so this is the guarantee under a race: two taps
-- on the same link, or a link and a pick from recent players at the same
-- moment. Guests (userId NULL) are unconstrained: NULLs are distinct.
-- `booking_participant` has never been written by the application, so there
-- is nothing for the index build to trip on.

-- CreateIndex
CREATE UNIQUE INDEX "booking_participant_bookingId_userId_key" ON "booking_participant"("bookingId", "userId");

-- Positions are 1-based (`/// 1..court.capacity` on the model). The upper
-- bound is the court's, which a CHECK cannot read; the use case holds it under
-- a row lock on the booking.
ALTER TABLE "booking_participant" ADD CONSTRAINT booking_participant_position_positive
  CHECK ("position" >= 1);

-- ─── RLS ─────────────────────────────────────────────────────────────
--
-- Tenant-scoped like every booking table (P05): the link belongs to the
-- booking's club. The token lookup itself (which club is this token for?)
-- happens before any tenant is known and is the one superuser read; every
-- write runs bound to the booking's tenant. The 2-arg current_setting fails
-- closed when the setting is absent.
ALTER TABLE "booking_invite_link" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "booking_invite_link" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "booking_invite_link"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

CREATE POLICY superuser_bypass ON "booking_invite_link" TO app_superuser
  USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON "booking_invite_link" TO app_user, app_superuser;
