SET lock_timeout = '5s';

-- P61: open play (#376). A booker opens their booking to other players, who
-- ask to join; the booker accepts or declines each (owner decision 2026-10-13).
--
-- ROLLING BACK PAST THIS MIGRATION meets enum values the previous image's
-- Prisma client was not generated with ("NotificationKind"), and Prisma 7
-- refuses a whole query that reads one. Park the bell rows that use them
-- first: deploy/rollback/p61-park.sql, and p61-unpark.sql after rolling
-- forward again (docs/deploy-gcp.md, "Rolling back past p61"). Everything else
-- here is new tables and columns the previous image does not map.

-- CreateEnum
CREATE TYPE "OpenGameRequestStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'WITHDRAWN', 'LAPSED', 'LEFT', 'REMOVED', 'CLOSED');

-- AlterEnum
ALTER TYPE "NotificationKind" ADD VALUE 'OPEN_PLAY_REQUESTED';
ALTER TYPE "NotificationKind" ADD VALUE 'OPEN_PLAY_ACCEPTED';
ALTER TYPE "NotificationKind" ADD VALUE 'OPEN_PLAY_DECLINED';
ALTER TYPE "NotificationKind" ADD VALUE 'OPEN_PLAY_LAPSED';
ALTER TYPE "NotificationKind" ADD VALUE 'OPEN_PLAY_CLOSED';

-- AlterTable
ALTER TABLE "app_user" ADD COLUMN     "emailOpenPlay" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "booking_participant" ADD COLUMN     "noShowAt" TIMESTAMPTZ(3);

-- «Игри» emails (`emailOpenPlay`) go through the outbox as category openPlay.
-- The previous image's drain reads the category as text, so a row of it left
-- behind by a rollback is still sent, under no setting it knows.
ALTER TABLE "email_outbox" DROP CONSTRAINT email_outbox_category_known;
ALTER TABLE "email_outbox" ADD CONSTRAINT email_outbox_category_known
  CHECK ("category" IN ('confirmation', 'reminder', 'clubChanges', 'messages', 'openPlay', 'contact'));

-- CreateTable
CREATE TABLE "open_game" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "bookingId" TEXT NOT NULL,
    "spotsWanted" INTEGER NOT NULL,
    "levelMin" SMALLINT,
    "levelMax" SMALLINT,
    "note" TEXT,
    "openedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "open_game_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "open_game_request" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "OpenGameRequestStatus" NOT NULL DEFAULT 'PENDING',
    "note" TEXT,
    "participantId" TEXT,
    "askedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "open_game_request_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "open_game_bookingId_key" ON "open_game"("bookingId");

-- CreateIndex
CREATE INDEX "open_game_tenantId_idx" ON "open_game"("tenantId");

-- CreateIndex
CREATE INDEX "open_game_closedAt_idx" ON "open_game"("closedAt");

-- CreateIndex
CREATE UNIQUE INDEX "open_game_request_participantId_key" ON "open_game_request"("participantId");

-- CreateIndex
CREATE INDEX "open_game_request_tenantId_idx" ON "open_game_request"("tenantId");

-- CreateIndex
CREATE INDEX "open_game_request_userId_askedAt_idx" ON "open_game_request"("userId", "askedAt");

-- CreateIndex
CREATE INDEX "open_game_request_status_idx" ON "open_game_request"("status");

-- CreateIndex
CREATE UNIQUE INDEX "open_game_request_gameId_userId_key" ON "open_game_request"("gameId", "userId");

-- AddForeignKey
ALTER TABLE "open_game" ADD CONSTRAINT "open_game_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "booking"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "open_game_request" ADD CONSTRAINT "open_game_request_gameId_fkey" FOREIGN KEY ("gameId") REFERENCES "open_game"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Shapes the use case keeps, held by the database too ──────────────────
ALTER TABLE "open_game" ADD CONSTRAINT "open_game_spots_positive"
  CHECK ("spotsWanted" >= 1);
ALTER TABLE "open_game" ADD CONSTRAINT "open_game_levels_valid"
  CHECK (
    ("levelMin" IS NULL OR "levelMin" BETWEEN 1 AND 7)
    AND ("levelMax" IS NULL OR "levelMax" BETWEEN 1 AND 7)
    AND ("levelMin" IS NULL OR "levelMax" IS NULL OR "levelMin" <= "levelMax")
  );
ALTER TABLE "open_game" ADD CONSTRAINT "open_game_note_bounded"
  CHECK ("note" IS NULL OR char_length("note") <= 280);
ALTER TABLE "open_game_request" ADD CONSTRAINT "open_game_request_note_bounded"
  CHECK ("note" IS NULL OR char_length("note") <= 280);
-- An ACCEPTED request names the place it holds, and no other state holds one.
ALTER TABLE "open_game_request" ADD CONSTRAINT "open_game_request_place_iff_accepted"
  CHECK (("status" = 'ACCEPTED') = ("participantId" IS NOT NULL));

-- ── Row security: a club's games and requests are that club's ───────────
--
-- The same two policies as every booking table (booking_invite_link, P45).
-- The cross-club reads (the Игри listing, a player's own requests at every
-- club) go through the use case's superuser phase, scoped by the request, as
-- booking-players.ts does; every write runs bound to the club.
ALTER TABLE "open_game" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "open_game" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "open_game"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
CREATE POLICY superuser_bypass ON "open_game" TO app_superuser
  USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON "open_game" TO app_user, app_superuser;

ALTER TABLE "open_game_request" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "open_game_request" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "open_game_request"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));
CREATE POLICY superuser_bypass ON "open_game_request" TO app_superuser
  USING (true) WITH CHECK (true);
GRANT SELECT, INSERT, UPDATE, DELETE ON "open_game_request" TO app_user, app_superuser;
