-- P38: a real second factor for platform admins (#262).
--
-- TOTP enrolment with recovery codes, and a step-up bound to the session that
-- every cross-club WRITE now requires. The REVIEW_MODERATE exception (#228)
-- ends with this: the moderation queue works only after a fresh step-up.
--
-- ═══ ADDITIVE ONLY — THE ROLLBACK IS RE-TAGGING THE PREVIOUS IMAGE ═══
--
-- docs/deploy-gcp.md, "Rolling back past p37": production rolls back by
-- running the previous image against the CURRENT schema. So nothing here
-- drops, renames or retypes anything the previous image reads:
--
--   - three nullable columns are ADDED (app_user ×2, user_session ×1). Prisma
--     names its columns in every SELECT, so the old client never sees them;
--   - two tables are CREATED that the old image does not know exist;
--   - `app_user."mfaSecret"` is REUSED, not replaced. The old image never
--     reads or writes it (grep: no call site before #262), so a ciphertext in
--     it is invisible to that image;
--   - one CHECK is added on `mfaSecret`, which every existing row passes
--     because every existing row is NULL — nothing has ever written it.
--
-- After such a rollback the old image's binding admits REVIEW_MODERATE
-- without a step-up again (its own ENABLED_PLATFORM_WRITES), which is exactly
-- the behaviour it shipped with. Nothing here makes the old image fail.
--
-- ═══ IDEMPOTENT ═══
--
-- IF NOT EXISTS / OR REPLACE / DROP … IF EXISTS throughout, so a deploy that
-- died half-way is resolved rolled-back and deployed again.

-- ── 1. app_user: enrolment state ─────────────────────────────────────────
--
-- "mfaSecret" already exists (P04) and has never been written. From here on it
-- holds the `v1:` AES-256-GCM envelope from src/lib/security/encryption.ts —
-- the same envelope as the wearable OAuth tokens — and never a plaintext seed.
-- It is set when enrolment STARTS; "mfaEnabledAt" is set when the first code
-- is confirmed. A secret with no enabledAt is a pending enrolment and is never
-- accepted for a step-up.
--
-- "mfaLastUsedStep" is the 30-second TOTP step most recently accepted. A code
-- is valid for ~90 s (±1 step), so without this a code read over someone's
-- shoulder could be replayed inside that window; the verifier accepts only a
-- step strictly greater than this, with a conditional UPDATE so two concurrent
-- requests cannot both spend the same code.
ALTER TABLE "app_user" ADD COLUMN IF NOT EXISTS "mfaEnabledAt" TIMESTAMP(3);
ALTER TABLE "app_user" ADD COLUMN IF NOT EXISTS "mfaLastUsedStep" BIGINT;

-- A plaintext seed defeats the whole second factor, and the column comment
-- that once claimed it was encrypted was false for its entire life (see
-- tests/guardrails/encryption-claims.test.ts). So the database refuses
-- anything that is not the envelope. It cannot prove the bytes are
-- ciphertext, but it does make "stored the seed as-is" an error at the first
-- write rather than a finding in an audit.
ALTER TABLE "app_user" DROP CONSTRAINT IF EXISTS "app_user_mfa_secret_is_envelope";
ALTER TABLE "app_user"
  ADD CONSTRAINT "app_user_mfa_secret_is_envelope"
  CHECK ("mfaSecret" IS NULL OR "mfaSecret" LIKE 'v1:%');

-- Enabled means there is a secret to verify against.
ALTER TABLE "app_user" DROP CONSTRAINT IF EXISTS "app_user_mfa_enabled_has_secret";
ALTER TABLE "app_user"
  ADD CONSTRAINT "app_user_mfa_enabled_has_secret"
  CHECK ("mfaEnabledAt" IS NULL OR "mfaSecret" IS NOT NULL);

-- ── 2. user_session: the step-up, bound to ONE session ──────────────────
--
-- When this session last proved the second factor. On the session row rather
-- than in the JWT, for three reasons:
--
--   - a JWT claim cannot be taken back. Revoking the session (sign out,
--     password change, "sign out everywhere") must end the step-up with it,
--     and it does: the row is revoked, so the join that reads this fails;
--   - it cannot be copied. A second session of the same person — another
--     browser, the phone — has its own row and must step up on its own;
--   - the edge never sees it. Only the platform binding reads it, inside the
--     transaction that does the write.
ALTER TABLE "user_session" ADD COLUMN IF NOT EXISTS "mfaVerifiedAt" TIMESTAMP(3);

-- ── 3. mfa_recovery_code ────────────────────────────────────────────────
--
-- Single-use codes for a lost phone. Stored as SHA-256 of a code with 80 bits
-- of entropy (src/lib/auth/totp.ts says why that needs no key). Spending one
-- is `UPDATE … SET "usedAt" = now() WHERE "usedAt" IS NULL`, so a code cannot
-- be spent twice even by two requests racing.
CREATE TABLE IF NOT EXISTS "mfa_recovery_code" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mfa_recovery_code_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "mfa_recovery_code_userId_codeHash_key"
  ON "mfa_recovery_code"("userId", "codeHash");

DO $$
BEGIN
  ALTER TABLE "mfa_recovery_code"
    ADD CONSTRAINT "mfa_recovery_code_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── 4. account_security_event ───────────────────────────────────────────
--
-- What happened to a person's second factor: enrolment started and
-- confirmed, every step-up that succeeded or failed, every recovery code
-- spent, every regeneration.
--
-- Not platform_audit_entry: that row needs a grant and a capability being
-- EXERCISED, and enrolling a phone exercises none. Not audit_entry: its
-- tenantId is NOT NULL and this is about no club. So its own table, shaped
-- like both — no FK on userId (the record outlives the account), append-only
-- by trigger, and denied to app_user outright.
CREATE TABLE IF NOT EXISTS "account_security_event" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "userSessionId" TEXT,
    "action" TEXT NOT NULL,
    "detailsJson" JSONB NOT NULL DEFAULT '{}',
    "requestId" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_security_event_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "account_security_event_userId_createdAt_idx"
  ON "account_security_event"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "account_security_event_action_createdAt_idx"
  ON "account_security_event"("action", "createdAt");

CREATE OR REPLACE FUNCTION account_security_event_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION
    'account_security_event is APPEND-ONLY: % is not permitted. It is the record of who enrolled, stepped up or spent a recovery code; a record that can be edited is not evidence.',
    TG_OP
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS account_security_event_append_only_trg ON "account_security_event";
CREATE TRIGGER account_security_event_append_only_trg
  BEFORE UPDATE OR DELETE ON "account_security_event"
  FOR EACH ROW EXECUTE FUNCTION account_security_event_append_only();

-- ── 5. RLS: both new tables deny app_user outright ──────────────────────
--
-- Same shape as platform_admin_grant (P31): an explicit USING (false), and a
-- companion policy named literally `superuser_bypass`, the one name
-- rls-policy-shape exempts from the trivially-permissive rule. Every reader
-- and writer is src/lib/auth/mfa.ts, through runAsSuperuser.
ALTER TABLE "mfa_recovery_code" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mfa_recovery_code" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS mfa_recovery_code_deny_all ON "mfa_recovery_code";
CREATE POLICY mfa_recovery_code_deny_all ON "mfa_recovery_code"
  USING (false)
  WITH CHECK (false);

DROP POLICY IF EXISTS superuser_bypass ON "mfa_recovery_code";
CREATE POLICY superuser_bypass ON "mfa_recovery_code"
  TO app_superuser
  USING (true)
  WITH CHECK (true);

ALTER TABLE "account_security_event" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "account_security_event" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS account_security_event_deny_all ON "account_security_event";
CREATE POLICY account_security_event_deny_all ON "account_security_event"
  USING (false)
  WITH CHECK (false);

DROP POLICY IF EXISTS superuser_bypass ON "account_security_event";
CREATE POLICY superuser_bypass ON "account_security_event"
  TO app_superuser
  USING (true)
  WITH CHECK (true);

-- ── 6. Privileges ───────────────────────────────────────────────────────
--
-- P03's default privileges hand app_user all four verbs on every new table.
-- The policies above are what stop it; revoking as well means a future policy
-- change cannot inherit a privilege nothing ever needed (P31's reasoning).
GRANT SELECT, INSERT, UPDATE, DELETE ON "mfa_recovery_code" TO app_superuser;
GRANT SELECT, INSERT ON "account_security_event" TO app_superuser;
REVOKE ALL ON "mfa_recovery_code" FROM app_user;
REVOKE ALL ON "account_security_event" FROM app_user;
