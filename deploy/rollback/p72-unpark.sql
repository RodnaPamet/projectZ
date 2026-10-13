-- ROLLING FORWARD AGAIN: give back what p72-park.sql parked.
--
-- Run with the P72 image (or a later one) serving, never before: until then
-- the rows are unreadable to the running code, which is why they were parked.
--
-- In one transaction: the grants get COACH_APPROVE back exactly as they held
-- it (a grant that was removed is restored whole; one that was narrowed gets
-- its capabilities back), the audit rows return to platform_audit_entry, the
-- notifications and queued emails return, and the park tables are dropped.
--
-- A grant that was REVOKED while parked stays revoked: the revocation is kept
-- and only the capabilities it held are restored, as history.
--
-- The same two triggers as the park (grant immutability, audit append-only),
-- and the audit attribution trigger, are off for this transaction only.
--
-- Safe to run twice: with no park tables it does nothing.
--
--   docker exec -i playerz-db psql -U playerz -d playerz_production -v ON_ERROR_STOP=1 \
--     < /opt/playerz/repo/deploy/rollback/p72-unpark.sql

BEGIN;

CREATE TABLE IF NOT EXISTS "p72_parked_notification" (LIKE "notification");
ALTER TABLE "p72_parked_notification" ALTER COLUMN "kind" TYPE TEXT;
CREATE TABLE IF NOT EXISTS "p72_parked_email_outbox" (LIKE "email_outbox");
ALTER TABLE "p72_parked_email_outbox" ALTER COLUMN "kind" TYPE TEXT;
CREATE TABLE IF NOT EXISTS "p72_parked_platform_admin_grant" (LIKE "platform_admin_grant");
ALTER TABLE "p72_parked_platform_admin_grant" ALTER COLUMN "capabilities" TYPE TEXT[];
CREATE TABLE IF NOT EXISTS "p72_parked_platform_audit_entry" (LIKE "platform_audit_entry");
ALTER TABLE "p72_parked_platform_audit_entry" ALTER COLUMN "capability" TYPE TEXT;

-- ─── The bell and the outbox ───────────────────────────────────────────────
--
-- Column by column, in the tables' own order, through a cast: the park tables
-- hold the kind as text.
DO $$
DECLARE
  t text;
  cols text;
  vals text;
BEGIN
  FOREACH t IN ARRAY ARRAY['notification', 'email_outbox'] LOOP
    SELECT string_agg(format('%I', column_name), ', ' ORDER BY ordinal_position),
           string_agg(
             CASE WHEN column_name = 'kind'
                  THEN format('%I::"NotificationKind"', column_name)
                  ELSE format('%I', column_name) END,
             ', ' ORDER BY ordinal_position)
    INTO cols, vals
    FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = t;
    EXECUTE format('INSERT INTO %I (%s) SELECT %s FROM %I ON CONFLICT DO NOTHING',
      t, cols, vals, 'p72_parked_' || t);
  END LOOP;
END $$;

-- ─── The grants ────────────────────────────────────────────────────────────

ALTER TABLE "platform_admin_grant" DISABLE TRIGGER platform_admin_grant_immutable_trg;

-- Narrowed by the park: the capabilities it held come back. Nothing else on
-- the row is touched, so a revocation made meanwhile stands.
UPDATE "platform_admin_grant" g
SET "capabilities" = p."capabilities"::"PlatformCapability"[]
FROM "p72_parked_platform_admin_grant" p
WHERE g."id" = p."id";

-- Removed by the park (it carried COACH_APPROVE and nothing else): back whole.
-- If its holder was given another live grant meanwhile, the one-live-grant
-- index refuses this and the whole unpark stops, which is right: revoke one
-- of the two first.
DO $$
DECLARE
  cols text;
  vals text;
BEGIN
  SELECT string_agg(format('%I', column_name), ', ' ORDER BY ordinal_position),
         string_agg(
           CASE WHEN column_name = 'capabilities'
                THEN format('%I::"PlatformCapability"[]', column_name)
                ELSE format('%I', column_name) END,
           ', ' ORDER BY ordinal_position)
  INTO cols, vals
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'platform_admin_grant';
  EXECUTE format(
    'INSERT INTO "platform_admin_grant" (%s) SELECT %s FROM "p72_parked_platform_admin_grant" p
       WHERE NOT EXISTS (SELECT 1 FROM "platform_admin_grant" g WHERE g."id" = p."id")',
    cols, vals);
END $$;

ALTER TABLE "platform_admin_grant" ENABLE TRIGGER platform_admin_grant_immutable_trg;

-- ─── The audit trail ───────────────────────────────────────────────────────

ALTER TABLE "platform_audit_entry" DISABLE TRIGGER platform_audit_attribution_trg;

DO $$
DECLARE
  cols text;
  vals text;
BEGIN
  SELECT string_agg(format('%I', column_name), ', ' ORDER BY ordinal_position),
         string_agg(
           CASE WHEN column_name = 'capability'
                THEN format('%I::"PlatformCapability"', column_name)
                ELSE format('%I', column_name) END,
           ', ' ORDER BY ordinal_position)
  INTO cols, vals
  FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'platform_audit_entry';
  EXECUTE format(
    'INSERT INTO "platform_audit_entry" (%s) SELECT %s FROM "p72_parked_platform_audit_entry"
       ON CONFLICT DO NOTHING',
    cols, vals);
END $$;

ALTER TABLE "platform_audit_entry" ENABLE TRIGGER platform_audit_attribution_trg;

DO $$
DECLARE
  n bigint;
BEGIN
  SELECT count(*) INTO n FROM pg_trigger
  WHERE tgname IN ('platform_admin_grant_immutable_trg', 'platform_audit_append_only_trg',
                   'platform_audit_attribution_trg')
    AND tgenabled = 'O';
  IF n <> 3 THEN
    RAISE EXCEPTION 'p72 unpark: the grant and audit triggers are not all enabled (% of 3). Nothing was restored.', n;
  END IF;
END $$;

DROP TABLE "p72_parked_notification";
DROP TABLE "p72_parked_email_outbox";
DROP TABLE "p72_parked_platform_admin_grant";
DROP TABLE "p72_parked_platform_audit_entry";

COMMIT;
