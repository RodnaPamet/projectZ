-- ═══════════════════════════════════════════════════════════════════════
--  P31 — PLATFORM ADMINISTRATION
-- ═══════════════════════════════════════════════════════════════════════
--
-- The first authority in this product that spans clubs. Everything here is
-- shaped by one fact about how this database is actually reached:
--
--   DATABASE_URL connects as `playerz`, which is rolsuper=true AND
--   rolbypassrls=true. (Verified against the running cluster.)
--
-- Every binding in src/lib/db/rls-middleware.ts issues `SET LOCAL ROLE
-- app_user` (rolbypassrls=false), and all 54 RLS tables are FORCEd, so
-- isolation genuinely holds INSIDE a binding. Outside one there is none at
-- all — the only thing keeping queries inside bindings is a CI text scan
-- (route-db-binding), which accepts `runAsSuperuser` as a valid answer.
--
-- So a guarantee that rests on a Postgres ROLE is a guarantee this repo does
-- not currently have. The accountability below therefore rests on TRIGGERS,
-- which fire for the table owner and the superuser alike:
--
--   platform_audit_attribution   — an audit row cannot be forged, written on
--                                  someone else's behalf, or omitted
--   platform_audit_append_only   — and cannot be edited afterwards
--   platform_admin_grant_immutable — a grant is insert-plus-one-revocation
--
-- P24 created `playerz_app LOGIN NOINHERIT` to fix the connection problem and
-- was never adopted. Until it is, triggers are the only mechanism here that
-- actually binds.

-- ── The capability enum ─────────────────────────────────────────────────
--
-- A Postgres enum, not text[]: an ungranted capability cannot be spelled, and
-- adding one is a migration a reviewer sees.
CREATE TYPE "PlatformCapability" AS ENUM ('TENANT_READ', 'AUDIT_READ', 'USER_READ', 'TENANT_SUSPEND');

-- NO `ALTER TYPE "AuditActorType" ADD VALUE 'PLATFORM'` here, deliberately.
--
-- An earlier draft added it for a club-side mirror of platform access. The owner
-- decided platform reads are recorded in platform_audit_entry ONLY and are not
-- surfaced in a club's own audit log, so nothing would write that value — and
-- Postgres cannot DROP an enum value once it exists. An unused enum value is a
-- permanent one, which is how `appPermissions` and PLATFORM_ADMIN_API_KEY each
-- came to look finished while doing nothing.

-- ── platform_admin_grant ────────────────────────────────────────────────
CREATE TABLE "platform_admin_grant" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "grantedByUserId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "capabilities" "PlatformCapability"[],
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedByUserId" TEXT,
    "revokeReason" TEXT,

    CONSTRAINT "platform_admin_grant_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "platform_admin_grant_userId_revokedAt_idx" ON "platform_admin_grant"("userId", "revokedAt");

ALTER TABLE "platform_admin_grant"
  ADD CONSTRAINT "platform_admin_grant_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- No FK on grantedByUserId or revokedByUserId, for the reason audit_entry has
-- none on actorUserId: the record of who authorised this must outlive the
-- account, and CASCADE would erase it at exactly the moment it matters.

-- ── What a grant may not be ─────────────────────────────────────────────

-- Nobody bootstraps themselves. This is what makes the first grant two-party
-- by construction, and it is the reason there is no in-app grant route: a
-- stolen session cannot mint a peer, so it is bounded by the one grant it
-- holds and dies when that grant is revoked or expires.
ALTER TABLE "platform_admin_grant"
  ADD CONSTRAINT "platform_admin_grant_no_self_grant"
  CHECK ("userId" <> "grantedByUserId");

-- "Admin for ever" is not expressible, rather than merely discouraged. A
-- nullable expiresAt means grants ARE permanent in practice — nobody goes back.
ALTER TABLE "platform_admin_grant"
  ADD CONSTRAINT "platform_admin_grant_expiry_cap"
  CHECK ("expiresAt" > "grantedAt" AND "expiresAt" <= "grantedAt" + interval '90 days');

-- A grant nobody had to justify is a grant nobody has to defend.
ALTER TABLE "platform_admin_grant"
  ADD CONSTRAINT "platform_admin_grant_reason_stated"
  CHECK (length(btrim("reason")) >= 12);

-- An empty capability array would read as a live grant that permits nothing,
-- which is a confusing way to spell "revoked".
--
-- `cardinality()` and NOT `array_length(x, 1)`. The obvious spelling is a trap
-- measured here: array_length(ARRAY[]::"PlatformCapability"[], 1) returns NULL
-- rather than 0, `NULL >= 1` evaluates to NULL, and a CHECK treats NULL as
-- SATISFIED. The constraint read correctly and accepted every empty array.
-- cardinality() returns 0 for an empty array, which compares as intended.
ALTER TABLE "platform_admin_grant"
  ADD CONSTRAINT "platform_admin_grant_capabilities_nonempty"
  CHECK (cardinality("capabilities") >= 1);

