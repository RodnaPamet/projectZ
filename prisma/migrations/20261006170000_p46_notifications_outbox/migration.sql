-- P46 (#367): notifications by email and in the bell, and the 3-hour reminder.
-- ADDITIVE only: one enum, four enum values, one table, nullable or defaulted
-- columns, and indexes.
--
-- The previous image keeps working against this schema: it never reads
-- `email_outbox`, it selects `notification`, `app_user` and `booking` by
-- explicit columns, and it writes `notification` only through
-- `notifyAfterCommit`, whose INSERT leaves `dedupeKey` NULL (NULLs are
-- distinct, so the new unique index never refuses it).

-- ─── Enums ───────────────────────────────────────────────────────────

-- CreateEnum
CREATE TYPE "EmailOutboxStatus" AS ENUM ('PENDING', 'SENT', 'SKIPPED', 'DEAD');

-- AlterEnum: who is playing changed (#416). Bell only.
ALTER TYPE "NotificationKind" ADD VALUE 'BOOKING_PLAYER_JOINED';
ALTER TYPE "NotificationKind" ADD VALUE 'BOOKING_PLAYER_LEFT';
ALTER TYPE "NotificationKind" ADD VALUE 'BOOKING_PLAYER_ADDED';
ALTER TYPE "NotificationKind" ADD VALUE 'BOOKING_PLAYER_REMOVED';

-- ─── Email settings per person (Q22) ─────────────────────────────────
--
-- On by default. A constant default is a catalogue change in Postgres 11+,
-- not a table rewrite.

-- AlterTable
ALTER TABLE "app_user" ADD COLUMN     "emailBookingConfirmations" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "emailBookingReminders" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "emailClubChanges" BOOLEAN NOT NULL DEFAULT true;

-- ─── The reminder's claim ────────────────────────────────────────────
--
-- Set once by `UPDATE … WHERE status = 'CONFIRMED' AND "reminderSentAt" IS
-- NULL`: the row lock that statement takes is the same one a cancel takes, so
-- a reminder and a cancel cannot both win.

-- AlterTable
ALTER TABLE "booking" ADD COLUMN     "reminderSentAt" TIMESTAMPTZ(3);

-- CreateIndex
CREATE INDEX "booking_status_startTs_idx" ON "booking"("status", "startTs");

-- ─── One bell row per event per person ───────────────────────────────

-- AlterTable
ALTER TABLE "notification" ADD COLUMN     "dedupeKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "notification_userId_dedupeKey_key" ON "notification"("userId", "dedupeKey");

-- CreateIndex: the bell's keyset page, newest first.
CREATE INDEX "notification_userId_createdAt_id_idx" ON "notification"("userId", "createdAt" DESC, "id" DESC);

-- ─── The email outbox ────────────────────────────────────────────────

-- CreateTable
CREATE TABLE "email_outbox" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "NotificationKind" NOT NULL,
    "category" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "locale" "Locale" NOT NULL,
    "subject" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "refType" TEXT,
    "refId" TEXT,
    "status" "EmailOutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3),
    "lastError" TEXT,
    "provider" TEXT,
    "sentAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "email_outbox_status_nextAttemptAt_idx" ON "email_outbox"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "email_outbox_refType_refId_idx" ON "email_outbox"("refType", "refId");

-- CreateIndex
CREATE UNIQUE INDEX "email_outbox_userId_dedupeKey_key" ON "email_outbox"("userId", "dedupeKey");

-- AddForeignKey: an account's unsent mail goes with the account.
ALTER TABLE "email_outbox" ADD CONSTRAINT "email_outbox_userId_fkey" FOREIGN KEY ("userId") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A subject is one header line. The renderer already strips line breaks; this
-- is the guarantee that nothing else can store one (header injection).
ALTER TABLE "email_outbox" ADD CONSTRAINT email_outbox_subject_one_line
  CHECK ("subject" !~ '[\r\n]');

ALTER TABLE "email_outbox" ADD CONSTRAINT email_outbox_attempts_non_negative
  CHECK ("attempts" >= 0);

ALTER TABLE "email_outbox" ADD CONSTRAINT email_outbox_category_known
  CHECK ("category" IN ('confirmation', 'reminder', 'clubChanges', 'messages'));

-- ─── RLS ─────────────────────────────────────────────────────────────
--
-- Personal, like `notification` (P22): owner-only on app.user_id, so the
-- bell row and its email are written together in the recipient's binding.
-- The 2-arg current_setting fails closed when unset. The drain is machine
-- work across every user and binds app_superuser (BYPASSRLS); the bypass
-- policy is the usual defence in depth.
ALTER TABLE "email_outbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "email_outbox" FORCE ROW LEVEL SECURITY;

CREATE POLICY email_outbox_owner_only ON "email_outbox"
  USING ("userId" = current_setting('app.user_id', true))
  WITH CHECK ("userId" = current_setting('app.user_id', true));

CREATE POLICY superuser_bypass ON "email_outbox" TO app_superuser
  USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON "email_outbox" TO app_user, app_superuser;
