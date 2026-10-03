-- P39: the Sofia pilot's booking model (#354).
--
-- Owner decisions, 2026-10-04: a booking made online is CONFIRMED at once and
-- paid at the club; a player cancels in the app until the club's cutoff
-- (default 24 h), after which only the club can; three no-shows in 90 days
-- block online booking at that club until staff lift it.
--
-- ═══ ADDITIVE ONLY ═══
--
-- Production rolls back by re-tagging the previous image, which must keep
-- working against this schema. Every change is a new column with a default
-- (or nullable), so the previous image reads and writes these tables exactly
-- as before and simply never looks at them.

-- The player's self-cancel cutoff, per venue. 0 means "until the start";
-- a week is the ceiling, because a longer cutoff is a club that does not want
-- players to cancel at all, and that is not a setting this offers.
ALTER TABLE "venue" ADD COLUMN "cancellationCutoffHours" INTEGER NOT NULL DEFAULT 24;
ALTER TABLE "venue" ADD CONSTRAINT venue_cancellation_cutoff_range
  CHECK ("cancellationCutoffHours" BETWEEN 0 AND 168);

-- Online payment, per club. Off for everyone: the pilot pays at the club. The
-- Stripe flow stays behind it rather than being deleted.
ALTER TABLE "venue_org" ADD COLUMN "onlinePaymentEnabled" BOOLEAN NOT NULL DEFAULT false;

-- Staff lifting a no-show block. The block itself is computed, never stored.
ALTER TABLE "player_venue_relationship"
  ADD COLUMN "noShowBlockClearedAt" TIMESTAMPTZ(3),
  ADD COLUMN "noShowBlockClearedByUserId" TEXT;