-- Revocation is three columns; a partially-filled revocation is a row nobody
-- can interpret later.
ALTER TABLE "platform_admin_grant"
  ADD CONSTRAINT "platform_admin_grant_revocation_complete"
  CHECK (
    ("revokedAt" IS NULL AND "revokedByUserId" IS NULL AND "revokeReason" IS NULL)
    OR
    ("revokedAt" IS NOT NULL AND "revokedByUserId" IS NOT NULL AND "revokeReason" IS NOT NULL)
  );

-- At most one un-revoked grant per person.
--
-- The predicate cannot mention expiry: an index predicate must be IMMUTABLE
-- and now() is not. So an EXPIRED-but-unrevoked grant still occupies the slot,
-- and renewing means revoking first. That is deliberate — it makes renewal an
-- explicit two-step act in one transaction rather than a silent accumulation
-- of overlapping grants nobody can reason about.
CREATE UNIQUE INDEX "platform_admin_grant_one_live_idx"
  ON "platform_admin_grant"("userId") WHERE "revokedAt" IS NULL;

-- ── platform_audit_entry ────────────────────────────────────────────────
--
-- Separate from audit_entry because that model CANNOT express this row:
-- audit_entry."tenantId" is TEXT NOT NULL, its policy's WITH CHECK is
-- symmetric on tenantId, and AuditInput.tenantId is a required string written
-- unconditionally. A platform action may name no club at all — a cross-club
-- search belongs to none of them.
CREATE TABLE "platform_audit_entry" (
    "id" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "grantId" TEXT NOT NULL,
    "capability" "PlatformCapability" NOT NULL,
    "action" TEXT NOT NULL,
    -- NOT named "tenantId", and that is load-bearing: rls-coverage and
    -- tenant-isolation-structural both key off that exact field name, and this
    -- row REFERENCES a tenant rather than BELONGING to one. Naming it tenantId
    -- would enlist the one cross-tenant table in tenant-scoped RLS.
    "subjectTenantId" TEXT,
    "entity" TEXT,
    "entityId" TEXT,
    "reason" TEXT NOT NULL,
    "detailsJson" JSONB NOT NULL DEFAULT '{}',
    "requestId" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_audit_entry_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "platform_audit_entry_createdAt_idx" ON "platform_audit_entry"("createdAt");
CREATE INDEX "platform_audit_entry_actorUserId_createdAt_idx" ON "platform_audit_entry"("actorUserId", "createdAt");
CREATE INDEX "platform_audit_entry_subjectTenantId_createdAt_idx" ON "platform_audit_entry"("subjectTenantId", "createdAt");

-- ── RLS: both tables deny app_user outright ─────────────────────────────
--
-- `USING (false)` rather than no policy at all. A table with RLS enabled and
-- no policy also denies, but silently and by omission; an explicit false says
-- this was decided. Same shape as password_reset_token (P23), which
-- rls-policy-shape.test.ts:165-173 pins.
--
-- The companion policy is named literally `superuser_bypass` because that is
-- the one policyname rls-policy-shape.test.ts:128-130 exempts from the
-- trivially-permissive rule. Renaming it would fail that test, correctly.

ALTER TABLE "platform_admin_grant" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_admin_grant" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS platform_admin_grant_deny_all ON "platform_admin_grant";
CREATE POLICY platform_admin_grant_deny_all ON "platform_admin_grant"
  USING (false)
  WITH CHECK (false);

DROP POLICY IF EXISTS superuser_bypass ON "platform_admin_grant";
CREATE POLICY superuser_bypass ON "platform_admin_grant"
  TO app_superuser
  USING (true)
  WITH CHECK (true);

ALTER TABLE "platform_audit_entry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "platform_audit_entry" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS platform_audit_entry_deny_all ON "platform_audit_entry";
CREATE POLICY platform_audit_entry_deny_all ON "platform_audit_entry"
  USING (false)
  WITH CHECK (false);

DROP POLICY IF EXISTS superuser_bypass ON "platform_audit_entry";
CREATE POLICY superuser_bypass ON "platform_audit_entry"
  TO app_superuser
  USING (true)
  WITH CHECK (true);

-- ── Trigger 1: the audit row cannot be forged or omitted ────────────────
--
-- THIS is the mechanism the whole design rests on. `app.platform_admin_id` is
-- set by runAsPlatformAdmin on the transaction, with a bound parameter, and
-- this trigger refuses any insert whose actorUserId does not match it.
--
-- Consequences, all intended:
--   - a row cannot be written outside runAsPlatformAdmin (no GUC → refused)
--   - it cannot be attributed to somebody else (mismatch → refused)
--   - and because runAsPlatformAdmin writes it BEFORE calling the callback in
--     the SAME transaction, a failed audit write means the privileged action
--     never happens. Accountability is not something a caller remembers.
CREATE OR REPLACE FUNCTION platform_audit_attribution() RETURNS trigger AS $$
DECLARE
  claimed text;
BEGIN
  claimed := current_setting('app.platform_admin_id', true);

  IF claimed IS NULL OR claimed = '' THEN
    RAISE EXCEPTION
      'platform_audit_entry requires app.platform_admin_id on the transaction. This row was inserted outside runAsPlatformAdmin, which is the only sanctioned writer.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF claimed <> NEW."actorUserId" THEN
    RAISE EXCEPTION
      'platform_audit_entry attribution mismatch: transaction is bound to % but the row claims %. A platform audit row may only be written about the admin performing the action.',
      claimed, NEW."actorUserId"
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS platform_audit_attribution_trg ON "platform_audit_entry";
CREATE TRIGGER platform_audit_attribution_trg
  BEFORE INSERT ON "platform_audit_entry"
  FOR EACH ROW EXECUTE FUNCTION platform_audit_attribution();

-- ── Trigger 2: and cannot be rewritten afterwards ───────────────────────
--
-- Its own function rather than reusing audit_append_only() so the exception
-- names the right table when it fires.
CREATE OR REPLACE FUNCTION platform_audit_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'platform_audit_entry is APPEND-ONLY: % is not permitted. This is the record of cross-club access; a record that can be edited is not evidence, and still looks like it.',
    TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS platform_audit_append_only_trg ON "platform_audit_entry";
CREATE TRIGGER platform_audit_append_only_trg
  BEFORE UPDATE OR DELETE ON "platform_audit_entry"
  FOR EACH ROW EXECUTE FUNCTION platform_audit_append_only();

-- ── Trigger 3: a grant is INSERT plus at most one revocation ────────────
--
-- Without this, `expiresAt` is advisory: anyone reaching the table could push
-- it forward, widen `capabilities`, or delete the revocation. The 90-day CHECK
-- would still pass on the new row, because it is relative to grantedAt.
CREATE OR REPLACE FUNCTION platform_admin_grant_immutable() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'platform_admin_grant rows are never deleted. Revoke the grant instead: the history of who held platform authority, and who ended it, is the point.'
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD."revokedAt" IS NOT NULL THEN
    RAISE EXCEPTION
      'platform_admin_grant % is already revoked; a revocation cannot be amended. Issue a new grant.', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  -- Column immutability is checked BEFORE "did you set revokedAt", so an
  -- attempt to widen a privilege is reported AS one and names the column.
  -- The other order refuses correctly but blames the missing revokedAt, which
  -- sends whoever hits it looking in the wrong place — measured while writing
  -- the test for this, which expected the specific message and got the generic
  -- one.
  IF NEW."expiresAt" <> OLD."expiresAt" THEN
    RAISE EXCEPTION
      'platform_admin_grant % is immutable except for revocation: expiresAt may never be moved. Without this the 90-day cap is advisory, because the CHECK is relative to grantedAt. Issue a new grant instead.', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."capabilities" <> OLD."capabilities" THEN
    RAISE EXCEPTION
      'platform_admin_grant % is immutable except for revocation: capabilities may never be widened. A new capability needs a new grant, with its own reason and its own granter.', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW."id"              <> OLD."id"
     OR NEW."userId"          <> OLD."userId"
     OR NEW."grantedByUserId" <> OLD."grantedByUserId"
     OR NEW."reason"          <> OLD."reason"
     OR NEW."grantedAt"       <> OLD."grantedAt" THEN
    RAISE EXCEPTION
      'platform_admin_grant % is immutable except for revocation; who held it, who issued it and why may not be rewritten after the fact.', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;

  -- Everything protected is unchanged, so the only remaining question is
  -- whether this update is actually a revocation.
  IF NEW."revokedAt" IS NULL THEN
    RAISE EXCEPTION
      'the only permitted update to platform_admin_grant is setting revokedAt. Nothing else about a grant may change after it is issued.'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS platform_admin_grant_immutable_trg ON "platform_admin_grant";
CREATE TRIGGER platform_admin_grant_immutable_trg
  BEFORE UPDATE OR DELETE ON "platform_admin_grant"
  FOR EACH ROW EXECUTE FUNCTION platform_admin_grant_immutable();

-- ── Grants ──────────────────────────────────────────────────────────────
--
-- P03 grants app_user all four DML verbs on ALL TABLES plus default
-- privileges, so both tables are already reachable by app_user as far as
-- privileges go. The deny-all policies above are what actually stop it, which
-- is why they are explicit rather than relying on an absent policy.
--
-- REVOKE anyway: privilege and policy are independent, and a future migration
-- that loosens a policy should not also inherit write privilege it never
-- needed. app_user has no business in either table by any path.
REVOKE ALL ON "platform_admin_grant" FROM app_user;
REVOKE ALL ON "platform_audit_entry" FROM app_user;

GRANT SELECT, INSERT, UPDATE, DELETE ON "platform_admin_grant" TO app_superuser;
GRANT SELECT, INSERT, UPDATE, DELETE ON "platform_audit_entry" TO app_superuser;
