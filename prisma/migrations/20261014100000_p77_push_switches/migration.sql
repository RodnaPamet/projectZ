-- P77 (#529): a push switch per kind, beside the email switches.
--
-- Every booking, message and club event writes a bell row and, when the
-- person wants it, an email (#367). With the iPhone app the same event also
-- rings the phone (#167), and the person decides that per kind, as for email:
-- a coach may want the lessons they teach on the phone and not in the inbox.
--
--   pushBookingConfirmations  pushBookingReminders  pushClubChanges
--   pushMessages              pushOpenPlay          pushLessonsTaught
--
-- On by default, as the email switches are: a phone only rings once the
-- person has installed the app and allowed notifications, which is the ask.
-- `account` (the platform's answers about the person's own account) has no
-- switch, for push as for email.
--
-- Rollback: additive. The previous image reads none of these, and they are
-- NOT NULL with defaults, so its inserts still succeed.
SET lock_timeout = '5s';

ALTER TABLE "app_user"
  ADD COLUMN "pushBookingConfirmations" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "pushBookingReminders" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "pushClubChanges" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "pushMessages" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "pushOpenPlay" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "pushLessonsTaught" BOOLEAN NOT NULL DEFAULT true;
