-- ════════════════════════════════════════════════════════════════════
--  P26 — THE AUDIT LOG
--
--  Nothing in this application has ever written down who changed what.
--  That was survivable while every privileged change was made by a human
--  through a UI that logged nothing but was at least attributable by
--  memory. It stops being survivable the moment a change can be made
--  AUTOMATICALLY — by a directory group sync, a webhook, or a job — where
--  there is no human to ask.
--
--  This table is the prerequisite for that, and it is deliberately built
--  before the feature that needs it rather than alongside it.
--
--  ── WHY THE TRIGGER, AND NOT A CODE CONVENTION ──────────────────────
--
--  An audit log that application code is trusted not to rewrite is an
--  audit log on the honour system. Every future repository, every admin
--  script, every migration and every psql session would be part of the
--  trusted set. One UPDATE to "tidy up" a support ticket and the history
--  is a lie that nobody can detect afterwards — because the whole point
--  of the record is that it is the only copy.
--
--  So the database refuses. Application code cannot bypass it, a
--  repository bug cannot silently rewrite history, and a well-meaning
--  operator with a database prompt cannot either.
--
--  Unlike credit_ledger_entry there is no compensating-entry story here.
--  A balance can be corrected by adding a reversing row; a wrong audit
--  line cannot be un-said. It stays, and the correction is another row
--  saying so. That is the intended behaviour, not a limitation.
--
--  ── ROW LEVEL SECURITY ──────────────────────────────────────────────
--
--  Tenant-isolated like every other tenant-scoped table, symmetric USING
--  and WITH CHECK, and the two-argument current_setting so that an unset
--  binding yields NULL rather than raising — and `"tenantId" = NULL` is
--  NULL, never TRUE. Fail-closed.
--
--  RLS still permits DELETE at the policy level; the trigger is what
--  refuses it. Two independent mechanisms, because this is the table you
--  least want a single point of failure on.
-- ════════════════════════════════════════════════════════════════════

CREATE TYPE "AuditActorType" AS ENUM ('USER', 'SYSTEM', 'API_KEY');

CREATE TABLE "audit_entry" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "actorUserId" TEXT,
    "actorType" "AuditActorType" NOT NULL DEFAULT 'USER',
    "entity" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "details" TEXT,
    "detailsJson" JSONB NOT NULL DEFAULT '{}',
    "requestId" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_entry_pkey" PRIMARY KEY ("id")
);

-- tenantId LEADS every index: it is in every query's WHERE clause because RLS
-- puts it there, so an index that does not lead with it cannot be used.
CREATE INDEX "audit_entry_tenantId_createdAt_idx" ON "audit_entry"("tenantId", "createdAt");
CREATE INDEX "audit_entry_tenantId_entity_entityId_idx" ON "audit_entry"("tenantId", "entity", "entityId");
CREATE INDEX "audit_entry_tenantId_actorUserId_idx" ON "audit_entry"("tenantId", "actorUserId");

-- No foreign key on "actorUserId", deliberately. CASCADE would erase what
-- somebody did at the moment their account is deleted, which is exactly when
-- it matters; RESTRICT would let the audit log block account deletion forever.
-- Erasure anonymises the user row instead.

ALTER TABLE "audit_entry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_entry" FORCE ROW LEVEL SECURITY;

CREATE POLICY audit_entry_tenant_isolation ON "audit_entry"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

CREATE OR REPLACE FUNCTION audit_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'audit_entry is APPEND-ONLY: % is not permitted. A history you can edit is not a history. To correct a mistaken entry, INSERT another recording the correction.',
    TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_append_only_trg ON "audit_entry";
CREATE TRIGGER audit_append_only_trg
  BEFORE UPDATE OR DELETE ON "audit_entry"
  FOR EACH ROW EXECUTE FUNCTION audit_append_only();

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user, app_superuser;
