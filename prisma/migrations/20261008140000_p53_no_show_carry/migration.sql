-- P53: a deleted account's no-show standing carries to the next account made
-- with the same address (#370 review; owner decision 2026-10-08: "carry the
-- no-show block over").
--
-- Without it, deleting the account was a way out of a club's no-show block:
-- delete, sign in again with the same Google address, and book online the
-- same evening. With it, each club's standing waits for the new account: the
-- no-shows that still count there, for as long as they would have counted (90
-- days from each booking's start, src/app-layer/usecases/booking-rules.ts),
-- and a block the club's staff had lifted stays lifted. Tags and history do
-- not carry over.
--
-- ═══ WHAT IS KEPT, AND FOR HOW LONG ═══
--
-- One row per no-show that still counted at the moment of the deletion, and
-- only then: an account with no standing anywhere leaves nothing here. A row
-- holds the club, when the missed booking started, the tombstone it came from,
-- and a KEYED fingerprint of the address (src/lib/account/no-show-fingerprint.ts:
-- an HMAC under a key HKDF-derived from DATA_ENCRYPTION_KEY with its own
-- label). No name, no address. Each row is dropped once its no-show stops
-- counting; the completion sweep does it (`purgeLapsedNoShowCarries`), so
-- nothing outlives the standing it carries.
--
-- The fingerprint lives on these rows rather than on app_user: it exists
-- exactly as long as there is something to carry, and this file locks no
-- table the app is using. No foreign key, as player_venue_relationship and
-- credit_ledger_entry have none: a club is never deleted.
SET lock_timeout = '5s';

CREATE TABLE "no_show_carry" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "deletedUserId" TEXT NOT NULL,
  "inheritedByUserId" TEXT,
  "startedAt" TIMESTAMPTZ(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "no_show_carry_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "no_show_carry_fingerprint_idx" ON "no_show_carry" ("fingerprint");
CREATE INDEX "no_show_carry_tenantId_inheritedByUserId_idx"
  ON "no_show_carry" ("tenantId", "inheritedByUserId");
CREATE INDEX "no_show_carry_inheritedByUserId_idx" ON "no_show_carry" ("inheritedByUserId");
CREATE INDEX "no_show_carry_startedAt_idx" ON "no_show_carry" ("startedAt");

-- ─── RLS ──────────────────────────────────────────────────────────────
--
-- A club reads its own rows: a player's standing is computed under the club's
-- binding (`assertMayBookOnline`, the players screen). Only the superuser
-- writes: the deletion, the inheritance at sign-in, the sweep.
ALTER TABLE "no_show_carry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "no_show_carry" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "no_show_carry";
CREATE POLICY tenant_isolation ON "no_show_carry"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

DROP POLICY IF EXISTS superuser_bypass ON "no_show_carry";
CREATE POLICY superuser_bypass ON "no_show_carry" TO app_superuser
  USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON "no_show_carry" TO app_superuser;
REVOKE ALL ON "no_show_carry" FROM app_user;
GRANT SELECT ON "no_show_carry" TO app_user;
