-- P87: favourite clubs (#672, owner decision 2026-11-12).
--
-- A player's heart on a venue, for «Любими» on the phone and the web. The
-- person's own row at every club, so the boundary is the person, as for the
-- bell (P22): owner-only on app.user_id, failing closed when it is unset.
--
-- Additive: a new table the previous image never names.

CREATE TABLE "favourite_venue" (
    "userId" TEXT NOT NULL,
    "venueId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "favourite_venue_pkey" PRIMARY KEY ("userId","venueId")
);

CREATE INDEX "favourite_venue_venueId_idx" ON "favourite_venue"("venueId");

ALTER TABLE "favourite_venue" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "favourite_venue" FORCE ROW LEVEL SECURITY;

CREATE POLICY favourite_venue_owner_only ON "favourite_venue"
  USING ("userId" = current_setting('app.user_id', true))
  WITH CHECK ("userId" = current_setting('app.user_id', true));

GRANT SELECT, INSERT, DELETE ON "favourite_venue" TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "favourite_venue" TO app_superuser;

-- A deleted account gains nothing new (P69, #465): no heart is written for it.
DROP TRIGGER IF EXISTS favourite_venue_account_not_deleted_trg ON "favourite_venue";
CREATE TRIGGER favourite_venue_account_not_deleted_trg
  BEFORE INSERT OR UPDATE OF "userId" ON "favourite_venue"
  FOR EACH ROW EXECUTE FUNCTION account_not_deleted('userId');
