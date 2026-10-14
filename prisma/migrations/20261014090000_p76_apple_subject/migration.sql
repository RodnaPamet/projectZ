-- P76 (#442): the Apple account a person signs in with.
--
-- Owner decisions 2026-10-14: Sign in with Apple on the iPhone (and on the
-- web), and a person who hides their address behind Apple's relay confirms a
-- real one with a code before going on. Accounts are found by address, and a
-- relay address is not one: it differs per app and says nothing about the
-- person. So the account remembers the Apple subject it was confirmed for,
-- and the next Apple sign-in finds it by that, not by the relay address.
--
--   app_user.appleSubject  the `sub` of Apple's identity token: stable for
--                          one Apple ID and this developer team. UNIQUE, so
--                          one Apple ID signs into one account. NULL for
--                          every account that never used Apple.
--
-- Rollback: additive. The previous image reads and writes none of it. One
-- caveat while this is live: the previous image's account deletion does not
-- clear appleSubject, so the CHECK below refuses it for an account that has
-- one; roll forward again before deleting such an account (P65's caveat).
SET lock_timeout = '5s';

ALTER TABLE "app_user" ADD COLUMN "appleSubject" TEXT;

CREATE UNIQUE INDEX "app_user_appleSubject_key" ON "app_user"("appleSubject");

-- A deleted account holds no Apple subject, so the same Apple ID signing in
-- afterwards makes a NEW account, as the same Google address does. NOT VALID
-- here, validated in P76b, for P52b's reason.
ALTER TABLE "app_user" ADD CONSTRAINT app_user_deleted_has_no_apple_subject CHECK (
  "deletedAt" IS NULL OR "appleSubject" IS NULL
) NOT VALID;
