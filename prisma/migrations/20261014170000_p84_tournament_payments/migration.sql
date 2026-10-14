-- P84 (#581, Module 4 #378): a tournament's entry fee paid online through
-- Stripe Connect, and playerz's cut of it on the club's statement.
--
--   1. venue_org            the club's tournament cut, 0..30 % (decision 67).
--   2. tournament_entry     the payment on sign-up (64): the hosted checkout,
--                           its deadline, what was paid, and a refund owed
--                           and made (64, 65).
--   3. tournament_fee_line  playerz's cut per paid entry (66): append-only,
--                           a refund adds a REVERSAL, as club_fee_line does.
--
-- ═══ ROLLING BACK ═══
--
-- Nothing to park: new nullable columns, a column with a default, and a new
-- table, none of which the previous image reads. ClubFeeLineKind is reused,
-- not changed.

-- ─── 1. The club's tournament cut ───────────────────────────────────
ALTER TABLE "venue_org" ADD COLUMN "tournamentFeePercent" DECIMAL(4,2) NOT NULL DEFAULT 0;
ALTER TABLE "venue_org" ADD CONSTRAINT venue_org_tournament_fee_percent_range
  CHECK ("tournamentFeePercent" >= 0 AND "tournamentFeePercent" <= 30);

-- ─── 2. The payment on an entry ─────────────────────────────────────
ALTER TABLE "tournament_entry" ADD COLUMN "paymentDueBy" TIMESTAMPTZ(3),
ADD COLUMN "paidAt" TIMESTAMPTZ(3),
ADD COLUMN "paidCents" INTEGER,
ADD COLUMN "stripeCheckoutSessionId" TEXT,
ADD COLUMN "stripePaymentIntentId" TEXT,
ADD COLUMN "refundDueAt" TIMESTAMPTZ(3),
ADD COLUMN "refundedAt" TIMESTAMPTZ(3),
ADD COLUMN "refundedCents" INTEGER,
ADD COLUMN "stripeRefundId" TEXT;

CREATE UNIQUE INDEX "tournament_entry_stripeCheckoutSessionId_key" ON "tournament_entry"("stripeCheckoutSessionId");
CREATE UNIQUE INDEX "tournament_entry_stripePaymentIntentId_key" ON "tournament_entry"("stripePaymentIntentId");
CREATE UNIQUE INDEX "tournament_entry_stripeRefundId_key" ON "tournament_entry"("stripeRefundId");
CREATE INDEX "tournament_entry_paymentDueBy_idx" ON "tournament_entry"("paymentDueBy");
CREATE INDEX "tournament_entry_refundDueAt_idx" ON "tournament_entry"("refundDueAt");

-- Paid means an amount; a refund made means it was owed and the entry paid.
ALTER TABLE "tournament_entry" ADD CONSTRAINT tournament_entry_paid
  CHECK (("paidAt" IS NULL) = ("paidCents" IS NULL) AND ("paidCents" IS NULL OR "paidCents" > 0));
ALTER TABLE "tournament_entry" ADD CONSTRAINT tournament_entry_refunded
  CHECK (
    "refundedAt" IS NULL
    OR ("refundDueAt" IS NOT NULL AND "paidAt" IS NOT NULL AND "refundedCents" BETWEEN 1 AND "paidCents")
  );

-- ─── 3. playerz's cut ───────────────────────────────────────────────
CREATE TABLE "tournament_fee_line" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "paymentIntentId" TEXT NOT NULL,
    "kind" "ClubFeeLineKind" NOT NULL,
    "tournamentId" TEXT NOT NULL,
    "tournamentName" TEXT NOT NULL,
    "statementMonth" TEXT NOT NULL,
    "priceCents" INTEGER NOT NULL,
    "feeBps" INTEGER NOT NULL,
    "feeCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tournament_fee_line_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tournament_fee_line_paymentIntentId_kind_key" ON "tournament_fee_line"("paymentIntentId", "kind");
CREATE INDEX "tournament_fee_line_entryId_idx" ON "tournament_fee_line"("entryId");
CREATE INDEX "tournament_fee_line_tenantId_statementMonth_idx" ON "tournament_fee_line"("tenantId", "statementMonth");
CREATE INDEX "tournament_fee_line_statementMonth_idx" ON "tournament_fee_line"("statementMonth");

ALTER TABLE "tournament_fee_line" ADD CONSTRAINT tournament_fee_line_month_shape
  CHECK ("statementMonth" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');
ALTER TABLE "tournament_fee_line" ADD CONSTRAINT tournament_fee_line_bps_range
  CHECK ("feeBps" BETWEEN 0 AND 3000);
ALTER TABLE "tournament_fee_line" ADD CONSTRAINT tournament_fee_line_sign
  CHECK (
    ("kind" = 'CHARGE' AND "priceCents" >= 0 AND "feeCents" >= 0)
    OR ("kind" = 'REVERSAL' AND "priceCents" <= 0 AND "feeCents" <= 0)
  );

-- Append-only, the same lock as club_fee_line's (P48).
CREATE OR REPLACE FUNCTION tournament_fee_line_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'tournament_fee_line is APPEND-ONLY: % is not permitted. To correct a fee, INSERT a REVERSAL line.',
    TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tournament_fee_line_append_only_trg ON "tournament_fee_line";
CREATE TRIGGER tournament_fee_line_append_only_trg
  BEFORE UPDATE OR DELETE ON "tournament_fee_line"
  FOR EACH ROW EXECUTE FUNCTION tournament_fee_line_append_only();

-- ─── Row security ───────────────────────────────────────────────────
--
-- A club reads its own lines (its statement). Lines are written by the
-- webhook and the refund sweep, as app_superuser. No UPDATE or DELETE.
ALTER TABLE "tournament_fee_line" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tournament_fee_line" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "tournament_fee_line"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

CREATE POLICY superuser_bypass ON "tournament_fee_line" TO app_superuser
  USING (true) WITH CHECK (true);

GRANT SELECT, INSERT ON "tournament_fee_line" TO app_user, app_superuser;
