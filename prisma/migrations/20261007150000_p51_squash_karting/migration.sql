-- P51: squash and karting, for the pilot clubs (owner decisions, 2026-10-07).
--
--   SQUASH  a court sport like any other: Maleeva Club's indoor court.
--   KARTING exclusive hire of a whole track, in steps like a court. Laps and
--           arrive-and-drive sessions stay the club's own sales.
--   TRACK   the resource a karting booking holds. Booking, availability and
--           pricing treat it exactly as they treat a COURT; it exists so the
--           copy can call it a "писта", not a "корт" (src/lib/sports/resource-kinds.ts).
--
-- ═══ ADDITIVE, AND NOTHING HERE USES WHAT IT ADDS ═══
--
-- Postgres refuses to USE an enum value inside the transaction that added it
-- ("unsafe use of new value"), and Prisma runs each migration in one
-- transaction. So this file only adds: no row, default, CHECK or index here
-- names a new value. The first writes come from the application and from
-- `scripts/onboard-club.ts`, each in a later transaction.
--
-- The positions keep the database's sort order close to the schema's
-- sections: `/venues` lists the sports it filters by in enum order
-- (`listVenueFacets`, `orderBy: { sport: 'asc' }`), so squash sits beside the
-- other racket sports and karting before the endurance sports.
--
-- ═══ ROLLING BACK ═══
--
-- Nothing here needs undoing: an image built before P51 runs against this
-- schema unchanged while no row holds a new value. A row that does is another
-- matter. Prisma 7 refuses to read an enum value its client was not generated
-- with ("Value 'SQUASH' not found in enum 'SportType'"), so ONE squash court
-- at a public venue fails the previous image's whole `/venues` page, and its
-- filters, for everybody. Park those rows before starting it:
-- docs/deploy-gcp.md, "Rolling back past p51", and deploy/rollback/p51-park.sql.

ALTER TYPE "SportType" ADD VALUE 'SQUASH' AFTER 'PICKLEBALL';
ALTER TYPE "SportType" ADD VALUE 'KARTING' AFTER 'ESPORTS';
ALTER TYPE "ResourceType" ADD VALUE 'TRACK';
