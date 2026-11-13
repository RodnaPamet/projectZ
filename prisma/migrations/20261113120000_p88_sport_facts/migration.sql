-- P88: «Факт на седмицата», a weekly fun fact about the player's main sport
-- (owner 2026-11-13).
--
--   1. NotificationKind 'SPORT_FACT'   the bell row the weekly push is written
--                                      as. It is also what makes the push
--                                      once a week: its dedupe key names the
--                                      ISO week (`sport-fact:2026-W46`).
--   2. app_user."pushSportFacts"       its own push switch, beside the P77
--                                      ones. Push only: the fact is never
--                                      emailed, so there is no email switch.
--                                      On by default, as the others are.
--
-- ═══ ROLLING BACK ═══
--
-- The image before this one was generated without 'SPORT_FACT', and Prisma
-- refuses a whole query that reads one (#450). Run
-- deploy/rollback/p88-park.sql before starting it and p88-unpark.sql after
-- rolling forward again: docs/deploy-gcp.md, "Rolling back past p88". The
-- column is additive: NOT NULL with a default, so the old image's inserts
-- still succeed.
SET lock_timeout = '5s';

-- ADD VALUE cannot be used in the transaction that adds it, and nothing below
-- uses it.
ALTER TYPE "NotificationKind" ADD VALUE 'SPORT_FACT';

ALTER TABLE "app_user"
  ADD COLUMN "pushSportFacts" BOOLEAN NOT NULL DEFAULT true;
