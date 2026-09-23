-- ════════════════════════════════════════════════════════════════════
--  P27 — ENTRA GROUP MAPPINGS
--
--  Storage for "which Entra security group grants which role at this
--  club". Two tables: the club's provider configuration, and the group
--  mappings themselves.
--
--  ── OWNER IS NOT MAPPABLE, AND THAT IS ENFORCED FOUR TIMES ──────────
--
--  A mapping that granted OWNER would make club ownership transferable
--  by editing an Active Directory group — by people who administer a
--  directory, outside this application, and who have no way of knowing
--  that OWNER carries admin.tenant_lifecycle (suspend the club) and
--  admin.owner_management (change who owns it).
--
--  So it is refused in the Zod schema, in the use case, in the sync's
--  OWNER-immunity check, and here by a CHECK constraint. Four places
--  sounds excessive until you notice that the first three are all one
--  careless edit away from being gone, and the fourth is the only one
--  that also binds a psql session.
--
--  ── UNIQUENESS IS A CORRECTNESS CONSTRAINT, NOT TIDINESS ────────────
--
--  Two mapping rows for the same group would make the winner depend on
--  scan order — a role assignment that changes when the planner changes
--  its mind. Likewise two ENTRA_ID provider rows for one club would make
--  "which config applies?" a coin flip.
--
--  ── ROW LEVEL SECURITY ──────────────────────────────────────────────
--
--  Both tables are tenant-scoped, symmetric USING and WITH CHECK, and
--  the two-argument current_setting so an unset binding is NULL rather
--  than an error. A club must not be able to read, still less write,
--  another club's group mappings: those rows describe who can administer
--  that club.
-- ════════════════════════════════════════════════════════════════════

CREATE TYPE "IdentityProviderType" AS ENUM ('ENTRA_ID');

CREATE TABLE "tenant_identity_provider" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "type" "IdentityProviderType" NOT NULL,
    "configJson" JSONB NOT NULL DEFAULT '{}',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_identity_provider_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tenant_identity_provider_tenantId_type_key"
  ON "tenant_identity_provider"("tenantId", "type");
CREATE INDEX "tenant_identity_provider_tenantId_idx"
  ON "tenant_identity_provider"("tenantId");

CREATE TABLE "tenant_entra_group_mapping" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "aadGroupId" TEXT NOT NULL,
    "aadGroupName" TEXT,
    "role" "Role" NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_entra_group_mapping_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tenant_entra_group_mapping_tenantId_aadGroupId_key"
  ON "tenant_entra_group_mapping"("tenantId", "aadGroupId");
CREATE INDEX "tenant_entra_group_mapping_tenantId_priority_idx"
  ON "tenant_entra_group_mapping"("tenantId", "priority");

-- The last line of defence. Application code can be edited; this cannot be,
-- without a migration that someone has to write and review on purpose.
ALTER TABLE "tenant_entra_group_mapping"
  ADD CONSTRAINT tenant_entra_group_mapping_role_not_owner CHECK ("role" <> 'OWNER');

-- A priority outside this band is a typo, not a preference.
ALTER TABLE "tenant_entra_group_mapping"
  ADD CONSTRAINT tenant_entra_group_mapping_priority_bounded
  CHECK ("priority" >= 0 AND "priority" <= 1000);

ALTER TABLE "tenant_identity_provider" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_identity_provider" FORCE ROW LEVEL SECURITY;
ALTER TABLE "tenant_entra_group_mapping" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_entra_group_mapping" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_identity_provider_tenant_isolation ON "tenant_identity_provider"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

CREATE POLICY tenant_entra_group_mapping_tenant_isolation ON "tenant_entra_group_mapping"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user, app_superuser;
