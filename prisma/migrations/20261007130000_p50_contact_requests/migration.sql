-- P50 (#369): the landing page's "For clubs" enquiries, and their email to the
-- operator through the outbox (#367).
--
-- ADDITIVE for every reader: one table, one enum value per enum, one partial
-- index, one CHECK widened, and `email_outbox.userId` RELAXED to nullable.
--
-- The previous image keeps working against this schema:
--   - it never reads `contact_request` and never names CONTACT_READ or
--     CONTACT_REQUEST;
--   - it writes `email_outbox` only with a userId and one of the four old
--     categories, which the new CHECKs accept;
--   - its drain could claim a `contact` row during a rollout overlap. It finds
--     no user for the NULL id and marks the row SKIPPED ('no-address'), which
--     costs that one email, never a crash: the enquiry itself is in
--     `contact_request` either way and is listed on /platform.

-- ─── Enums ───────────────────────────────────────────────────────────

-- AlterEnum: the email to the operator about an enquiry. Email only, no bell.
ALTER TYPE "NotificationKind" ADD VALUE 'CONTACT_REQUEST';

-- AlterEnum: reading the enquiries is a platform READ, granted by name.
-- ADD VALUE runs inside a transaction on Postgres 12+; the value is not used
-- in this migration (see P36 for the same shape).
ALTER TYPE "PlatformCapability" ADD VALUE 'CONTACT_READ';

-- ─── The enquiries ───────────────────────────────────────────────────

-- CreateTable
CREATE TABLE "contact_request" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "clubName" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "message" TEXT NOT NULL,
    "locale" "Locale" NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contact_request_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: the platform list, newest first, keyset on (createdAt, id).
CREATE INDEX "contact_request_createdAt_id_idx" ON "contact_request"("createdAt" DESC, "id" DESC);

-- The form validates all of this with zod; these are the guarantee that
-- nothing else can store a row the operator cannot answer, or a novel.
ALTER TABLE "contact_request" ADD CONSTRAINT contact_request_reachable
  CHECK ("phone" IS NOT NULL OR "email" IS NOT NULL);

ALTER TABLE "contact_request" ADD CONSTRAINT contact_request_lengths
  CHECK (
    char_length("name") BETWEEN 1 AND 120
    AND char_length("clubName") BETWEEN 1 AND 160
    AND ("phone" IS NULL OR char_length("phone") BETWEEN 5 AND 40)
    AND ("email" IS NULL OR char_length("email") BETWEEN 3 AND 254)
    AND char_length("message") BETWEEN 1 AND 2000
  );

-- ─── RLS ─────────────────────────────────────────────────────────────
--
-- Nobody's row: an anonymous visitor writes it and the platform reads it.
-- `app_user` gets nothing (deny-all, as `platform_admin_grant` in P31); the
-- form's Server Action writes BYPASSRLS, and the platform reads it through
-- `asPlatformAdmin` (BYPASSRLS, audited). The bypass policy is the usual
-- defence in depth.
ALTER TABLE "contact_request" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "contact_request" FORCE ROW LEVEL SECURITY;

CREATE POLICY contact_request_deny_all ON "contact_request"
  USING (false)
  WITH CHECK (false);

CREATE POLICY superuser_bypass ON "contact_request" TO app_superuser
  USING (true) WITH CHECK (true);

REVOKE ALL ON "contact_request" FROM app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "contact_request" TO app_superuser;

-- ─── The outbox learns one row with no user ──────────────────────────
--
-- The email about an enquiry goes to the operator, who is not a user row. Its
-- address is read from CONTACT_INBOX_EMAIL at send time, like every other
-- outbox row reads `app_user.email` then: no address is stored.

-- AlterTable: relaxing NOT NULL is a catalogue change, not a rewrite.
ALTER TABLE "email_outbox" ALTER COLUMN "userId" DROP NOT NULL;

-- Only the operator's category may have no user.
ALTER TABLE "email_outbox" ADD CONSTRAINT email_outbox_user_or_contact
  CHECK ("userId" IS NOT NULL OR "category" = 'contact');

-- The category list, widened by one. Dropped and re-added in one transaction.
ALTER TABLE "email_outbox" DROP CONSTRAINT email_outbox_category_known;
ALTER TABLE "email_outbox" ADD CONSTRAINT email_outbox_category_known
  CHECK ("category" IN ('confirmation', 'reminder', 'clubChanges', 'messages', 'contact'));

-- `UNIQUE (userId, dedupeKey)` treats NULL userIds as distinct, so the
-- operator's rows are deduped by their own partial index: one email per
-- enquiry, however often the write is retried.
CREATE UNIQUE INDEX "email_outbox_contact_dedupeKey_key" ON "email_outbox"("dedupeKey")
  WHERE "userId" IS NULL;
