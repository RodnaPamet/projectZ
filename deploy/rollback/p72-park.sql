-- ROLLING BACK PAST P72: park every row the previous image cannot read.
--
-- P72 (#545, the owner's approval of a coach) added four enum values:
--
--   PlatformCapability   COACH_APPROVE
--   NotificationKind     COACH_PROFILE_SUBMITTED, COACH_PROFILE_APPROVED,
--                        COACH_PROFILE_DECLINED
--
-- An image built before P72 was generated without them, and Prisma 7 REFUSES
-- a whole query that reads one:
--
--     PrismaClientKnownRequestError: Value 'COACH_APPROVE' not found in enum 'PlatformCapability'
--
-- The shell reads the signed-in person's live grant on every page, so a grant
-- that carries COACH_APPROVE would lock its holder out of the previous image
-- altogether; the bell reads a person's notifications on every page. Run this
-- BEFORE starting the previous image, and `p72-unpark.sql` after rolling
-- forward again (docs/deploy-gcp.md, "Rolling back past p72").
--
-- What it does, in one transaction:
--
--   notification, email_outbox   every row of a COACH_PROFILE_ kind is copied
--                                to a park table and removed
--   platform_admin_grant         every grant that carries COACH_APPROVE is
--                                copied whole to a park table. One that carries
--                                other capabilities too keeps those, and its
--                                holder keeps working. One that carries nothing
--                                else is removed until the unpark: it grants
--                                nothing the previous image knows.
--   platform_audit_entry         every row written under COACH_APPROVE is
--                                copied to a park table and removed. THE ROWS
--                                ARE NOT LOST: they sit in
--                                p72_parked_platform_audit_entry, whole, until
--                                the unpark puts them back.
--
-- The grant and the audit trail are immutable by trigger (P31), for everyone
-- including the table's owner. This script switches those two triggers off for
-- its own transaction and back on before it commits; nothing else runs with
-- them off, because ALTER TABLE holds the table until the commit.
--
-- Then every column of either enum, found from the catalogue, is checked; if
-- any still holds one of the four values, the transaction is rolled back.
--
-- Safe to run twice. Run as the database owner:
--
--   docker exec -i playerz-db psql -U playerz -d playerz_production -v ON_ERROR_STOP=1 \
--     < /opt/playerz/repo/deploy/rollback/p72-park.sql

BEGIN;

-- ─── The bell and the outbox ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "p72_parked_notification" (LIKE "notification");
ALTER TABLE "p72_parked_notification" ALTER COLUMN "kind" TYPE TEXT;
CREATE TABLE IF NOT EXISTS "p72_parked_email_outbox" (LIKE "email_outbox");
ALTER TABLE "p72_parked_email_outbox" ALTER COLUMN "kind" TYPE TEXT;

INSERT INTO "p72_parked_notification"
SELECT * FROM "notification" WHERE "kind"::text LIKE 'COACH\_PROFILE\_%';
DELETE FROM "notification" WHERE "kind"::text LIKE 'COACH\_PROFILE\_%';

INSERT INTO "p72_parked_email_outbox"
SELECT * FROM "email_outbox" WHERE "kind"::text LIKE 'COACH\_PROFILE\_%';
DELETE FROM "email_outbox" WHERE "kind"::text LIKE 'COACH\_PROFILE\_%';

-- ─── The grants ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "p72_parked_platform_admin_grant" (LIKE "platform_admin_grant");
ALTER TABLE "p72_parked_platform_admin_grant" ALTER COLUMN "capabilities" TYPE TEXT[];
CREATE UNIQUE INDEX IF NOT EXISTS "p72_parked_platform_admin_grant_id"
  ON "p72_parked_platform_admin_grant"("id");

ALTER TABLE "platform_admin_grant" DISABLE TRIGGER platform_admin_grant_immutable_trg;

-- The grant as it was, once: a second run must not overwrite it with the
-- narrowed one.
INSERT INTO "p72_parked_platform_admin_grant"
SELECT * FROM "platform_admin_grant" WHERE 'COACH_APPROVE' = ANY ("capabilities"::text[])
ON CONFLICT ("id") DO NOTHING;

DELETE FROM "platform_admin_grant"
WHERE "capabilities"::text[] = ARRAY['COACH_APPROVE'];

UPDATE "platform_admin_grant"
SET "capabilities" = array_remove("capabilities"::text[], 'COACH_APPROVE')::"PlatformCapability"[]
WHERE 'COACH_APPROVE' = ANY ("capabilities"::text[]);

ALTER TABLE "platform_admin_grant" ENABLE TRIGGER platform_admin_grant_immutable_trg;

-- ─── The audit trail ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS "p72_parked_platform_audit_entry" (LIKE "platform_audit_entry");
ALTER TABLE "p72_parked_platform_audit_entry" ALTER COLUMN "capability" TYPE TEXT;

ALTER TABLE "platform_audit_entry" DISABLE TRIGGER platform_audit_append_only_trg;

INSERT INTO "p72_parked_platform_audit_entry"
SELECT * FROM "platform_audit_entry" WHERE "capability"::text = 'COACH_APPROVE';
DELETE FROM "platform_audit_entry" WHERE "capability"::text = 'COACH_APPROVE';

ALTER TABLE "platform_audit_entry" ENABLE TRIGGER platform_audit_append_only_trg;

-- ─── Nothing of the four is left where the previous image reads ────────────

DO $$
DECLARE
  col record;
  n bigint;
BEGIN
  FOR col IN
    SELECT c.table_name, c.column_name, c.udt_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public'
      AND t.table_type = 'BASE TABLE'
      AND c.udt_name IN ('NotificationKind', 'PlatformCapability', '_PlatformCapability')
  LOOP
    IF col.udt_name = 'NotificationKind' THEN
      EXECUTE format('SELECT count(*) FROM %I WHERE %I::text LIKE ''COACH\_PROFILE\_%%''',
        col.table_name, col.column_name) INTO n;
    ELSIF col.udt_name = 'PlatformCapability' THEN
      EXECUTE format('SELECT count(*) FROM %I WHERE %I::text = ''COACH_APPROVE''',
        col.table_name, col.column_name) INTO n;
    ELSE
      EXECUTE format('SELECT count(*) FROM %I WHERE ''COACH_APPROVE'' = ANY (%I::text[])',
        col.table_name, col.column_name) INTO n;
    END IF;
    IF n > 0 THEN
      RAISE EXCEPTION
        'p72 park: %.% still holds % row(s) of a value P72 added, which the previous image cannot read. Nothing was parked.',
        col.table_name, col.column_name, n;
    END IF;
  END LOOP;

  -- Both triggers are back on. A park that left the audit trail editable
  -- would be worse than no park.
  SELECT count(*) INTO n FROM pg_trigger
  WHERE tgname IN ('platform_admin_grant_immutable_trg', 'platform_audit_append_only_trg')
    AND tgenabled = 'O';
  IF n <> 2 THEN
    RAISE EXCEPTION 'p72 park: the grant and audit triggers are not both enabled (% of 2). Nothing was parked.', n;
  END IF;
END $$;

COMMIT;
