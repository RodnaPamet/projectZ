-- ════════════════════════════════════════════════════════════════════
--  P28 — WEBHOOK EVENT DEDUPLICATION
--
--  Stripe guarantees AT LEAST ONCE delivery and retries on any non-2xx.
--  It will deliver the same event twice in ordinary operation, and an
--  event can be replayed from the dashboard on purpose.
--
--  Until now the only replay protection was the signed timestamp inside
--  `constructEvent`, so a replay inside Stripe's tolerance window was
--  accepted and processed again. That was survivable only because every
--  handler happened to write absolute state — or, in the case of
--  `payment_intent.succeeded`, nothing at all.
--
--  It stops being survivable the moment a handler confirms a booking and
--  records a payment, which is what P28 exists to enable.
--
--  ── NO TENANT, AND NO POLICY, ON PURPOSE ────────────────────────────
--
--  A webhook arrives before anything knows which tenant it concerns —
--  that is discovered by looking the event up. So there is no tenantId
--  column and no tenant_isolation policy.
--
--  RLS is still ENABLEd and FORCEd. A table with row-level security on
--  and NO policy denies every role that does not hold BYPASSRLS, which
--  is precisely the intent: only the webhook path, running as
--  app_superuser, may touch this. `app_user` cannot read it even though
--  the blanket GRANT below names it.
--
--  That is a deliberate use of the empty-policy case, not an omission.
--  If a future migration adds a policy here, it is widening access.
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE "webhook_event" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'STRIPE',
    "eventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_event_pkey" PRIMARY KEY ("id")
);

-- The whole point of the table. Without this index the row is a log entry;
-- with it, a replay is a no-op.
CREATE UNIQUE INDEX "webhook_event_provider_eventId_key"
  ON "webhook_event"("provider", "eventId");

-- For pruning old rows later: this table grows forever otherwise.
CREATE INDEX "webhook_event_receivedAt_idx" ON "webhook_event"("receivedAt");

ALTER TABLE "webhook_event" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "webhook_event" FORCE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user, app_superuser;

-- ── ONE PAYMENT ROW PER CHARGE ──────────────────────────────────────
--
-- `payment` had an INDEX on "providerRefId" but no UNIQUE, so Prisma's
-- `skipDuplicates` on the webhook's Payment write had nothing to skip on
-- and quietly inserted a second PAID row for a redelivered event. Two
-- rows for one charge means the club's books show twice the money, which
-- is the kind of error that is found by an accountant months later.
--
-- NULL does not conflict with NULL in a Postgres unique index, so a
-- payment recorded without a provider reference is unaffected.
CREATE UNIQUE INDEX "payment_provider_providerRefId_key"
  ON "payment"("provider", "providerRefId");

