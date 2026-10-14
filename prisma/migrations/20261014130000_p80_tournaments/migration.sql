-- P80 (#579, Module 4 #378): a club's tournament, its entries, and telling
-- people about them. The tables are P21's, never written until now (0 rows on
-- both databases on 2026-10-14).
--
--   1. four NotificationKind values    a new entry, to the club's desk; the
--                                      partner an entrant named (decision
--                                      50); the club's answer, to both of a
--                                      pair; a withdrawal, to the other of the
--                                      pair and the desk.
--   2. four TournamentFormatKind       groups feeding a knockout, Americano,
--      values                          Mexicano, a league (decision 37).
--   3. tournament                      where it is played, a description, an
--                                      end, when sign-up closes, singles or
--                                      doubles, how the fee is paid (39), who
--                                      created it; listed across clubs by
--                                      status and start (53).
--   4. tournament_entry                the partner, the status through the
--                                      club's confirmation and the waiting
--                                      list (38, 51), who decided and who
--                                      withdrew.
--   5. CHECKs, app_superuser's policy on the three tables, and
--      account_not_deleted on the entrant and the partner (#465).
--
-- ═══ ROLLING BACK ═══
--
-- The image before this one was generated without the eight enum values, and
-- Prisma refuses a whole query that reads one (#450). Run
-- deploy/rollback/p80-park.sql before starting it and p80-unpark.sql after
-- rolling forward again: docs/deploy-gcp.md, "Rolling back past p80".

-- ─── 1, 2. The enum values ──────────────────────────────────────────────────
--
-- ADD VALUE cannot be used in the transaction that adds it, and nothing below
-- uses one.
ALTER TYPE "NotificationKind" ADD VALUE 'TOURNAMENT_ENTRY_RECEIVED';
ALTER TYPE "NotificationKind" ADD VALUE 'TOURNAMENT_PARTNER_NAMED';
ALTER TYPE "NotificationKind" ADD VALUE 'TOURNAMENT_ENTRY_DECIDED';
ALTER TYPE "NotificationKind" ADD VALUE 'TOURNAMENT_ENTRY_WITHDRAWN';

ALTER TYPE "TournamentFormatKind" ADD VALUE 'GROUPS_KNOCKOUT';
ALTER TYPE "TournamentFormatKind" ADD VALUE 'AMERICANO';
ALTER TYPE "TournamentFormatKind" ADD VALUE 'MEXICANO';
ALTER TYPE "TournamentFormatKind" ADD VALUE 'LEAGUE';

CREATE TYPE "TournamentFeePayment" AS ENUM ('AT_CLUB', 'ONLINE');
CREATE TYPE "TournamentEntryStatus" AS ENUM ('PENDING', 'CONFIRMED', 'DECLINED', 'WITHDRAWN');

-- ─── 3. tournament ──────────────────────────────────────────────────────────
ALTER TABLE "tournament" ADD COLUMN     "createdByUserId" TEXT,
ADD COLUMN     "description" TEXT,
ADD COLUMN     "endsAt" TIMESTAMP(3),
ADD COLUMN     "entriesCloseAt" TIMESTAMP(3),
ADD COLUMN     "feePayment" "TournamentFeePayment" NOT NULL DEFAULT 'AT_CLUB',
ADD COLUMN     "teamSize" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "venueId" TEXT;

CREATE INDEX "tournament_status_startsAt_idx" ON "tournament"("status", "startsAt");
CREATE INDEX "tournament_venueId_idx" ON "tournament"("venueId");

ALTER TABLE "tournament" ADD CONSTRAINT "tournament_venueId_fkey" FOREIGN KEY ("venueId") REFERENCES "venue"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "tournament" ADD CONSTRAINT tournament_team_size CHECK ("teamSize" IN (1, 2));
ALTER TABLE "tournament" ADD CONSTRAINT tournament_draw_size CHECK ("maxPlayers" BETWEEN 2 AND 256);
ALTER TABLE "tournament" ADD CONSTRAINT tournament_fee_not_negative CHECK ("entryFeeCents" >= 0);
ALTER TABLE "tournament" ADD CONSTRAINT tournament_name_length CHECK (char_length("name") BETWEEN 1 AND 120);
ALTER TABLE "tournament" ADD CONSTRAINT tournament_description_length CHECK (
  "description" IS NULL OR char_length("description") <= 2000
);
ALTER TABLE "tournament" ADD CONSTRAINT tournament_ends_after_start CHECK (
  "endsAt" IS NULL OR "endsAt" >= "startsAt"
);
ALTER TABLE "tournament" ADD CONSTRAINT tournament_entries_close_by_start CHECK (
  "entriesCloseAt" IS NULL OR "entriesCloseAt" <= "startsAt"
);

-- ─── 4. tournament_entry ────────────────────────────────────────────────────
ALTER TABLE "tournament_entry" ADD COLUMN     "decidedAt" TIMESTAMP(3),
ADD COLUMN     "decidedByUserId" TEXT,
ADD COLUMN     "partnerUserId" TEXT,
ADD COLUMN     "status" "TournamentEntryStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "withdrawnByUserId" TEXT;

CREATE INDEX "tournament_entry_partnerUserId_idx" ON "tournament_entry"("partnerUserId");
CREATE INDEX "tournament_entry_tournamentId_status_createdAt_idx" ON "tournament_entry"("tournamentId", "status", "createdAt");
CREATE UNIQUE INDEX "tournament_entry_tournamentId_partnerUserId_key" ON "tournament_entry"("tournamentId", "partnerUserId");

-- A pair is two people.
ALTER TABLE "tournament_entry" ADD CONSTRAINT tournament_entry_partner_is_another CHECK (
  "partnerUserId" IS NULL OR "partnerUserId" <> "playerUserId"
);
-- A withdrawn entry says when; nothing else does.
ALTER TABLE "tournament_entry" ADD CONSTRAINT tournament_entry_withdrawn_when CHECK (
  ("status" = 'WITHDRAWN') = ("withdrawnAt" IS NOT NULL)
);

-- ─── 5. app_superuser, and a deleted account enters nothing ────────────────
--
-- The cross-club list of tournaments open for sign-up (decision 53), and the
-- entries a person is in at every club, bind app_superuser, as open play's
-- list does.
DROP POLICY IF EXISTS superuser_bypass ON "tournament";
CREATE POLICY superuser_bypass ON "tournament" TO app_superuser USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS superuser_bypass ON "tournament_entry";
CREATE POLICY superuser_bypass ON "tournament_entry" TO app_superuser USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS superuser_bypass ON "tournament_match";
CREATE POLICY superuser_bypass ON "tournament_match" TO app_superuser USING (true) WITH CHECK (true);

DROP TRIGGER IF EXISTS tournament_entry_player_account_not_deleted_trg ON "tournament_entry";
CREATE TRIGGER tournament_entry_player_account_not_deleted_trg
  BEFORE INSERT OR UPDATE OF "playerUserId" ON "tournament_entry"
  FOR EACH ROW EXECUTE FUNCTION account_not_deleted('playerUserId');

DROP TRIGGER IF EXISTS tournament_entry_partner_account_not_deleted_trg ON "tournament_entry";
CREATE TRIGGER tournament_entry_partner_account_not_deleted_trg
  BEFORE INSERT OR UPDATE OF "partnerUserId" ON "tournament_entry"
  FOR EACH ROW EXECUTE FUNCTION account_not_deleted('partnerUserId');
