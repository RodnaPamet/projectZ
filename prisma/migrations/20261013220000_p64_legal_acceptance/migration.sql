-- P64 (#462): which version of the terms and the privacy policy a person
-- accepted, and when.
--
-- Until now the first-sign-in screen said "Продължавайки, приемате Общите
-- условия и Политиката за поверителност" and recorded nothing: nobody could
-- say later which text a person had agreed to. One row per person, text and
-- version; the versions are content/legal-versions.json. A new version asks
-- signed-in people once (owner decision 2026-10-13), and their answer is a
-- new row here.
--
-- No IP address and no user agent: the account, the text, its version, the
-- language it was read in and the moment are what the record needs.
--
-- Rollback: the previous image neither reads nor writes this table.
SET lock_timeout = '5s';

CREATE TABLE "legal_acceptance" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "document" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "acceptedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "legal_acceptance_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "legal_acceptance_userId_document_version_key"
  ON "legal_acceptance"("userId", "document", "version");

ALTER TABLE "legal_acceptance" ADD CONSTRAINT "legal_acceptance_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "app_user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The database's own idea of what can be accepted, so a write that skipped
-- the use case still cannot store a third kind of text or an empty version.
ALTER TABLE "legal_acceptance" ADD CONSTRAINT legal_acceptance_document
  CHECK ("document" IN ('terms', 'privacy'));
ALTER TABLE "legal_acceptance" ADD CONSTRAINT legal_acceptance_version
  CHECK ("version" ~ '^[0-9A-Za-z][0-9A-Za-z._-]{0,31}$');

-- ─── RLS ─────────────────────────────────────────────────────────────
--
-- Owner-only, keyed on app.user_id, as player_sport_level (P43): bound to a
-- person, a query reads that person's rows and may ADD one for them, which is
-- how the acceptance is recorded (runAsUserOnly, no BYPASSRLS). No UPDATE and
-- no DELETE for app_user: a recorded acceptance is not edited or withdrawn
-- through the app.
ALTER TABLE "legal_acceptance" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "legal_acceptance" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS legal_acceptance_owner_only ON "legal_acceptance";
CREATE POLICY legal_acceptance_owner_only ON "legal_acceptance"
  USING ("userId" = current_setting('app.user_id', true))
  WITH CHECK ("userId" = current_setting('app.user_id', true));

DROP POLICY IF EXISTS superuser_bypass ON "legal_acceptance";
CREATE POLICY superuser_bypass ON "legal_acceptance" TO app_superuser
  USING (true) WITH CHECK (true);

REVOKE ALL ON "legal_acceptance" FROM app_user;
GRANT SELECT, INSERT ON "legal_acceptance" TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON "legal_acceptance" TO app_superuser;

-- A deleted account accepts nothing (P52's rule for every table that names
-- an account): the same lock against the deletion's FOR UPDATE.
DROP TRIGGER IF EXISTS legal_acceptance_account_not_deleted_trg ON "legal_acceptance";
CREATE TRIGGER legal_acceptance_account_not_deleted_trg
  BEFORE INSERT OR UPDATE OF "userId" ON "legal_acceptance"
  FOR EACH ROW EXECUTE FUNCTION account_not_deleted('userId');
