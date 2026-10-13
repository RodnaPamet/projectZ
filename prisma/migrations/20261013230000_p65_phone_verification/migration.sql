-- P65 (#500): a phone number, confirmed by an SMS code, that follows a person.
--
-- Owner decision 2026-10-13: every player and coach confirms a phone number
-- before their first booking, join request or message, because the address
-- alone does not stop a blocked person: a new email is a new account. One
-- number confirms ONE account at a time, and a number carries its no-show
-- standing to the next account that confirms it, as the address already does
-- (P53).
--
-- ═══ WHAT IS STORED ═══
--
--   app_user.phone            the confirmed number, ENCRYPTED (field
--                             encryption, as mfaSecret). The column existed
--                             and was empty on production and staging when
--                             this was written (2026-10-13): nothing wrote it.
--   app_user.phoneHash        a keyed fingerprint of the number in E.164
--                             (src/lib/account/phone-fingerprint.ts: an HMAC
--                             under a key derived from DATA_ENCRYPTION_KEY).
--                             What "is this number taken?" is asked of, so
--                             the number itself is never compared in SQL.
--   app_user.phoneVerifiedAt  when the code was confirmed.
--   no_show_carry.phoneFingerprint
--                             the same fingerprint on a deleted account's
--                             carried no-shows, so the standing passes to the
--                             next account that confirms the number, and
--                             lapses with the rows (90 days).
--
-- UNIQUE on phoneHash: a number confirms one account. NULLs are distinct, so
-- every account without a number is unaffected.
--
-- Rollback: additive. The previous image reads and writes none of these. One
-- caveat while this is live: the previous image's account deletion does not
-- clear phoneHash, so the CHECK below refuses it for an account that had
-- confirmed a number; roll forward again before deleting such an account.
SET lock_timeout = '5s';

ALTER TABLE "app_user"
  ADD COLUMN "phoneHash" TEXT,
  ADD COLUMN "phoneVerifiedAt" TIMESTAMPTZ(3);

CREATE UNIQUE INDEX "app_user_phoneHash_key" ON "app_user"("phoneHash");

-- A deleted account holds no number: the fingerprint leaves the tombstone
-- (and waits on its carried no-shows, if it has any). Beside P52's
-- app_user_deleted_is_scrubbed rather than inside it, so that one stays as
-- validated. NOT VALID here, validated in P65b, for P52b's reason.
ALTER TABLE "app_user" ADD CONSTRAINT app_user_deleted_has_no_phone CHECK (
  "deletedAt" IS NULL OR ("phoneHash" IS NULL AND "phoneVerifiedAt" IS NULL)
) NOT VALID;

ALTER TABLE "no_show_carry" ADD COLUMN "phoneFingerprint" TEXT;
CREATE INDEX "no_show_carry_phoneFingerprint_idx" ON "no_show_carry"("phoneFingerprint");
