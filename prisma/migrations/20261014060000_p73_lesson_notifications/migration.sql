-- P73 — TELLING PEOPLE ABOUT LESSONS: a coach's notifications (#550, #377).
--
-- Trains 13 to 15 let a player book a lesson, a coach cancel one and a club
-- take a coach on. Nothing yet tells the COACH that a lesson was booked with
-- them, or cancelled; nor a club that a coach asked to teach there. This is
-- what those notifications need of the database.
--
--   1. app_user."emailLessonsTaught"   the sixth email switch, for a coach's
--                                      emails about the lessons they teach
--                                      (owner decision 22). On by default.
--   2. seven NotificationKind values   to the coach: a lesson booked, a lesson
--                                      cancelled, a reminder; a club accepted,
--                                      declined or ended their link. To the
--                                      club: a coach asked to teach there.
--   3. the email category              'lessonsTaught', what the switch in (1)
--                                      turns on and off.
--
-- A player's own lesson emails need nothing here: they are booking emails
-- (BOOKING_CONFIRMED, BOOKING_REMINDER, BOOKING_CANCELLED) under the switches
-- court bookings have.
--
-- ═══ ROLLING BACK ═══
--
-- The image before this one was generated without the seven enum values, and
-- Prisma refuses a whole query that reads one (#450). Run
-- deploy/rollback/p73-park.sql before starting it and p73-unpark.sql after
-- rolling forward again: docs/deploy-gcp.md, "Rolling back past p73".

-- ─── 1. The switch ─────────────────────────────────────────────────────────
--
-- Every account gets the column and only a coach is shown the switch: an
-- account that becomes a coach later starts with it on, as every email switch
-- starts. The previous image does not map the column and is not troubled by it.
ALTER TABLE "app_user" ADD COLUMN "emailLessonsTaught" BOOLEAN NOT NULL DEFAULT true;

-- ─── 2. The notification kinds ─────────────────────────────────────────────
--
-- ADD VALUE cannot be used in the transaction that adds it, and nothing below
-- uses one.
ALTER TYPE "NotificationKind" ADD VALUE 'LESSON_BOOKED';
ALTER TYPE "NotificationKind" ADD VALUE 'LESSON_CANCELLED';
ALTER TYPE "NotificationKind" ADD VALUE 'LESSON_REMINDER';
ALTER TYPE "NotificationKind" ADD VALUE 'COACH_LINK_REQUESTED';
ALTER TYPE "NotificationKind" ADD VALUE 'COACH_LINK_ACCEPTED';
ALTER TYPE "NotificationKind" ADD VALUE 'COACH_LINK_DECLINED';
ALTER TYPE "NotificationKind" ADD VALUE 'COACH_LINK_ENDED';

-- ─── 3. The email category ─────────────────────────────────────────────────
--
-- The previous image's drain reads the category as text and sends what it
-- does not know, so a row of it left behind by a rollback still goes out
-- (its KIND is what that image cannot read, and the park script moves it).
ALTER TABLE "email_outbox" DROP CONSTRAINT email_outbox_category_known;
ALTER TABLE "email_outbox" ADD CONSTRAINT email_outbox_category_known
  CHECK ("category" IN (
    'confirmation', 'reminder', 'clubChanges', 'messages', 'openPlay', 'contact', 'account',
    'lessonsTaught'
  ));
