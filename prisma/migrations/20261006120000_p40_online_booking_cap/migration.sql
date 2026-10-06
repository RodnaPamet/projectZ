-- P40: a per-club cap on a player's upcoming ONLINE bookings (#380).
--
-- Owner decision, 2026-10-04: each club sets how many upcoming online bookings
-- one player may hold there at once, default 3. Desk bookings and recurring
-- series do not count toward it and are never limited.
--
-- ═══ ADDITIVE ONLY ═══
--
-- Production rolls back by re-tagging the previous image, which must keep
-- working against this schema. A new enum type and two new NOT NULL columns
-- with constant defaults: the previous image never names them, its INSERTs get
-- the defaults, and on Postgres 11+ a constant default is a catalogue change,
-- not a table rewrite.

-- How a booking was made. Until now there was no record of it, and there was
-- no need: the only writer of `booking` is `createBooking`, and its only
-- caller is the player route (`POST /api/v1/t/{slug}/bookings`). Desk booking
-- (#364) has no caller yet. So every existing row WAS made online, and the
-- default is the backfill: ADD COLUMN … DEFAULT fills them as ONLINE. It is
-- also the right value for what the previous image writes after a rollback,
-- since that image's only writer is the same player route.
CREATE TYPE "BookingChannel" AS ENUM ('ONLINE', 'DESK');

ALTER TABLE "booking" ADD COLUMN "channel" "BookingChannel" NOT NULL DEFAULT 'ONLINE';

-- The cap, per club. 1..50: zero would be "no online booking at all", which is
-- a different decision from a cap, and past 50 the number stops limiting
-- anyone — a club that wants no practical cap sets 50.
ALTER TABLE "venue_org" ADD COLUMN "maxUpcomingOnlineBookings" INTEGER NOT NULL DEFAULT 3;
ALTER TABLE "venue_org" ADD CONSTRAINT venue_org_max_upcoming_online_bookings_range
  CHECK ("maxUpcomingOnlineBookings" BETWEEN 1 AND 50);
